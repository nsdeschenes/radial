import {mkdtemp, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import openRadialApplication from 'radial';
import {expect, test} from 'vitest';

import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

type AirportPageRequest = Readonly<{
  search: string;
  page: number;
  limit: number;
}>;

type AirportPage = Readonly<{
  page: number;
  totalPages: number;
  items: readonly unknown[];
}>;

test('shares one ordinary same-ICAO Airport miss between concurrent plans', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-airport-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  let caaaLookupCount = 0;

  try {
    const opened = await openApplication(databasePath, async request => {
      if (request.search === 'CAAA') {
        caaaLookupCount += 1;
        lookupStarted.resolve();
        await releaseLookup.promise;
        return airportPage(1, 1, [airport('airport-caaa', 'CAAA')]);
      }

      return airportPage(1, 0, []);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    const firstPlan = openedPlanner.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
    });
    const secondPlan = openedPlanner.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
    });

    await lookupStarted.promise;
    expect(caaaLookupCount).toBe(1);
    releaseLookup.resolve();

    await expect(firstPlan).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-not-found', role: 'arrival', normalizedIcao: 'CBBB'},
    });
    await expect(secondPlan).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-not-found', role: 'arrival', normalizedIcao: 'CBBB'},
    });

    await openedPlanner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();

    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      const rows = await connection.runAndReadAll(
        `SELECT icao, database_id
         FROM radial_producer.cached_airports`
      );
      expect(rows.getRowObjectsJS()).toEqual([
        {icao: 'CAAA', database_id: 'airport-caaa'},
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } finally {
    releaseLookup.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('keeps forced same-ICAO Airport reloads distinct and FIFO', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-reload-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const firstLookupStarted = Promise.withResolvers<void>();
  const releaseFirstLookup = Promise.withResolvers<void>();
  const sourceIds: string[] = [];

  try {
    const opened = await openApplication(databasePath, async request => {
      if (request.search !== 'CAAA') {
        return airportPage(1, 0, []);
      }

      const sourceId = `airport-${sourceIds.length + 1}`;
      sourceIds.push(sourceId);
      if (sourceIds.length === 1) {
        firstLookupStarted.resolve();
        await releaseFirstLookup.promise;
      }

      return airportPage(1, 1, [airport(sourceId, 'CAAA')]);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await openedPlanner.value[Symbol.asyncDispose]();

    const firstReload = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    const secondReload = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });

    await firstLookupStarted.promise;
    expect(sourceIds).toEqual(['airport-1']);
    releaseFirstLookup.resolve();

    await expect(firstReload).resolves.toMatchObject({
      ok: true,
      value: {status: 'cached', sourceId: 'airport-1'},
    });
    await expect(secondReload).resolves.toMatchObject({
      ok: true,
      value: {status: 'replaced', sourceId: 'airport-2'},
    });
    expect(sourceIds).toEqual(['airport-1', 'airport-2']);

    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseFirstLookup.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('acquires different Airport ICAOs concurrently', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-keys-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const started = new Set<string>();
  const allLookupsStarted = Promise.withResolvers<void>();
  const releaseLookups = Promise.withResolvers<void>();

  try {
    const opened = await openApplication(databasePath, async request => {
      if (request.search !== 'CAAA' && request.search !== 'CBBB') {
        return airportPage(1, 0, []);
      }

      started.add(request.search);
      if (started.size === 2) {
        allLookupsStarted.resolve();
      }

      await releaseLookups.promise;
      return airportPage(1, 1, [airport(`airport-${request.search}`, request.search)]);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await openedPlanner.value[Symbol.asyncDispose]();

    const firstReload = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    const secondReload = opened.value.dataManagement.reloadAirport({
      icao: 'CBBB',
      openAipApiKey: 'test-key',
    });

    await allLookupsStarted.promise;
    expect([...started].toSorted()).toEqual(['CAAA', 'CBBB']);
    releaseLookups.resolve();
    await expect(firstReload).resolves.toMatchObject({ok: true});
    await expect(secondReload).resolves.toMatchObject({ok: true});

    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseLookups.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('runs Navaid operations end to end in FIFO order', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-navaids-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const firstDerivationStarted = Promise.withResolvers<void>();
  const releaseFirstDerivation = Promise.withResolvers<void>();
  let transportCallCount = 0;
  let nasrCallCount = 0;

  try {
    const opened = await openRadialApplication(
      {databasePath},
      {
        now: () => new Date('2026-07-10T00:00:00.000Z'),
        createOpenAIPTransport: () => async () => {
          transportCallCount += 1;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              page: 1,
              limit: 1000,
              totalCount: 1,
              totalPages: 1,
              items: [navaid()],
            }),
          };
        },
        async acquireFAANasrCycles() {
          nasrCallCount += 1;
          if (nasrCallCount === 1) {
            firstDerivationStarted.resolve();
            await releaseFirstDerivation.promise;
          }

          return [nasrCycle()];
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const firstReload = opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });
    const secondReload = opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });

    await firstDerivationStarted.promise;
    expect(transportCallCount).toBe(1);
    releaseFirstDerivation.resolve();

    await expect(firstReload).resolves.toMatchObject({ok: true});
    await expect(secondReload).resolves.toMatchObject({ok: true});
    expect(transportCallCount).toBe(2);
    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseFirstDerivation.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('cancelling one Airport waiter leaves shared work for another waiter', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-cancel-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const controller = new AbortController();
  let caaaLookupCount = 0;

  try {
    const opened = await openApplication(databasePath, async request => {
      if (request.search === 'CAAA') {
        caaaLookupCount += 1;
        lookupStarted.resolve();
        await releaseLookup.promise;
        return airportPage(1, 1, [airport('airport-caaa', 'CAAA')]);
      }

      return airportPage(1, 0, []);
    });
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    const cancelledPlan = openedPlanner.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
      signal: controller.signal,
    });
    await lookupStarted.promise;
    controller.abort();

    const remainingPlan = openedPlanner.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
    });
    await expect(cancelledPlan).rejects.toMatchObject({name: 'AbortError'});
    expect(caaaLookupCount).toBe(1);

    releaseLookup.resolve();
    await expect(remainingPlan).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-not-found', role: 'arrival', normalizedIcao: 'CBBB'},
    });

    await openedPlanner.value[Symbol.asyncDispose]();
    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseLookup.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('Navaid publication includes an Airport committed before its transaction', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-before-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const airportCommitStarted = Promise.withResolvers<void>();
  const releaseAirportCommit = Promise.withResolvers<void>();

  try {
    const opened = await openApplication(
      databasePath,
      async request =>
        request.search === 'CAAA'
          ? airportPage(1, 1, [airport('airport-caaa', 'CAAA')])
          : airportPage(1, 0, []),
      async () => {},
      async () => {
        airportCommitStarted.resolve();
        await releaseAirportCommit.promise;
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await openedPlanner.value[Symbol.asyncDispose]();

    const airportReload = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    await airportCommitStarted.promise;
    const navaidReload = opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });
    releaseAirportCommit.resolve();

    await expect(airportReload).resolves.toMatchObject({ok: true});
    const navaidResult = await navaidReload;
    expect(navaidResult.ok).toBe(true);
    if (!navaidResult.ok) {
      throw new Error('Expected the Navaid reload to succeed.');
    }

    expect(await projectedAirportSnapshot(databasePath)).toEqual({
      snapshotId: navaidResult.value.snapshotId,
      databaseId: 'airport-caaa',
    });
    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseAirportCommit.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('Airport publication queued after a Navaid replacement uses the replacement snapshot', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-after-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  let holdNavaidCommit = false;
  const navaidCommitStarted = Promise.withResolvers<void>();
  const releaseNavaidCommit = Promise.withResolvers<void>();

  try {
    const opened = await openApplication(
      databasePath,
      async request =>
        request.search === 'CAAA'
          ? airportPage(1, 1, [airport('airport-caaa', 'CAAA')])
          : airportPage(1, 0, []),
      async () => {
        if (holdNavaidCommit) {
          navaidCommitStarted.resolve();
          await releaseNavaidCommit.promise;
        }
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await openedPlanner.value[Symbol.asyncDispose]();
    holdNavaidCommit = true;

    const navaidReload = opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });
    await navaidCommitStarted.promise;
    const airportReload = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    releaseNavaidCommit.resolve();

    const navaidResult = await navaidReload;
    expect(navaidResult.ok).toBe(true);
    if (!navaidResult.ok) {
      throw new Error('Expected the Navaid reload to succeed.');
    }

    await expect(airportReload).resolves.toMatchObject({ok: true});
    expect(await projectedAirportSnapshot(databasePath)).toEqual({
      snapshotId: navaidResult.value.snapshotId,
      databaseId: 'airport-caaa',
    });
    await opened.value[Symbol.asyncDispose]();
  } finally {
    releaseNavaidCommit.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('readers observe the old committed Airport or the replacement, never a partial write', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-reader-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const airportCommitStarted = Promise.withResolvers<void>();
  const releaseAirportCommit = Promise.withResolvers<void>();
  let holdAirportCommit = false;
  let sourceVersion = 1;

  try {
    const opened = await openApplication(
      databasePath,
      async request =>
        request.search === 'CAAA'
          ? airportPage(1, 1, [airport(`airport-${sourceVersion}`, 'CAAA')])
          : airportPage(1, 0, []),
      async () => {},
      async () => {
        if (holdAirportCommit) {
          airportCommitStarted.resolve();
          await releaseAirportCommit.promise;
        }
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const openedPlanner = await opened.value.planning.open();
    if (!openedPlanner.ok) {
      throw new Error('Expected the planner to open.');
    }

    await openedPlanner.value[Symbol.asyncDispose]();

    await expect(
      opened.value.dataManagement.reloadAirport({
        icao: 'CAAA',
        openAipApiKey: 'test-key',
      })
    ).resolves.toMatchObject({ok: true, value: {sourceId: 'airport-1'}});

    holdAirportCommit = true;
    sourceVersion = 2;
    const replacement = opened.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    await airportCommitStarted.promise;

    await expect(projectedAirportDatabaseId(databasePath)).resolves.toEqual({
      cachedId: 'airport-1',
      plannerId: 'airport-1',
    });
    releaseAirportCommit.resolve();
    await expect(replacement).resolves.toMatchObject({
      ok: true,
      value: {sourceId: 'airport-2'},
    });
    await opened.value[Symbol.asyncDispose]();
    await expect(projectedAirportDatabaseId(databasePath)).resolves.toEqual({
      cachedId: 'airport-2',
      plannerId: 'airport-2',
    });
  } finally {
    releaseAirportCommit.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('disposing one application alias does not close work owned by another alias', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-alias-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const aliasDirectory = await mkdtemp(join(tmpdir(), 'radial-concurrency-alias-'));
  const aliasPath = join(aliasDirectory, 'radial-alias.duckdb');
  const airportCommitStarted = Promise.withResolvers<void>();
  const releaseAirportCommit = Promise.withResolvers<void>();
  let sourceId = 0;

  try {
    const listOpenAIPAirports = async (request: AirportPageRequest) => {
      if (request.search !== 'CAAA') {
        return airportPage(1, 0, []);
      }

      sourceId += 1;
      if (sourceId === 1) {
        airportCommitStarted.resolve();
        await releaseAirportCommit.promise;
      }

      return airportPage(1, 1, [airport(`airport-${sourceId}`, 'CAAA')]);
    };

    const first = await openApplication(databasePath, listOpenAIPAirports);
    if (!first.ok) {
      throw new Error('Expected the first application to open.');
    }

    const firstPlanner = await first.value.planning.open();
    if (!firstPlanner.ok) {
      throw new Error('Expected the first planner to open.');
    }

    await firstPlanner.value[Symbol.asyncDispose]();

    await symlink(databasePath, aliasPath);
    const second = await openRadialApplication(
      {databasePath: aliasPath},
      {listOpenAIPAirports}
    );
    if (!second.ok) {
      throw new Error('Expected the aliased application to open.');
    }

    const firstReload = first.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    await airportCommitStarted.promise;
    const firstDisposal = first.value[Symbol.asyncDispose]();
    const secondReload = second.value.dataManagement.reloadAirport({
      icao: 'CAAA',
      openAipApiKey: 'test-key',
    });
    releaseAirportCommit.resolve();

    await expect(firstReload).resolves.toMatchObject({ok: true});
    await expect(secondReload).resolves.toMatchObject({ok: true});
    await firstDisposal;
    await second.value[Symbol.asyncDispose]();
  } finally {
    releaseAirportCommit.resolve();
    await rm(temporaryDirectory, {recursive: true});
    await rm(aliasDirectory, {recursive: true});
  }
});

async function openApplication(
  databasePath: string,
  listOpenAIPAirports: (request: AirportPageRequest) => Promise<AirportPage>,
  beforeNavaidCommit: () => void | Promise<void> = async () => {},
  beforeAirportCommit: () => void | Promise<void> = async () => {}
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
      listOpenAIPAirports,
      beforeAirportCommit,
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
      beforeNavaidCommit,
    }
  );
}

function airport(id: string, icaoCode: string) {
  return {
    _id: id,
    name: `${icaoCode} Airport`,
    icaoCode,
    geometry: {type: 'Point', coordinates: [-80, 44]},
  };
}

function navaid() {
  return {
    _id: 'ndb-1',
    type: 2,
    identifier: 'ND',
    name: 'Fallback NDB',
    geometry: {type: 'Point', coordinates: [-80, 44]},
    frequency: {value: '365.000', unit: 1},
    range: {value: 45, unit: 2},
  };
}

function nasrCycle() {
  return createSyntheticFAANasrCycle(
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
    {retrievedAt: '2026-07-10T00:00:00.000Z'}
  );
}

function airportPage(
  page: number,
  totalPages: number,
  items: readonly unknown[]
): AirportPage {
  return {page, totalPages, items};
}

async function projectedAirportSnapshot(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const rows = await connection.runAndReadAll(
      `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, database_id
       FROM radial_producer.planner_airports`
    );
    const row = rows.getRowObjectsJS()[0];
    return {
      snapshotId: row?.['snapshot_id'],
      databaseId: row?.['database_id'],
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function projectedAirportDatabaseId(databasePath: string): Promise<{
  cachedId: string | null;
  plannerId: string | null;
}> {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const cached = await connection.runAndReadAll(
      `SELECT database_id FROM radial_producer.cached_airports WHERE icao = 'CAAA'`
    );
    const projected = await connection.runAndReadAll(
      `SELECT database_id FROM planner_airports WHERE icao = 'CAAA'`
    );
    const cachedValue = cached.getRowObjectsJS()[0]?.['database_id'];
    const projectedValue = projected.getRowObjectsJS()[0]?.['database_id'];
    return {
      cachedId: typeof cachedValue === 'string' ? cachedValue : null,
      plannerId: typeof projectedValue === 'string' ? projectedValue : null,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
