import {createHash} from 'node:crypto';

import {unzipSync} from 'fflate';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import FAANasrCycleSourceError from '#radial/data-producer/internal/FAANasrCycleSourceError.js';
import faaNasrFacilityVariation from '#radial/data-producer/internal/FAANasrFacilityVariation.js';

type FAANasrCycleArtifact = Parameters<
  typeof faaNasrFacilityVariation.selectApplicableCycle
>[0][number];
type DownloadedArchive = Readonly<{
  archiveBytes: Uint8Array;
  lastModified: string | null;
}>;
type ArchiveResponse = Readonly<{
  status: number;
  retryAfter: string | null;
  downloadedArchive?: DownloadedArchive;
}>;

const AIRAC_ANCHOR = Date.UTC(2025, 0, 23);
const AIRAC_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CSV_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const MAX_ELAPSED_MS = 5 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function acquireProductionFAANasrCycle(
  retrievalStartedAt: string,
  signal?: AbortSignal
): Promise<readonly FAANasrCycleArtifact[]> {
  abortableOperation.throwIfAborted(signal);
  const effectiveDate = applicableEffectiveDate(retrievalStartedAt);
  const archiveIdentity = `${formatArchiveDate(effectiveDate)}_NAV_CSV.zip`;
  const sourceUrl = `https://nfdc.faa.gov/webContent/28DaySub/extra/${archiveIdentity}`;
  const downloadedArchive = await fetchArchive(sourceUrl, signal);
  abortableOperation.throwIfAborted(signal);

  try {
    return await buildCycleArtifact(
      downloadedArchive,
      effectiveDate,
      archiveIdentity,
      sourceUrl
    );
  } catch (error) {
    if (error instanceof FAANasrCycleSourceError) {
      throw error;
    }
    throw new FAANasrCycleSourceError(
      'invalid-response',
      'FAA NASR archive response is invalid.'
    );
  }
}

async function buildCycleArtifact(
  downloadedArchive: DownloadedArchive,
  effectiveDate: string,
  archiveIdentity: string,
  sourceUrl: string
): Promise<readonly FAANasrCycleArtifact[]> {
  const {archiveBytes, lastModified} = downloadedArchive;
  const publishedAt = lastModified === null ? Number.NaN : Date.parse(lastModified);
  if (!Number.isFinite(publishedAt)) {
    throw new Error('FAA NASR archive publication time is unavailable.');
  }

  const files = unzipSync(archiveBytes, {
    filter(file) {
      return file.name === 'NAV_BASE.csv' && file.originalSize <= MAX_CSV_BYTES;
    },
  });
  const csvBytes = files['NAV_BASE.csv'];
  if (
    csvBytes === undefined ||
    csvBytes.byteLength === 0 ||
    csvBytes.byteLength > MAX_CSV_BYTES
  ) {
    throw new Error('FAA NASR archive does not contain a valid NAV_BASE.csv.');
  }
  const csvText = new TextDecoder('utf-8', {fatal: true}).decode(csvBytes);
  const records = parseCsvRecords(csvText, effectiveDate);
  const retrievedAt = new Date().toISOString();

  return [
    {
      archiveBytes,
      archiveChecksum: checksumBytes(archiveBytes),
      archiveIdentity,
      contentChecksum: checksumText(
        canonicalizeJson(
          records
            .map(record => canonicalizeJson(record))
            .toSorted()
            .map(record => JSON.parse(record) as Readonly<Record<string, unknown>>)
        )
      ),
      cycleId: airacCycleId(effectiveDate),
      effectiveDate,
      publishedAt: new Date(publishedAt).toISOString(),
      records,
      retrievedAt,
      sourceUrl,
    },
  ];
}

async function fetchArchive(
  sourceUrl: string,
  signal?: AbortSignal
): Promise<DownloadedArchive> {
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    abortableOperation.throwIfAborted(signal);
    let response: ArchiveResponse;
    try {
      response = await requestArchive(sourceUrl, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw abortableOperation.abortError(signal);
      }
      if (abortableOperation.isAbortError(error)) {
        throw error;
      }
      if (error instanceof FAANasrCycleSourceError) {
        throw error;
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new FAANasrCycleSourceError(
          'unavailable',
          'FAA NASR archive is unavailable.'
        );
      }
      await waitBeforeRetry(attempt, undefined, startedAt, signal);
      continue;
    }
    if (response.downloadedArchive !== undefined) {
      return response.downloadedArchive;
    }
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      throw new FAANasrCycleSourceError(
        'unavailable',
        'FAA NASR archive is unavailable.'
      );
    }
    await waitBeforeRetry(attempt, response.retryAfter, startedAt, signal);
  }
  throw new FAANasrCycleSourceError('unavailable', 'FAA NASR archive is unavailable.');
}

async function requestArchive(
  sourceUrl: string,
  signal?: AbortSignal
): Promise<ArchiveResponse> {
  const controller = new AbortController();
  const connectionTimer = setTimeout(() => controller.abort(), 10_000);
  const requestTimer = setTimeout(() => controller.abort(), 60_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const response = await fetch(sourceUrl, {
      headers: {accept: 'application/zip'},
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(connectionTimer);
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      };
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new FAANasrCycleSourceError(
        'invalid-response',
        'FAA NASR archive has an invalid size.'
      );
    }
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new FAANasrCycleSourceError(
        'invalid-response',
        'FAA NASR archive has an invalid size.'
      );
    }
    return {
      status: response.status,
      retryAfter: null,
      downloadedArchive: {
        archiveBytes,
        lastModified: response.headers.get('last-modified'),
      },
    };
  } finally {
    clearTimeout(connectionTimer);
    clearTimeout(requestTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function waitBeforeRetry(
  failedAttempt: number,
  retryAfter: string | null | undefined,
  startedAt: number,
  signal?: AbortSignal
): Promise<void> {
  abortableOperation.throwIfAborted(signal);
  const retryAfterMs = parseRetryAfter(retryAfter);
  const jitterCeilingMs = Math.min(30_000, 1000 * 2 ** (failedAttempt - 1));
  const delayMs = retryAfterMs ?? Math.floor(Math.random() * jitterCeilingMs);
  if (Date.now() - startedAt + delayMs > MAX_ELAPSED_MS) {
    throw new Error('FAA NASR acquisition exceeded its elapsed-time ceiling.');
  }
  await abortableOperation.sleep(delayMs, signal);
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  const milliseconds =
    seconds === undefined ? Date.parse(value) - Date.now() : seconds * 1000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 120_000
    ? milliseconds
    : undefined;
}

function applicableEffectiveDate(retrievalStartedAt: string): string {
  const retrievalTime = Date.parse(retrievalStartedAt);
  if (!Number.isFinite(retrievalTime)) {
    throw new Error('FAA NASR retrieval start must be a valid timestamp.');
  }
  const cycleOffset = Math.floor((retrievalTime - AIRAC_ANCHOR) / AIRAC_INTERVAL_MS);
  return new Date(AIRAC_ANCHOR + cycleOffset * AIRAC_INTERVAL_MS)
    .toISOString()
    .slice(0, 10);
}

function airacCycleId(effectiveDate: string): string {
  const effectiveTime = Date.parse(`${effectiveDate}T00:00:00.000Z`);
  const year = new Date(effectiveTime).getUTCFullYear();
  let firstCycleTime = AIRAC_ANCHOR;
  while (new Date(firstCycleTime).getUTCFullYear() < year) {
    firstCycleTime += AIRAC_INTERVAL_MS;
  }
  while (new Date(firstCycleTime - AIRAC_INTERVAL_MS).getUTCFullYear() === year) {
    firstCycleTime -= AIRAC_INTERVAL_MS;
  }
  const cycleNumber =
    Math.round((effectiveTime - firstCycleTime) / AIRAC_INTERVAL_MS) + 1;
  return `${String(year).slice(2)}${String(cycleNumber).padStart(2, '0')}`;
}

function formatArchiveDate(effectiveDate: string): string {
  const date = new Date(`${effectiveDate}T00:00:00.000Z`);
  const month = date.toLocaleString('en-US', {month: 'short', timeZone: 'UTC'});
  return `${String(date.getUTCDate()).padStart(2, '0')}_${month}_${date.getUTCFullYear()}`;
}

function parseCsvRecords(
  csvText: string,
  expectedEffectiveDate: string
): readonly Readonly<Record<string, unknown>>[] {
  const rows = parseCsv(csvText);
  const headers = rows.shift();
  if (
    headers === undefined ||
    headers.length === 0 ||
    new Set(headers).size !== headers.length
  ) {
    throw new Error('FAA NASR NAV_BASE.csv has invalid headers.');
  }
  return rows.map((row, index) => {
    if (row.length !== headers.length) {
      throw new Error(`FAA NASR NAV_BASE.csv row ${index + 1} has an invalid shape.`);
    }
    const record = Object.fromEntries(
      headers.map((header, column) => [header, row[column]])
    );
    record['EFF_DATE'] = String(record['EFF_DATE']).replaceAll('/', '-');
    if (record['EFF_DATE'] !== expectedEffectiveDate) {
      throw new Error(`FAA NASR NAV_BASE.csv row ${index + 1} has an invalid cycle.`);
    }
    return Object.freeze(record);
  });
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]!;
    if (quoted) {
      if (character === '"' && csvText[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new Error('FAA NASR NAV_BASE.csv contains an unterminated quoted field.');
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function checksumBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function checksumText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export default acquireProductionFAANasrCycle;
