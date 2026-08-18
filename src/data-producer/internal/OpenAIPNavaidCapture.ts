import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import parseJsonWithUniqueKeys from '#radial/data-producer/internal/JsonWithUniqueKeys.js';
import OpenAIPNavaidCaptureError from '#radial/data-producer/internal/OpenAIPNavaidCaptureError.js';
import type OpenAIPNavaidTransport from '#radial/data-producer/internal/OpenAIPNavaidTransport.js';
import OpenAIPNavaidTransportError from '#radial/data-producer/internal/OpenAIPNavaidTransportError.js';

const PAGE_LIMIT = 1000;
const MAX_CAPTURE_ATTEMPTS = 3;
const MAX_REQUEST_ATTEMPTS = 5;
const MAX_ELAPSED_MS = 5 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const ENVELOPE_KEYS = new Set([
  'page',
  'limit',
  'totalCount',
  'totalPages',
  'nextPage',
  'items',
]);

type OpenAIPNavaidTransportResponse = Awaited<ReturnType<OpenAIPNavaidTransport>>;

type CaptureOpenAIPNavaidsRequest = Readonly<{
  transport: OpenAIPNavaidTransport;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onProgress?: (progress: {
    page: number;
    totalPages: number;
    cumulativeRecordCount: number;
  }) => void;
}>;

type CapturedOpenAIPNavaids = Readonly<{
  rawNavaids: readonly Readonly<Record<string, unknown>>[];
  retrievedAt: string;
  retrievalCompletedAt: string;
}>;

type PageEnvelope = Readonly<{
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  nextPage?: number;
  items: readonly Readonly<Record<string, unknown>>[];
}>;

type CaptureDependencies = Readonly<{
  transport: OpenAIPNavaidTransport;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  onProgress?: CaptureOpenAIPNavaidsRequest['onProgress'];
}>;

class CollectionDriftError extends Error {}

async function captureOpenAIPNavaids(
  request: CaptureOpenAIPNavaidsRequest
): Promise<CapturedOpenAIPNavaids> {
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  const dependencies: CaptureDependencies = {
    transport: request.transport,
    now,
    sleep:
      request.sleep ??
      (milliseconds =>
        new Promise(resolve => {
          setTimeout(resolve, milliseconds);
        })),
    random: request.random ?? Math.random,
    ...(request.onProgress === undefined ? {} : {onProgress: request.onProgress}),
  };

  try {
    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const rawNavaids = await captureOneCollection(dependencies);
        return Object.freeze({
          rawNavaids: Object.freeze(rawNavaids),
          retrievedAt: startedAt.toISOString(),
          retrievalCompletedAt: now().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof CollectionDriftError)) {
          throw error;
        }
        if (attempt === MAX_CAPTURE_ATTEMPTS) {
          throw new OpenAIPNavaidCaptureError(
            'snapshot-drift',
            `OpenAIP Navaid collection drifted during all ${MAX_CAPTURE_ATTEMPTS} capture attempts.`
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof OpenAIPNavaidCaptureError) {
      throw error;
    }
    throw new OpenAIPNavaidCaptureError(
      'invalid-response',
      error instanceof Error ? error.message : 'OpenAIP Navaid response was invalid.'
    );
  }
  throw new Error('OpenAIP Navaid capture exhausted its attempt policy.');
}

async function captureOneCollection(
  dependencies: CaptureDependencies
): Promise<Readonly<Record<string, unknown>>[]> {
  const rawNavaids: Readonly<Record<string, unknown>>[] = [];
  const seenIds = new Set<string>();
  let previousId: string | undefined;
  let expectedTotalCount: number | undefined;
  let expectedTotalPages: number | undefined;
  let pageNumber = 1;

  while (true) {
    const response = await requestPageWithRetry(pageNumber, dependencies);
    const envelope = parsePageEnvelope(response.body);
    if (envelope.page !== pageNumber || envelope.limit !== PAGE_LIMIT) {
      throw new CollectionDriftError();
    }
    if (pageNumber === 1) {
      expectedTotalCount = envelope.totalCount;
      expectedTotalPages = envelope.totalPages;
      const calculatedPages = Math.ceil(expectedTotalCount / PAGE_LIMIT);
      if (expectedTotalPages !== calculatedPages) {
        throw new CollectionDriftError();
      }
    } else if (
      envelope.totalCount !== expectedTotalCount ||
      envelope.totalPages !== expectedTotalPages
    ) {
      throw new CollectionDriftError();
    }

    const expectedItemCount =
      envelope.totalPages === 0
        ? 0
        : pageNumber < envelope.totalPages
          ? PAGE_LIMIT
          : envelope.totalCount - PAGE_LIMIT * (envelope.totalPages - 1);
    const expectedNextPage =
      pageNumber < envelope.totalPages ? pageNumber + 1 : undefined;
    if (
      envelope.items.length !== expectedItemCount ||
      envelope.nextPage !== expectedNextPage
    ) {
      throw new CollectionDriftError();
    }

    for (const item of envelope.items) {
      const sourceId = item['_id'];
      if (
        typeof sourceId !== 'string' ||
        sourceId === '' ||
        seenIds.has(sourceId) ||
        (previousId !== undefined && sourceId <= previousId)
      ) {
        throw new CollectionDriftError();
      }
      seenIds.add(sourceId);
      previousId = sourceId;
      rawNavaids.push(item);
    }
    dependencies.onProgress?.({
      page: pageNumber,
      totalPages: envelope.totalPages,
      cumulativeRecordCount: rawNavaids.length,
    });

    if (expectedNextPage === undefined) {
      if (rawNavaids.length !== expectedTotalCount) {
        throw new CollectionDriftError();
      }
      return rawNavaids;
    }
    pageNumber = expectedNextPage;
  }
}

async function requestPageWithRetry(
  page: number,
  dependencies: CaptureDependencies
): Promise<OpenAIPNavaidTransportResponse> {
  const requestStartedAtMs = dependencies.now().getTime();
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    assertElapsedCeiling(requestStartedAtMs, dependencies);
    let response: OpenAIPNavaidTransportResponse;
    try {
      response = await dependencies.transport({
        page,
        limit: PAGE_LIMIT,
        sortBy: '_id',
        sortDesc: false,
        connectionTimeoutMs: 10_000,
        requestTimeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof OpenAIPNavaidTransportError && !error.retryable) {
        throw new OpenAIPNavaidCaptureError(
          'invalid-response',
          'OpenAIP Navaid transport rejected the request.'
        );
      }
      if (attempt === MAX_REQUEST_ATTEMPTS) {
        throw new OpenAIPNavaidCaptureError(
          'unavailable',
          `OpenAIP Navaid transport failed after ${MAX_REQUEST_ATTEMPTS} attempts.`
        );
      }
      await waitBeforeRetry(attempt, undefined, requestStartedAtMs, dependencies);
      continue;
    }

    assertElapsedCeiling(requestStartedAtMs, dependencies);
    if (response.status === 200) {
      return response;
    }
    if (response.status === 401) {
      throw new OpenAIPNavaidCaptureError(
        'auth',
        'OpenAIP Navaid request failed with HTTP 401.'
      );
    }
    if (response.status === 403) {
      throw new OpenAIPNavaidCaptureError(
        'forbidden',
        'OpenAIP Navaid request failed with HTTP 403.'
      );
    }
    if (!RETRYABLE_STATUSES.has(response.status)) {
      throw new OpenAIPNavaidCaptureError(
        'invalid-response',
        `OpenAIP Navaid request failed with HTTP ${response.status}.`
      );
    }
    if (attempt === MAX_REQUEST_ATTEMPTS) {
      throw new OpenAIPNavaidCaptureError(
        'unavailable',
        `OpenAIP Navaid request failed with HTTP ${response.status} after ${MAX_REQUEST_ATTEMPTS} attempts.`
      );
    }
    await waitBeforeRetry(
      attempt,
      headerValue(response.headers, 'retry-after'),
      requestStartedAtMs,
      dependencies
    );
  }
  throw new Error('OpenAIP Navaid request exhausted its retry policy.');
}

async function waitBeforeRetry(
  failedAttempt: number,
  retryAfter: string | undefined,
  requestStartedAtMs: number,
  dependencies: CaptureDependencies
): Promise<void> {
  const retryAfterMs = parseRetryAfter(retryAfter, dependencies.now());
  const jitterCeilingMs = Math.min(30_000, 1000 * 2 ** (failedAttempt - 1));
  const delayMs = retryAfterMs ?? Math.floor(dependencies.random() * jitterCeilingMs);
  if (elapsedMilliseconds(requestStartedAtMs, dependencies) + delayMs > MAX_ELAPSED_MS) {
    throw new Error('OpenAIP Navaid request exceeded its 5-minute elapsed ceiling.');
  }
  await dependencies.sleep(delayMs);
}

function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  const milliseconds =
    seconds === undefined ? Date.parse(value) - now.getTime() : seconds * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 120_000) {
    return undefined;
  }
  return milliseconds;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  requestedName: string
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === requestedName
  );
  return entry?.[1];
}

function assertElapsedCeiling(
  requestStartedAtMs: number,
  dependencies: CaptureDependencies
): void {
  if (elapsedMilliseconds(requestStartedAtMs, dependencies) >= MAX_ELAPSED_MS) {
    throw new Error('OpenAIP Navaid request exceeded its 5-minute elapsed ceiling.');
  }
}

function elapsedMilliseconds(
  requestStartedAtMs: number,
  dependencies: CaptureDependencies
): number {
  return Math.max(0, dependencies.now().getTime() - requestStartedAtMs);
}

function parsePageEnvelope(body: string): PageEnvelope {
  let value: unknown;
  try {
    value = parseJsonWithUniqueKeys(body);
  } catch {
    throw new Error('OpenAIP Navaid response was not valid duplicate-key-free JSON.');
  }
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(key => !ENVELOPE_KEYS.has(key)) ||
    !Array.isArray(value['items'])
  ) {
    throw new Error('OpenAIP Navaid response had an incompatible envelope.');
  }
  for (const [index, item] of value['items'].entries()) {
    if (!isJsonObject(item)) {
      throw new Error(`OpenAIP Navaid item ${index + 1} was not a JSON object.`);
    }
    try {
      canonicalizeJson(item);
    } catch {
      throw new Error(`OpenAIP Navaid item ${index + 1} was not canonicalizable.`);
    }
  }
  const page = integerFrom(value, 'page', 1);
  const limit = integerFrom(value, 'limit', 1);
  const totalCount = integerFrom(value, 'totalCount', 0);
  const totalPages = integerFrom(value, 'totalPages', 0);
  const nextPage = value['nextPage'];
  if (
    nextPage !== undefined &&
    (typeof nextPage !== 'number' || !Number.isSafeInteger(nextPage) || nextPage < 1)
  ) {
    throw new Error('OpenAIP Navaid response had an incompatible envelope.');
  }
  return {
    page,
    limit,
    totalCount,
    totalPages,
    ...(typeof nextPage === 'number' ? {nextPage} : {}),
    items: value['items'] as Readonly<Record<string, unknown>>[],
  };
}

function integerFrom(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number
): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < minimum) {
    throw new Error('OpenAIP Navaid response had an incompatible envelope.');
  }
  return field;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default captureOpenAIPNavaids;
