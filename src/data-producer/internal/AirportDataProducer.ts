import {createHash} from 'node:crypto';

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';
import * as Sentry from '@sentry/node';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';
import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

type AirportPageRequest = Readonly<{
  search: string;
  page: number;
  limit: number;
  signal?: AbortSignal;
}>;

type AirportPage = Readonly<{
  page: number;
  totalPages: number;
  items: readonly unknown[];
}>;

type AirportDataProducerDependencies = Readonly<{
  listOpenAIPAirports?: (
    request: AirportPageRequest
  ) => Promise<AirportPage> | AirportPage;
  now?: () => Date;
  beforeAirportCommit?: () => void | Promise<void>;
}>;

type AirportResolutionFailure = Readonly<{
  reason:
    | 'cache-corrupt'
    | 'credentials-missing'
    | 'database-query'
    | 'mismatched'
    | 'not-found'
    | 'ambiguous'
    | 'unusable'
    | 'source-invalid'
    | 'source-unavailable'
    | 'publication-failed';
}>;

type AirportResolutionResult =
  | Readonly<{ok: true}>
  | Readonly<{ok: false; failure: AirportResolutionFailure}>;

type AirportReloadRequest = RadialApplicationTypes['AirportReloadRequest'];
type AirportReloadResult = RadialApplicationTypes['AirportReloadResult'];

type AirportRecord = Readonly<{
  sourceId: string;
  icao: string;
  name: string;
  longitude: number;
  latitude: number;
  canonicalRecord: string;
  recordChecksum: string;
}>;

type AirportCacheRead =
  | Readonly<{kind: 'missing'}>
  | Readonly<{kind: 'present'; airport: AirportRecord}>
  | Readonly<{kind: 'corrupt'}>
  | Readonly<{kind: 'database-error'}>;

type AirportAcquisitionProgress = Readonly<{
  stage: 'openaip' | 'derive';
  message: string;
}>;

type AirportAcquisitionResult =
  | Readonly<{
      ok: true;
      airport: AirportRecord;
      retrievedAt: string;
      publishedAt: string;
    }>
  | Readonly<{ok: false; failure: AirportResolutionFailure}>;

const AIRPORT_PAGE_LIMIT = 1000;
const ICAO_PATTERN = /^[A-Z]{4}$/;

async function reloadAirport(
  instance: DuckDBInstance,
  request: AirportReloadRequest,
  publicationGate: PublicationGate,
  dependencies: AirportDataProducerDependencies = {}
): Promise<AirportReloadResult> {
  const normalizedIcao = normalizeIcao(request.icao);
  if (!ICAO_PATTERN.test(normalizedIcao)) {
    return failure(
      'DATA_INVALID_ICAO',
      'The Airport ICAO is invalid.',
      `The requested Airport ICAO ${JSON.stringify(request.icao)} is not four ASCII letters.`,
      'Provide exactly one four-letter ICAO and retry the Airport reload.'
    );
  }

  abortableOperation.throwIfAborted(request.signal);
  if (request.openAipApiKey.trim() === '') {
    return failure(
      'DATA_CREDENTIALS_MISSING',
      'OpenAIP credentials are missing.',
      'OPENAIP_API_KEY is required for an explicit Airport reload.',
      'Set OPENAIP_API_KEY and retry the Airport reload.'
    );
  }

  request.onProgress?.({stage: 'database', message: 'Preparing Producer Schema.'});
  try {
    await Sentry.startSpan(
      {
        name: 'Prepare Producer Schema',
        op: 'db.query',
        attributes: {
          'db.operation.name': 'initialize',
          'db.query.summary': 'producer schema',
          'db.system.name': 'duckdb',
        },
      },
      () => publicationGate.run(() => initializeProducerSchema(instance), request.signal)
    );
    abortableOperation.throwIfAborted(request.signal);
  } catch {
    if (request.signal?.aborted) {
      throw abortableOperation.abortError(request.signal);
    }

    return failure(
      'DATA_DATABASE_INVALID',
      'The configured database is invalid.',
      'The Producer Schema could not be prepared safely.',
      'Inspect the configured database and retry with a valid Radial database.'
    );
  }

  const cached = await readCachedAirport(instance, normalizedIcao);
  logAirportCacheRead(normalizedIcao, cached);
  abortableOperation.throwIfAborted(request.signal);
  if (cached.kind === 'database-error') {
    return failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'The existing Cached Airport could not be inspected.',
      'Check database availability and retry the Airport reload.'
    );
  }

  const acquired = await acquireAirportRecord(
    request.openAipApiKey,
    normalizedIcao,
    dependencies,
    progress => request.onProgress?.(progress),
    request.signal
  );
  if (!acquired.ok) {
    return mapAirportReloadFailure(acquired.failure);
  }

  request.onProgress?.({stage: 'publish', message: 'Publishing Cached Airport.'});
  try {
    await publishAirport(
      instance,
      acquired.airport,
      acquired.retrievedAt,
      acquired.publishedAt,
      publicationGate,
      dependencies.beforeAirportCommit,
      request.signal
    );
  } catch (error) {
    if (
      request.signal?.aborted &&
      (!(error instanceof AirportPublicationError) || error.activeDataPreserved)
    ) {
      throw abortableOperation.abortError(request.signal);
    }

    return failure(
      'DATA_PUBLICATION_FAILED',
      'Cached Airport publication failed.',
      'The Cached Airport could not be committed.',
      'Inspect database availability and retry the Airport reload.',
      error instanceof AirportPublicationError ? error.activeDataPreserved : true
    );
  }

  request.onProgress?.({stage: 'complete', message: 'Cached Airport committed.'});
  return {
    ok: true,
    value: {
      status: cached.kind === 'missing' ? 'cached' : 'replaced',
      icao: normalizedIcao,
      sourceId: acquired.airport.sourceId,
      retrievedAt: acquired.retrievedAt,
    },
  };
}

async function ensureCachedAirport(
  instance: DuckDBInstance,
  normalizedIcao: string,
  openAipApiKey: string,
  publicationGate: PublicationGate,
  dependencies: AirportDataProducerDependencies = {}
): Promise<AirportResolutionResult> {
  return Sentry.startSpan(
    {
      name: 'Ensure Airport data',
      op: 'task',
      attributes: {'radial.airport.icao': normalizedIcao},
    },
    () =>
      ensureCachedAirportWithinSpan(
        instance,
        normalizedIcao,
        openAipApiKey,
        publicationGate,
        dependencies
      )
  );
}

async function ensureCachedAirportWithinSpan(
  instance: DuckDBInstance,
  normalizedIcao: string,
  openAipApiKey: string,
  publicationGate: PublicationGate,
  dependencies: AirportDataProducerDependencies = {}
): Promise<AirportResolutionResult> {
  const cached = await readCachedAirport(instance, normalizedIcao);
  logAirportCacheRead(normalizedIcao, cached);
  if (cached.kind === 'present' || cached.kind === 'missing') {
    if (cached.kind === 'present') {
      return {ok: true};
    }
  } else if (cached.kind === 'corrupt') {
    return {ok: false, failure: {reason: 'cache-corrupt'}};
  } else {
    return {ok: false, failure: {reason: 'database-query'}};
  }

  if (openAipApiKey.trim() === '') {
    return {ok: false, failure: {reason: 'credentials-missing'}};
  }

  const acquired = await acquireAirportRecord(
    openAipApiKey,
    normalizedIcao,
    dependencies
  );
  if (!acquired.ok) {
    return acquired;
  }

  try {
    await publishAirport(
      instance,
      acquired.airport,
      acquired.retrievedAt,
      acquired.publishedAt,
      publicationGate,
      dependencies.beforeAirportCommit
    );
  } catch {
    return {ok: false, failure: {reason: 'publication-failed'}};
  }

  return {ok: true};
}

async function acquireAirportRecord(
  apiKey: string,
  normalizedIcao: string,
  dependencies: AirportDataProducerDependencies,
  reportProgress?: (progress: AirportAcquisitionProgress) => void,
  signal?: AbortSignal
): Promise<AirportAcquisitionResult> {
  return Sentry.startSpan(
    {
      name: 'Acquire OpenAIP Airport',
      op: 'task',
      attributes: {'radial.airport.icao': normalizedIcao},
    },
    () =>
      acquireAirportRecordWithinSpan(
        apiKey,
        normalizedIcao,
        dependencies,
        reportProgress,
        signal
      )
  );
}

async function acquireAirportRecordWithinSpan(
  apiKey: string,
  normalizedIcao: string,
  dependencies: AirportDataProducerDependencies,
  reportProgress?: (progress: AirportAcquisitionProgress) => void,
  signal?: AbortSignal
): Promise<AirportAcquisitionResult> {
  abortableOperation.throwIfAborted(signal);
  reportProgress?.({
    stage: 'openaip',
    message: `Looking up Airport ${normalizedIcao} in OpenAIP.`,
  });
  const now = dependencies.now ?? (() => new Date());
  let retrievedAt: string;
  try {
    retrievedAt = now().toISOString();
  } catch {
    return {ok: false, failure: {reason: 'source-unavailable'}};
  }

  let records: readonly unknown[];
  Sentry.logger.info(
    Sentry.logger.fmt`OpenAIP Airport ${normalizedIcao} acquisition started`,
    {
      'radial.airport.icao': normalizedIcao,
      'radial.data.source': 'openaip',
    }
  );
  try {
    records = await fetchAirportRecords(
      apiKey,
      normalizedIcao,
      dependencies.listOpenAIPAirports,
      signal
    );
  } catch (error) {
    if (signal?.aborted) {
      throw abortableOperation.abortError(signal);
    }

    if (abortableOperation.isAbortError(error)) {
      throw error;
    }

    const reason =
      error instanceof AirportSourceInvalidError
        ? 'source-invalid'
        : 'source-unavailable';
    Sentry.logger.error(
      Sentry.logger.fmt`OpenAIP Airport ${normalizedIcao} acquisition failed`,
      {
        'radial.airport.icao': normalizedIcao,
        'radial.data.source': 'openaip',
        'radial.failure.reason': reason,
      }
    );
    return {
      ok: false,
      failure: {reason},
    };
  }

  Sentry.logger.info(
    Sentry.logger.fmt`OpenAIP Airport ${normalizedIcao} acquisition completed`,
    {
      'radial.airport.icao': normalizedIcao,
      'radial.airport.source_record_count': records.length,
      'radial.data.source': 'openaip',
    }
  );
  Sentry.metrics.distribution('radial.integration.records_acquired', records.length, {
    attributes: {record_type: 'airport', source: 'openaip'},
  });

  reportProgress?.({stage: 'derive', message: 'Validating exact Airport match.'});
  abortableOperation.throwIfAborted(signal);
  const selected = selectAirport(records, normalizedIcao);
  if (!selected.ok) {
    Sentry.logger.warn(
      Sentry.logger.fmt`OpenAIP Airport ${normalizedIcao} records were unusable`,
      {
        'radial.airport.icao': normalizedIcao,
        'radial.data.source': 'openaip',
        'radial.failure.reason': selected.failure.reason,
      }
    );
    return selected;
  }

  reportProgress?.({
    stage: 'derive',
    message: 'Deriving planner-ready Airport projection.',
  });
  abortableOperation.throwIfAborted(signal);
  let publishedAt: string;
  try {
    publishedAt = now().toISOString();
  } catch {
    return {ok: false, failure: {reason: 'publication-failed'}};
  }

  return {
    ok: true,
    airport: selected.airport,
    retrievedAt,
    publishedAt,
  };
}

async function readCachedAirport(
  instance: DuckDBInstance,
  normalizedIcao: string
): Promise<AirportCacheRead> {
  return Sentry.startSpan(
    {
      name: 'Read Airport cache',
      op: 'cache.get',
      attributes: {
        'cache.operation': 'read',
        'radial.airport.icao': normalizedIcao,
      },
    },
    async span => {
      const cached = await readCachedAirportWithinSpan(instance, normalizedIcao);
      if (cached.kind === 'present' || cached.kind === 'missing') {
        span.setAttribute('cache.hit', cached.kind === 'present');
      } else {
        span.setAttribute(
          'radial.failure.reason',
          cached.kind === 'corrupt' ? 'cache-corrupt' : 'database-query'
        );
      }

      return cached;
    }
  );
}

async function readCachedAirportWithinSpan(
  instance: DuckDBInstance,
  normalizedIcao: string
): Promise<AirportCacheRead> {
  let connection: DuckDBConnection;
  try {
    connection = await instance.connect();
  } catch {
    return {kind: 'database-error'};
  }

  try {
    let rows: readonly Record<string, unknown>[];
    try {
      const result = await connection.runAndReadAll(
        `SELECT
           icao,
           database_id,
           name,
           longitude,
           latitude,
           CAST(canonical_record AS VARCHAR) AS canonical_record,
           record_checksum,
           source_identity,
           CAST(retrieved_at AS VARCHAR) AS retrieved_at,
           CAST(published_at AS VARCHAR) AS published_at
         FROM radial_producer.cached_airports
         WHERE upper(trim(icao)) = ?`,
        [normalizedIcao]
      );
      rows = result.getRowObjectsJS();
    } catch {
      return {kind: 'database-error'};
    }

    if (rows.length === 0) {
      return {kind: 'missing'};
    }

    if (rows.length !== 1) {
      return {kind: 'corrupt'};
    }

    const airport = parseCachedAirport(rows[0], normalizedIcao);
    return airport === undefined ? {kind: 'corrupt'} : {kind: 'present', airport};
  } finally {
    connection.closeSync();
  }
}

async function fetchAirportRecords(
  apiKey: string,
  normalizedIcao: string,
  listOpenAIPAirports:
    | ((request: AirportPageRequest) => Promise<AirportPage> | AirportPage)
    | undefined,
  signal?: AbortSignal
): Promise<readonly unknown[]> {
  const listPage = listOpenAIPAirports ?? awaitableAirportPage(new OpenAIP(apiKey));

  const records: unknown[] = [];
  let totalPages: number | undefined;
  for (
    let pageNumber = 1;
    totalPages === undefined || pageNumber <= totalPages;
    pageNumber += 1
  ) {
    abortableOperation.throwIfAborted(signal);
    let page: unknown;
    try {
      page = await abortableOperation.awaitWithAbort(
        Promise.resolve(
          listPage({
            search: normalizedIcao,
            page: pageNumber,
            limit: AIRPORT_PAGE_LIMIT,
            ...(signal === undefined ? {} : {signal}),
          })
        ),
        signal
      );
    } catch (error) {
      if (signal?.aborted) {
        throw abortableOperation.abortError(signal);
      }

      if (abortableOperation.isAbortError(error)) {
        throw error;
      }

      if (error instanceof AirportSourceInvalidError) {
        throw error;
      }

      throw new AirportSourceUnavailableError({cause: error});
    }

    if (!validAirportPage(page, pageNumber)) {
      throw new AirportSourceInvalidError();
    }

    if (totalPages === undefined) {
      totalPages = page.totalPages;
    } else if (page.totalPages !== totalPages) {
      throw new AirportSourceInvalidError();
    }

    records.push(...page.items);
  }

  return records;
}

function awaitableAirportPage(
  client: OpenAIP
): (request: AirportPageRequest) => Promise<AirportPage> {
  return async (request: AirportPageRequest): Promise<AirportPage> => {
    const page = await client.airports(
      {
        page: request.page,
        limit: request.limit,
        search: request.search,
      },
      request.signal
    );
    return {
      page: page.page,
      totalPages: page.totalPages,
      items: page.items,
    };
  };
}

function validAirportPage(value: unknown, requestedPage: number): value is AirportPage {
  if (!isJsonObject(value)) {
    return false;
  }

  const page = value['page'];
  const totalPages = value['totalPages'];
  const items = value['items'];
  if (
    typeof page !== 'number' ||
    typeof totalPages !== 'number' ||
    !Array.isArray(items)
  ) {
    return false;
  }

  return (
    Number.isSafeInteger(page) &&
    page === requestedPage &&
    Number.isSafeInteger(totalPages) &&
    totalPages >= 0 &&
    (totalPages > 0 || items.length === 0)
  );
}

function selectAirport(
  records: readonly unknown[],
  normalizedIcao: string
):
  | Readonly<{ok: true; airport: AirportRecord}>
  | Readonly<{ok: false; failure: AirportResolutionFailure}> {
  const parsedRecords = records.map(parseAirportRecord);
  const matchingRecords = parsedRecords.filter(
    record => record.normalizedIcao === normalizedIcao
  );
  if (matchingRecords.length === 0) {
    return {
      ok: false,
      failure: {
        reason:
          records.length === 0
            ? 'not-found'
            : parsedRecords.some(record => record.normalizedIcao !== null)
              ? 'mismatched'
              : 'unusable',
      },
    };
  }

  const usableRecords = matchingRecords.flatMap(record =>
    record.airport === undefined ? [] : [record.airport]
  );
  if (usableRecords.length > 1) {
    return {ok: false, failure: {reason: 'ambiguous'}};
  }

  const airport = usableRecords[0];
  if (airport === undefined) {
    return {ok: false, failure: {reason: 'unusable'}};
  }

  return {ok: true, airport};
}

type ParsedAirportRecord = Readonly<{
  normalizedIcao: string | null;
  airport: AirportRecord | undefined;
}>;

function parseAirportRecord(value: unknown): ParsedAirportRecord {
  if (!isJsonObject(value)) {
    return {normalizedIcao: null, airport: undefined};
  }

  const normalizedIcao = normalizedIcaoValue(value['icaoCode']);
  if (normalizedIcao === null) {
    return {normalizedIcao: null, airport: undefined};
  }

  const sourceId = nonEmptyString(value['_id']);
  const name = nonEmptyString(value['name']);
  const geometry = parsePoint(value['geometry']);
  if (sourceId === null || name === null || geometry === undefined) {
    return {normalizedIcao, airport: undefined};
  }

  let canonicalRecord: string;
  try {
    canonicalRecord = canonicalizeJson(value);
  } catch {
    return {normalizedIcao, airport: undefined};
  }

  return {
    normalizedIcao,
    airport: {
      sourceId,
      icao: normalizedIcao,
      name,
      longitude: geometry.longitude,
      latitude: geometry.latitude,
      canonicalRecord,
      recordChecksum: checksum(canonicalRecord),
    },
  };
}

function parseCachedAirport(
  row: Record<string, unknown> | undefined,
  normalizedIcao: string
): AirportRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  const icao = typeof row['icao'] === 'string' ? row['icao'] : '';
  const sourceId = nonEmptyString(row['database_id']);
  const name = nonEmptyString(row['name']);
  const longitude = row['longitude'];
  const latitude = row['latitude'];
  const canonicalRecord = row['canonical_record'];
  const recordChecksum = row['record_checksum'];
  const sourceIdentity = row['source_identity'];
  const retrievedAt = row['retrieved_at'];
  const publishedAt = row['published_at'];
  if (
    normalizeIcao(icao) !== normalizedIcao ||
    sourceId === null ||
    name === null ||
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !validCoordinates(longitude, latitude) ||
    typeof canonicalRecord !== 'string' ||
    typeof recordChecksum !== 'string' ||
    recordChecksum !== checksum(canonicalRecord) ||
    typeof sourceIdentity !== 'string' ||
    sourceIdentity.trim() === '' ||
    sourceIdentity !== `openaip:airport:${sourceId}` ||
    typeof retrievedAt !== 'string' ||
    Number.isNaN(Date.parse(retrievedAt)) ||
    typeof publishedAt !== 'string' ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    return undefined;
  }

  let record: unknown;
  try {
    record = JSON.parse(canonicalRecord) as unknown;
    if (canonicalizeJson(record) !== canonicalRecord) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  if (!isJsonObject(record)) {
    return undefined;
  }

  const parsed = parseAirportRecord(record);
  if (
    parsed.airport === undefined ||
    parsed.airport.sourceId !== sourceId ||
    parsed.airport.icao !== normalizedIcao ||
    parsed.airport.name !== name ||
    parsed.airport.longitude !== longitude ||
    parsed.airport.latitude !== latitude ||
    parsed.airport.recordChecksum !== recordChecksum
  ) {
    return undefined;
  }

  return parsed.airport;
}

async function publishAirport(
  instance: DuckDBInstance,
  airport: AirportRecord,
  retrievedAt: string,
  publishedAt: string,
  publicationGate: PublicationGate,
  beforeCommit?: () => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  await Sentry.startSpan(
    {
      name: 'Publish Airport cache',
      op: 'cache.put',
      attributes: {
        'cache.operation': 'write',
        'radial.airport.icao': airport.icao,
      },
    },
    () =>
      publicationGate.run(
        () =>
          publishAirportWithinGate(
            instance,
            airport,
            retrievedAt,
            publishedAt,
            beforeCommit,
            signal
          ),
        signal
      )
  );
  Sentry.logger.info(Sentry.logger.fmt`Airport ${airport.icao} cached`, {
    'cache.operation': 'write',
    'cache.write': true,
    'radial.airport.icao': airport.icao,
  });
  Sentry.metrics.count('radial.product.airport_cache_write');
}

function logAirportCacheRead(normalizedIcao: string, cached: AirportCacheRead): void {
  Sentry.metrics.count('radial.product.airport_cache_read', 1, {
    attributes: {result: cached.kind},
  });
  const attributes = {
    'cache.operation': 'read',
    'radial.airport.icao': normalizedIcao,
  };
  if (cached.kind === 'present' || cached.kind === 'missing') {
    Sentry.logger.debug(
      Sentry.logger.fmt`Airport ${normalizedIcao} cache read completed`,
      {...attributes, 'cache.hit': cached.kind === 'present'}
    );
    return;
  }

  Sentry.logger.error(Sentry.logger.fmt`Airport ${normalizedIcao} cache read failed`, {
    ...attributes,
    'radial.failure.reason':
      cached.kind === 'corrupt' ? 'cache-corrupt' : 'database-query',
  });
}

async function publishAirportWithinGate(
  instance: DuckDBInstance,
  airport: AirportRecord,
  retrievedAt: string,
  publishedAt: string,
  beforeCommit?: () => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  abortableOperation.throwIfAborted(signal);
  const connection = await instance.connect();
  let commitStarted = false;
  try {
    await connection.run('BEGIN TRANSACTION');
    try {
      abortableOperation.throwIfAborted(signal);
      const active = await connection.runAndReadAll(`
        SELECT
          CAST(state.active_navaid_snapshot_id AS VARCHAR) AS snapshot_id,
          CAST(snapshots.magnetic_reference_date AS VARCHAR) AS magnetic_reference_date
        FROM radial_producer.producer_state AS state
        LEFT JOIN radial_producer.navaid_snapshots AS snapshots
          ON snapshots.snapshot_id = state.active_navaid_snapshot_id
        WHERE state.singleton
      `);
      const activeRow = active.getRowObjectsJS()[0];
      if (activeRow === undefined) {
        throw new Error('Producer Schema state is missing its singleton row.');
      }

      const snapshotId = activeRow['snapshot_id'];
      const magneticReferenceDate = activeRow['magnetic_reference_date'];
      if (
        snapshotId !== null &&
        (typeof snapshotId !== 'string' || typeof magneticReferenceDate !== 'string')
      ) {
        throw new Error('Active Navaid Snapshot metadata is invalid.');
      }

      await connection.run('DELETE FROM radial_producer.cached_airports WHERE icao = ?', [
        airport.icao,
      ]);
      await connection.run(
        `INSERT INTO radial_producer.cached_airports
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ))`,
        [
          airport.icao,
          airport.sourceId,
          airport.name,
          airport.longitude,
          airport.latitude,
          airport.canonicalRecord,
          airport.recordChecksum,
          `openaip:airport:${airport.sourceId}`,
          retrievedAt,
          publishedAt,
        ]
      );

      abortableOperation.throwIfAborted(signal);
      if (typeof snapshotId === 'string') {
        if (typeof magneticReferenceDate !== 'string') {
          throw new Error('Active Navaid Snapshot magnetic reference date is missing.');
        }

        const magneticDeclinationDegEast = Wmm2025.localMagneticDeclinationFromWmm2025({
          referenceDate: magneticReferenceDate,
          longitude: airport.longitude,
          latitude: airport.latitude,
        });
        await connection.run(
          `DELETE FROM radial_producer.planner_airports
           WHERE snapshot_id = CAST(? AS UUID) AND icao = ?`,
          [snapshotId, airport.icao]
        );
        await connection.run(
          `INSERT INTO radial_producer.planner_airports
           VALUES (CAST(? AS UUID), ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            airport.icao,
            airport.sourceId,
            airport.name,
            airport.longitude,
            airport.latitude,
            magneticDeclinationDegEast,
          ]
        );
      }

      abortableOperation.throwIfAborted(signal);
      await beforeCommit?.();
      abortableOperation.throwIfAborted(signal);
      commitStarted = true;
      await connection.run('COMMIT');
    } catch (error) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        throw new AirportPublicationError(
          false,
          error instanceof Error ? error.message : 'Cached Airport publication failed.'
        );
      }

      throw new AirportPublicationError(
        !commitStarted,
        error instanceof Error ? error.message : 'Cached Airport publication failed.'
      );
    }
  } finally {
    connection.closeSync();
  }
}

function normalizeIcao(value: string): string {
  return value.trim().toUpperCase();
}

function failure(
  code: RadialApplicationTypes['DataFailure']['code'],
  summary: string,
  cause: string,
  action: string,
  activeDataPreserved = true
): AirportReloadResult {
  return {
    ok: false,
    failure: {code, summary, cause, action, activeDataPreserved},
  };
}

function mapAirportReloadFailure(
  reloadFailure: AirportResolutionFailure
): AirportReloadResult {
  switch (reloadFailure.reason) {
    case 'not-found':
    case 'mismatched':
      return failure(
        'DATA_AIRPORT_NOT_FOUND',
        'The requested Airport was not found.',
        'OpenAIP returned no exact usable match for the requested ICAO.',
        'Check the ICAO and retry the Airport reload.'
      );
    case 'ambiguous':
      return failure(
        'DATA_AIRPORT_AMBIGUOUS',
        'The Airport lookup was ambiguous.',
        'OpenAIP returned multiple usable records for the requested ICAO.',
        'Resolve the duplicate OpenAIP records and retry the Airport reload.'
      );
    case 'unusable':
      return failure(
        'DATA_AIRPORT_INVALID',
        'The requested Airport data is invalid.',
        'OpenAIP returned an unusable record for the requested ICAO.',
        'Correct the upstream Airport data and retry the Airport reload.'
      );
    case 'cache-corrupt':
    case 'credentials-missing':
    case 'database-query':
      return failure(
        'DATA_OPENAIP_INVALID_RESPONSE',
        'The Airport lookup failed.',
        'The Airport source did not produce a usable result.',
        'Check the Airport source and retry the Airport reload.'
      );
    case 'source-invalid':
      return failure(
        'DATA_OPENAIP_INVALID_RESPONSE',
        'OpenAIP Airport acquisition failed.',
        'The OpenAIP Airport response was invalid.',
        'Check OpenAIP source compatibility and retry the Airport reload.'
      );
    case 'source-unavailable':
      return failure(
        'DATA_OPENAIP_UNAVAILABLE',
        'OpenAIP Airport acquisition failed.',
        'The OpenAIP Airport source was unavailable.',
        'Check OpenAIP availability and credentials, then retry the Airport reload.'
      );
    case 'publication-failed':
      return failure(
        'DATA_PUBLICATION_FAILED',
        'Cached Airport publication failed.',
        'The Cached Airport could not be committed.',
        'Inspect database availability and retry the Airport reload.'
      );
  }
}

function normalizedIcaoValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeIcao(value);
  return ICAO_PATTERN.test(normalized) ? normalized : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  return value.trim();
}

function parsePoint(
  value: unknown
): Readonly<{longitude: number; latitude: number}> | undefined {
  if (!isJsonObject(value) || value['type'] !== 'Point') {
    return undefined;
  }

  const coordinates = value['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return undefined;
  }

  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !validCoordinates(longitude, latitude)
  ) {
    return undefined;
  }

  return {longitude, latitude};
}

function validCoordinates(longitude: number, latitude: number): boolean {
  return (
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude < 180 &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

class AirportSourceInvalidError extends Error {}

class AirportPublicationError extends Error {
  readonly activeDataPreserved: boolean;

  constructor(activeDataPreserved: boolean, message: string) {
    super(message);
    this.activeDataPreserved = activeDataPreserved;
  }
}

class AirportSourceUnavailableError extends Error {
  constructor(options: {cause: unknown}) {
    super('OpenAIP Airport source was unavailable.', options);
  }
}

export default Object.assign(ensureCachedAirport, {reloadAirport});
