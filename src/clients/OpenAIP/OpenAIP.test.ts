import assert from 'node:assert/strict';
import test from 'node:test';

import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';
import OpenAIPError from '#radial/clients/OpenAIP/OpenAIPError.js';

const emptyList = {
  page: 1,
  limit: 100,
  totalCount: 0,
  totalPages: 0,
  items: [],
};

function requestUrl(input: string | URL | Request) {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

await test('fetches and validates an airport list with correctly encoded filters', async t => {
  let requestedUrl: string | undefined;
  let apiKey: string | null | undefined;

  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = requestUrl(input);
      apiKey = new Headers(init?.headers).get('x-openaip-api-key');
      return Response.json(emptyList);
    }
  );

  const client = new OpenAIP('test-api-key');
  const airports = await client.airports({
    country: 'CA',
    type: [0, 2],
    private: false,
  });

  assert.deepEqual(airports, emptyList);
  assert.equal(
    requestedUrl,
    'https://api.core.openaip.net/api/airports?country=CA&type=0&type=2&private=false'
  );
  assert.equal(apiKey, 'test-api-key');
});

await test('fetches every supported list and document endpoint', async t => {
  const requestedUrls: string[] = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const requestedUrl = requestUrl(input);
    requestedUrls.push(requestedUrl);

    return Response.json(requestedUrl.includes('/document-id') ? {} : emptyList);
  });

  const client = new OpenAIP('test-api-key');

  await client.airports();
  await client.airport({id: 'document-id', fields: 'name,icaoCode'});
  await client.airspaces();
  await client.airspace({id: 'document-id'});
  await client.hotspots();
  await client.hotspot({id: 'document-id'});
  await client.navaids();
  await client.navaid({id: 'document-id'});
  await client.obstacles();
  await client.obstacle({id: 'document-id'});
  await client.reportingPoints();
  await client.reportingPoint({id: 'document-id'});

  assert.deepEqual(requestedUrls, [
    'https://api.core.openaip.net/api/airports',
    'https://api.core.openaip.net/api/airports/document-id?fields=name%2CicaoCode',
    'https://api.core.openaip.net/api/airspaces',
    'https://api.core.openaip.net/api/airspaces/document-id',
    'https://api.core.openaip.net/api/hotspots',
    'https://api.core.openaip.net/api/hotspots/document-id',
    'https://api.core.openaip.net/api/navaids',
    'https://api.core.openaip.net/api/navaids/document-id',
    'https://api.core.openaip.net/api/obstacles',
    'https://api.core.openaip.net/api/obstacles/document-id',
    'https://api.core.openaip.net/api/reporting-points',
    'https://api.core.openaip.net/api/reporting-points/document-id',
  ]);
});

await test('throws a typed error for an OpenAIP API error response', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        message: 'Permission denied',
        code: 'auth/forbidden',
        status: 403,
      },
      {status: 403}
    )
  );

  const client = new OpenAIP('invalid-api-key');

  await assert.rejects(client.airports(), error => {
    assert(error instanceof OpenAIPError);
    assert.equal(error.message, 'Permission denied');
    assert.equal(error.code, 'auth/forbidden');
    assert.equal(error.status, 403);
    return true;
  });
});

await test('rejects a successful response that does not match its schema', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({items: []}));

  const client = new OpenAIP('test-api-key');

  await assert.rejects(
    client.airports(),
    /OpenAIP response for "\/airports" did not match the expected schema/
  );
});
