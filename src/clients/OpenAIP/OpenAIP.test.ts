import {http, HttpResponse} from 'msw';
import {expect, test} from 'vitest';

import errorResponse from '#fixtures/OpenAIP/error.json' with {type: 'json'};
import invalidList from '#fixtures/OpenAIP/invalid-list.json' with {type: 'json'};
import airportsResponse from '#fixtures/OpenAIP/success/airports.json' with {type: 'json'};
import airspacesResponse from '#fixtures/OpenAIP/success/airspaces.json' with {type: 'json'};
import hotspotsResponse from '#fixtures/OpenAIP/success/hotspots.json' with {type: 'json'};
import navaidsResponse from '#fixtures/OpenAIP/success/navaids.json' with {type: 'json'};
import obstaclesResponse from '#fixtures/OpenAIP/success/obstacles.json' with {type: 'json'};
import reportingPointsResponse from '#fixtures/OpenAIP/success/reporting-points.json' with {type: 'json'};
import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';
import OpenAIPError from '#radial/clients/OpenAIP/OpenAIPError.js';
import server from '#radial/test/server.js';

const API_URL = 'https://api.core.openaip.net/api';
type SuccessfulResponse =
  | typeof airportsResponse
  | typeof airspacesResponse
  | typeof hotspotsResponse
  | typeof navaidsResponse
  | typeof obstaclesResponse
  | typeof reportingPointsResponse;

const successfulResponses = new Map<string, SuccessfulResponse>([
  ['airports', airportsResponse],
  ['airspaces', airspacesResponse],
  ['hotspots', hotspotsResponse],
  ['navaids', navaidsResponse],
  ['obstacles', obstaclesResponse],
  ['reporting-points', reportingPointsResponse],
]);

test('fetches and validates an airport list with correctly encoded filters', async () => {
  let requestedUrl: string | undefined;
  let apiKey: string | null | undefined;

  server.use(
    http.get(`${API_URL}/airports`, ({request}) => {
      requestedUrl = request.url;
      apiKey = request.headers.get('x-openaip-api-key');
      return HttpResponse.json(airportsResponse);
    })
  );

  const client = new OpenAIP('test-api-key');
  const airports = await client.airports({
    country: 'CA',
    type: [0, 2],
    private: false,
  });

  expect(airports).toEqual(airportsResponse);
  expect(requestedUrl).toBe(
    'https://api.core.openaip.net/api/airports?country=CA&type=0&type=2&private=false'
  );
  expect(apiKey).toBe('test-api-key');
});

test('fetches and validates every supported list and document endpoint', async () => {
  const requestedUrls: string[] = [];

  server.use(
    http.get(`${API_URL}/*`, ({request}) => {
      requestedUrls.push(request.url);

      const [endpoint, documentId] = new URL(request.url).pathname
        .slice('/api/'.length)
        .split('/');
      const response = successfulResponses.get(endpoint ?? '');

      if (!response) {
        return new HttpResponse(null, {status: 404});
      }

      return HttpResponse.json(documentId ? response.items[0] : response);
    })
  );

  const client = new OpenAIP('test-api-key');

  const responses = await Promise.all([
    client.airports(),
    client.airport({id: 'document-id', fields: 'name,icaoCode'}),
    client.airspaces(),
    client.airspace({id: 'document-id'}),
    client.hotspots(),
    client.hotspot({id: 'document-id'}),
    client.navaids(),
    client.navaid({id: 'document-id'}),
    client.obstacles(),
    client.obstacle({id: 'document-id'}),
    client.reportingPoints(),
    client.reportingPoint({id: 'document-id'}),
  ]);

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
  expect(responses).toEqual([
    airportsResponse,
    airportsResponse.items[0],
    airspacesResponse,
    airspacesResponse.items[0],
    hotspotsResponse,
    hotspotsResponse.items[0],
    navaidsResponse,
    navaidsResponse.items[0],
    obstaclesResponse,
    obstaclesResponse.items[0],
    reportingPointsResponse,
    reportingPointsResponse.items[0],
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
