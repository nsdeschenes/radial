import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import openRadialApplication from 'radial';
import {expect, test} from 'vitest';

import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

type AirportPage = Readonly<{
  page: number;
  totalPages: number;
  items: readonly unknown[];
}>;

type AirportPageRequest = Readonly<{
  search: string;
  page: number;
  limit: number;
}>;

test('rejects invalid endpoint requests before Airport lookup or cache mutation', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-airport-validation-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const requests: AirportPageRequest[] = [];

  try {
    const opened = await openBootstrappedApplication(databasePath, request => {
      requests.push(request);
      return emptyAirportPage(request.page);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const planner = await opened.value.planning.open();
    if (!planner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await expect(
      planner.value.planRoute({departureIcao: ' bad ', arrivalIcao: 'BBBB'})
    ).resolves.toMatchObject({
      ok: false,
      failure: {code: 'invalid-request', field: 'departureIcao'},
    });
    await expect(
      planner.value.planRoute({departureIcao: 'CYYZ', arrivalIcao: ' CYYZ '})
    ).resolves.toMatchObject({
      ok: false,
      failure: {code: 'invalid-request', reason: 'identical-airports'},
    });

    await planner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    expect(requests).toEqual([]);
    expect(await cachedAirportRows(databasePath)).toEqual([]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('resolves missing Airports across every page and caches the exact usable records', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-airport-pages-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const requests: AirportPageRequest[] = [];

  try {
    const opened = await openBootstrappedApplication(databasePath, request => {
      requests.push(request);
      if (request.search === 'CAAA') {
        return request.page === 1
          ? airportPage(1, 2, [airport('mismatch', 'CXXX', -80, 44)])
          : airportPage(2, 2, [airport('airport-a', ' caaa ', -80, 44)]);
      }
      return airportPage(1, 1, [airport('airport-b', 'CBBB', -80.5, 44)]);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const planner = await opened.value.planning.open();
    if (!planner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await planner.value.planRoute({departureIcao: ' caaa ', arrivalIcao: ' cbbb '});
    await planner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    let offlineLookupAttempted = false;
    const offline = await openRadialApplication(
      {databasePath},
      {
        listOpenAIPAirports: async () => {
          offlineLookupAttempted = true;
          throw new Error('Committed Cached Airports should be sufficient.');
        },
      }
    );
    if (!offline.ok) {
      throw new Error('Expected the committed database to open offline.');
    }
    const offlinePlanner = await offline.value.planning.open();
    if (!offlinePlanner.ok) {
      throw new Error('Expected the offline planner to open.');
    }
    await offlinePlanner.value.planRoute({departureIcao: 'CAAA', arrivalIcao: 'CBBB'});
    await offlinePlanner.value[Symbol.asyncDispose]();
    await offline.value[Symbol.asyncDispose]();

    expect(requests).toEqual([
      {search: 'CAAA', page: 1, limit: 1000},
      {search: 'CAAA', page: 2, limit: 1000},
      {search: 'CBBB', page: 1, limit: 1000},
    ]);
    expect(await cachedAirportRows(databasePath)).toEqual([
      {icao: 'CAAA', database_id: 'airport-a', name: 'CAAA Airport'},
      {icao: 'CBBB', database_id: 'airport-b', name: 'CBBB Airport'},
    ]);
    expect(offlineLookupAttempted).toBe(false);
    expect(await projectedAirportRows(databasePath)).toEqual([
      {icao: 'CAAA', database_id: 'airport-a'},
      {icao: 'CBBB', database_id: 'airport-b'},
    ]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('keeps an independently committed Airport when the other endpoint cannot resolve', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-airport-independent-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const opened = await openBootstrappedApplication(databasePath, request =>
      request.search === 'CAAA'
        ? airportPage(1, 1, [airport('airport-a', 'CAAA', -80, 44)])
        : emptyAirportPage(request.page)
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const planner = await opened.value.planning.open();
    if (!planner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await expect(
      planner.value.planRoute({departureIcao: 'CAAA', arrivalIcao: 'CBBB'})
    ).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-not-found', role: 'arrival', normalizedIcao: 'CBBB'},
    });
    await planner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    expect(await cachedAirportRows(databasePath)).toEqual([
      {icao: 'CAAA', database_id: 'airport-a', name: 'CAAA Airport'},
    ]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test.each([
  {
    name: 'mismatched',
    items: [airport('wrong', 'CXXX', -80, 44)],
    failure: {code: 'airport-resolution-failed', reason: 'mismatched'},
  },
  {
    name: 'ambiguous',
    items: [
      airport('airport-a', 'CAAA', -80, 44),
      airport('airport-b', 'CAAA', -80.5, 44),
    ],
    failure: {code: 'airport-ambiguous'},
  },
  {
    name: 'unusable',
    items: [
      {
        _id: 'airport-invalid',
        name: '',
        icaoCode: 'CAAA',
        geometry: {type: 'Point', coordinates: [-80, 44]},
      },
    ],
    failure: {code: 'airport-resolution-failed', reason: 'unusable'},
  },
])('does not cache $name Airport results', async ({items, failure}) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-airport-rejection-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const opened = await openBootstrappedApplication(databasePath, request =>
      airportPage(request.page, 1, items)
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const planner = await opened.value.planning.open();
    if (!planner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await expect(
      planner.value.planRoute({departureIcao: 'CAAA', arrivalIcao: 'CBBB'})
    ).resolves.toMatchObject({ok: false, failure});
    await planner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    expect(await cachedAirportRows(databasePath)).toEqual([]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports a corrupt committed Cached Airport instead of replacing it', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-airport-corrupt-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  let lookupAttempted = false;

  try {
    const bootstrapped = await openBootstrappedApplication(databasePath, request =>
      emptyAirportPage(request.page)
    );
    if (!bootstrapped.ok) {
      throw new Error('Expected the application to open.');
    }
    const bootstrapPlanner = await bootstrapped.value.planning.open();
    if (!bootstrapPlanner.ok) {
      throw new Error('Expected the bootstrap planner to open.');
    }
    await bootstrapPlanner.value[Symbol.asyncDispose]();
    await bootstrapped.value[Symbol.asyncDispose]();

    await insertCorruptAirport(databasePath);

    const opened = await openRadialApplication(
      {databasePath},
      {
        listOpenAIPAirports: async () => {
          lookupAttempted = true;
          throw new Error('A corrupt cache must not be replaced.');
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the committed database to open.');
    }

    const planner = await opened.value.planning.open();
    if (!planner.ok) {
      throw new Error('Expected the planner to open.');
    }
    await expect(
      planner.value.planRoute({departureIcao: 'CAAA', arrivalIcao: 'CBBB'})
    ).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-cache-corrupt', role: 'departure', normalizedIcao: 'CAAA'},
    });
    await planner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    expect(lookupAttempted).toBe(false);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

async function openBootstrappedApplication(
  databasePath: string,
  listOpenAIPAirports: (request: AirportPageRequest) => AirportPage | Promise<AirportPage>
): ReturnType<typeof openRadialApplication> {
  const timestamp = '2026-07-10T00:00:00.000Z';
  const nasrCycle = createSyntheticFAANasrCycle(
    [
      {
        EFF_DATE: '2026-07-09',
        FREQ: '112.150',
        LAT_DECIMAL: '43.6589',
        LONG_DECIMAL: '-79.6139',
        NAV_ID: 'YYZ',
        NAV_TYPE: 'VOR/DME',
      },
    ],
    {retrievedAt: timestamp}
  );

  return openRadialApplication(
    {databasePath, openAipApiKey: 'test-key'},
    {
      now: () => new Date(timestamp),
      listOpenAIPAirports: request => Promise.resolve(listOpenAIPAirports(request)),
      createOpenAIPTransport: () => async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          page: 1,
          limit: 1000,
          totalCount: 1,
          totalPages: 1,
          items: [
            {
              _id: 'ndb-1',
              type: 2,
              identifier: 'ND',
              name: 'Fallback NDB',
              geometry: {type: 'Point', coordinates: [-80, 44]},
              frequency: {value: '365.000', unit: 1},
              range: {value: 45, unit: 2},
            },
          ],
        }),
      }),
      async acquireFAANasrCycles() {
        return [nasrCycle];
      },
    }
  );
}

function airport(id: string, icaoCode: string, longitude: number, latitude: number) {
  return {
    _id: id,
    name: `${icaoCode.trim().toUpperCase()} Airport`,
    icaoCode,
    geometry: {type: 'Point', coordinates: [longitude, latitude]},
  };
}

function airportPage(
  page: number,
  totalPages: number,
  items: readonly unknown[]
): AirportPage {
  return {page, totalPages, items};
}

function emptyAirportPage(page: number): AirportPage {
  return airportPage(page, 0, []);
}

async function cachedAirportRows(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    const rows = await connection.runAndReadAll(
      `SELECT icao, database_id, name
       FROM radial_producer.cached_airports ORDER BY icao`
    );
    return rows.getRowObjectsJS();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function projectedAirportRows(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const rows = await connection.runAndReadAll(
      `SELECT icao, database_id
       FROM planner_airports ORDER BY icao`
    );
    return rows.getRowObjectsJS();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function insertCorruptAirport(databasePath: string): Promise<void> {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run(
      `INSERT INTO radial_producer.cached_airports VALUES
        ('CAAA', 'airport-corrupt', '', -80, 44, '{"_id":"airport-corrupt"}',
         'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         'openaip:airport-corrupt', TIMESTAMPTZ '2026-07-10 00:00:00+00',
         TIMESTAMPTZ '2026-07-10 00:00:01+00')`
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
