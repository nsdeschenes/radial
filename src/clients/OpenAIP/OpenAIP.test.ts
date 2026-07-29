import {http, HttpResponse} from 'msw';
import {expect, test} from 'vitest';

import emptyList from '#fixtures/OpenAIP/empty-list.json' with {type: 'json'};
import errorResponse from '#fixtures/OpenAIP/error.json' with {type: 'json'};
import invalidList from '#fixtures/OpenAIP/invalid-list.json' with {type: 'json'};
import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';
import OpenAIPError from '#radial/clients/OpenAIP/OpenAIPError.js';
import server from '#radial/test/server.js';

const API_URL = 'https://api.core.openaip.net/api';

test('fetches and validates an airport list with correctly encoded filters', async () => {
  let requestedUrl: string | undefined;
  let apiKey: string | null | undefined;

  server.use(
    http.get(`${API_URL}/airports`, ({request}) => {
      requestedUrl = request.url;
      apiKey = request.headers.get('x-openaip-api-key');
      return HttpResponse.json(emptyList);
    })
  );

  const client = new OpenAIP('test-api-key');
  const airports = await client.airports({
    country: 'CA',
    type: [0, 2],
    private: false,
  });

  expect(airports).toEqual(emptyList);
  expect(requestedUrl).toBe(
    'https://api.core.openaip.net/api/airports?country=CA&type=0&type=2&private=false'
  );
  expect(apiKey).toBe('test-api-key');
});

test('fetches every supported list and document endpoint', async () => {
  const requestedUrls: string[] = [];

  server.use(
    http.get(`${API_URL}/*`, ({request}) => {
      requestedUrls.push(request.url);
      return HttpResponse.json(request.url.includes('/document-id') ? {} : emptyList);
    })
  );

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

  expect(requestedUrls).toEqual([
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

test('throws a typed error for an OpenAIP API error response', async () => {
  server.use(
    http.get(`${API_URL}/airports`, () =>
      HttpResponse.json(errorResponse, {status: errorResponse.status})
    )
  );

  const client = new OpenAIP('invalid-api-key');
  const request = client.airports();

  await expect(request).rejects.toBeInstanceOf(OpenAIPError);
  await expect(request).rejects.toMatchObject(errorResponse);
});

test('rejects a successful response that does not match its schema', async () => {
  server.use(http.get(`${API_URL}/airports`, () => HttpResponse.json(invalidList)));

  const client = new OpenAIP('test-api-key');

  await expect(client.airports()).rejects.toThrow(
    'OpenAIP response for "/airports" did not match the expected schema'
  );
});
