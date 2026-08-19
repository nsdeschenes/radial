import {http, HttpResponse} from 'msw';
import {expect, test} from 'vitest';

import captureOpenAIPNavaids from '#radial/data-producer/internal/OpenAIPNavaidCapture.js';
import type OpenAIPNavaidTransport from '#radial/data-producer/internal/OpenAIPNavaidTransport.js';
import OpenAIPNavaidTransportError from '#radial/data-producer/internal/OpenAIPNavaidTransportError.js';
import createProductionOpenAIPNavaidTransport from '#radial/data-producer/internal/ProductionOpenAIPNavaidTransport.js';
import server from '#radial/test/server.js';

const OPENAIP_NAVAID_URL = 'https://api.core.openaip.net/api/navaids';

function jsonResponse(value: unknown, status = 200) {
  return {
    status,
    headers: {},
    body: JSON.stringify(value),
  };
}

test('captures every Navaid page serially with the fixed production query', async () => {
  const requests: Parameters<OpenAIPNavaidTransport>[0][] = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const transport: OpenAIPNavaidTransport = async request => {
    requests.push(request);
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await Promise.resolve();
    activeRequests -= 1;

    const firstPageItems = Array.from({length: 1000}, (_, index) => ({
      _id: String(index + 1).padStart(4, '0'),
      additive: {preserved: true},
    }));
    return jsonResponse({
      page: request.page,
      limit: 1000,
      totalCount: 1001,
      totalPages: 2,
      ...(request.page === 1 ? {nextPage: 2} : {}),
      items:
        request.page === 1
          ? firstPageItems
          : [{_id: '1001', additive: {preserved: true}}],
    });
  };

  const result = await captureOpenAIPNavaids({
    transport,
    now: () => new Date('2026-08-17T12:00:00.000Z'),
    sleep: async () => undefined,
    random: () => 0,
  });

  expect(requests).toEqual([
    {
      page: 1,
      limit: 1000,
      sortBy: '_id',
      sortDesc: false,
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    },
    {
      page: 2,
      limit: 1000,
      sortBy: '_id',
      sortDesc: false,
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    },
  ]);
  expect(maximumActiveRequests).toBe(1);
  expect(result.rawNavaids).toHaveLength(1001);
  expect(result.rawNavaids.at(0)).toEqual({
    _id: '0001',
    additive: {preserved: true},
  });
  expect(result.rawNavaids.at(-1)).toEqual({
    _id: '1001',
    additive: {preserved: true},
  });
  expect(result.retrievedAt).toBe('2026-08-17T12:00:00.000Z');
  expect(result.retrievalCompletedAt).toBe('2026-08-17T12:00:00.000Z');
});

test.each([
  ['malformed JSON', '{'],
  [
    'duplicate object keys',
    '{"page":1,"limit":1000,"totalCount":1,"totalPages":1,"items":[{"_id":"1","nested":{"value":1,"value":2}}]}',
  ],
  [
    'non-object items',
    '{"page":1,"limit":1000,"totalCount":1,"totalPages":1,"items":[null]}',
  ],
  [
    'an incompatible envelope',
    '{"page":1,"limit":1000,"totalCount":0,"totalPages":1,"items":[],"unexpected":true}',
  ],
  [
    'a non-canonicalizable record',
    '{"page":1,"limit":1000,"totalCount":1,"totalPages":1,"items":[{"_id":"\\ud800"}]}',
  ],
])('rejects the complete candidate for %s', async (_description, body) => {
  const transport: OpenAIPNavaidTransport = async () => ({
    status: 200,
    headers: {},
    body,
  });

  await expect(captureOpenAIPNavaids({transport})).rejects.toThrow();
});

test('restarts drifted collections from page one while preserving retrieval start', async () => {
  const requestedPages: number[] = [];
  const times = [
    new Date('2026-08-17T12:00:00.000Z'),
    new Date('2026-08-17T12:00:05.000Z'),
  ];
  const transport: OpenAIPNavaidTransport = async request => {
    requestedPages.push(request.page);
    if (requestedPages.length === 1) {
      return jsonResponse({
        page: 1,
        limit: 1000,
        totalCount: 1001,
        totalPages: 2,
        nextPage: 2,
        items: Array.from({length: 1000}, (_, index) => ({
          _id: String(index + 1).padStart(4, '0'),
        })),
      });
    }

    if (requestedPages.length === 2) {
      return jsonResponse({
        page: 2,
        limit: 1000,
        totalCount: 1002,
        totalPages: 2,
        items: [{_id: '1001'}, {_id: '1002'}],
      });
    }

    return jsonResponse({
      page: 1,
      limit: 1000,
      totalCount: 2,
      totalPages: 1,
      items: [{_id: 'a'}, {_id: 'b'}],
    });
  };

  const capture = await captureOpenAIPNavaids({
    transport,
    now: () => times.shift() ?? new Date('2026-08-17T12:00:05.000Z'),
  });

  expect(requestedPages).toEqual([1, 2, 1]);
  expect(capture.rawNavaids).toEqual([{_id: 'a'}, {_id: 'b'}]);
  expect(capture.retrievedAt).toBe('2026-08-17T12:00:00.000Z');
  expect(capture.retrievalCompletedAt).toBe('2026-08-17T12:00:05.000Z');
});

test('permits at most three complete attempts for collection drift', async () => {
  let requests = 0;
  const transport: OpenAIPNavaidTransport = async () => {
    requests += 1;
    return jsonResponse({
      page: 1,
      limit: 1000,
      totalCount: 2,
      totalPages: 1,
      items: [{_id: 'b'}, {_id: 'a'}],
    });
  };

  await expect(captureOpenAIPNavaids({transport})).rejects.toThrow(
    'collection drifted during all 3 capture attempts'
  );
  expect(requests).toBe(3);
});

test('retries transient failures with bounded jitter and valid Retry-After', async () => {
  const delays: number[] = [];
  let requests = 0;
  const transport: OpenAIPNavaidTransport = async () => {
    requests += 1;
    if (requests === 1) {
      throw new OpenAIPNavaidTransportError('request timed out', true);
    }

    if (requests === 2) {
      return {status: 503, headers: {'retry-after': '2'}, body: ''};
    }

    return jsonResponse({
      page: 1,
      limit: 1000,
      totalCount: 0,
      totalPages: 0,
      items: [],
    });
  };

  await captureOpenAIPNavaids({
    transport,
    sleep: milliseconds => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
    random: () => 0.5,
  });

  expect(delays).toEqual([500, 2000]);
  expect(requests).toBe(3);
});

test.each([400, 401, 403, 404])(
  'does not retry deterministic HTTP %i failures',
  async status => {
    let requests = 0;
    const transport: OpenAIPNavaidTransport = async () => {
      requests += 1;
      return {status, headers: {}, body: 'secret upstream body'};
    };

    await expect(captureOpenAIPNavaids({transport})).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toBe(1);
  }
);

test.each([429, 500, 502, 504])('retries transient HTTP %i failures', async status => {
  let requests = 0;
  const transport: OpenAIPNavaidTransport = async () => {
    requests += 1;
    if (requests === 1) {
      return {status, headers: {}, body: ''};
    }

    return jsonResponse({
      page: 1,
      limit: 1000,
      totalCount: 0,
      totalPages: 0,
      items: [],
    });
  };

  await captureOpenAIPNavaids({
    transport,
    sleep: async () => undefined,
    random: () => 0,
  });
  expect(requests).toBe(2);
});

test('caps request retries at five without exposing transport details', async () => {
  let requests = 0;
  const transport: OpenAIPNavaidTransport = async () => {
    requests += 1;
    throw new Error('https://api.example.test/?api_key=secret raw response');
  };

  await expect(
    captureOpenAIPNavaids({
      transport,
      sleep: async () => undefined,
      random: () => 0,
    })
  ).rejects.toThrow('OpenAIP Navaid transport failed after 5 attempts.');
  expect(requests).toBe(5);
});

test('uses the pinned HTTPS origin and hardened production transport policy', async () => {
  let capturedRequest: Request | undefined;
  server.use(
    http.get(OPENAIP_NAVAID_URL, ({request}) => {
      capturedRequest = request;
      return HttpResponse.json(
        {page: 1, limit: 1000, totalCount: 0, totalPages: 0, items: []},
        {headers: {'retry-after': '1'}}
      );
    })
  );

  const transport = createProductionOpenAIPNavaidTransport('super-secret-api-key');
  const response = await transport({
    page: 1,
    limit: 1000,
    sortBy: '_id',
    sortDesc: false,
    connectionTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
  });

  expect(capturedRequest?.url).toBe(
    `${OPENAIP_NAVAID_URL}?page=1&limit=1000&sortBy=_id&sortDesc=false`
  );
  expect(capturedRequest?.headers.get('x-openaip-api-key')).toBe('super-secret-api-key');
  expect(capturedRequest?.headers.get('accept-encoding')).toBe('br, gzip, deflate');
  expect(capturedRequest?.redirect).toBe('manual');
  expect(response.status).toBe(200);
  expect(response.headers['retry-after']).toBe('1');
});

test('rejects an oversized production response without exposing its body', async () => {
  server.use(
    http.get(OPENAIP_NAVAID_URL, () =>
      HttpResponse.text('secret body', {
        headers: {'content-length': String(64 * 1024 * 1024 + 1)},
      })
    )
  );

  const transport = createProductionOpenAIPNavaidTransport('super-secret-api-key');
  await expect(
    transport({
      page: 1,
      limit: 1000,
      sortBy: '_id',
      sortDesc: false,
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    })
  ).rejects.toThrow('OpenAIP Navaid response exceeded 64 MiB.');
});
