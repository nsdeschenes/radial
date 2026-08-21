import {mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test, vi} from 'vitest';

import sharedDuckDBRuntime from '#radial/application/internal/SharedDuckDBRuntime.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

type AirportPageRequest = Readonly<{search: string; page: number}>;
type AirportPage = Readonly<{
  page: number;
  totalPages: number;
  items: readonly unknown[];
}>;

test('acquires a lazy operation-shaped lease and creates a fresh core after disposal', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-runtime-lazy-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const lease = await sharedDuckDBRuntime.acquire(runtimeConfig(databasePath));
    expect(lease).not.toHaveProperty('instance');
    expect(lease).not.toHaveProperty('airportResolutionCoordinator');
    expect(lease).not.toHaveProperty('navaidOperationCoordinator');
    expect(lease).not.toHaveProperty('publicationGate');
    await expect(stat(databasePath)).rejects.toMatchObject({code: 'ENOENT'});

    await lease[Symbol.asyncDispose]();
    await expect(lease.status()).rejects.toThrow(
      'Cannot start work after the Radial application has been disposed.'
    );

    const reopened = await sharedDuckDBRuntime.acquire(runtimeConfig(databasePath));
    await expect(reopened.status()).resolves.toMatchObject({
      ok: true,
      value: {status: 'uninitialized'},
    });
    await expect(stat(databasePath)).rejects.toMatchObject({code: 'ENOENT'});
    await reopened[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('keeps fresh in-memory status lazy and reuses the persistent instance once created', async () => {
  const createInstance = vi.spyOn(DuckDBInstance, 'create');
  const lease = await sharedDuckDBRuntime.acquire(
    runtimeConfig(':memory:'),
    producerDependencies(async request => airportPage(request.page, 0, []))
  );

  try {
    await expect(lease.status()).resolves.toMatchObject({
      ok: true,
      value: {status: 'uninitialized'},
    });
    expect(createInstance).not.toHaveBeenCalled();

    await expect(lease.reloadNavaids({openAipApiKey: 'test-key'})).resolves.toMatchObject(
      {ok: true}
    );
    expect(createInstance).toHaveBeenCalledTimes(1);

    await expect(lease.status()).resolves.toMatchObject({
      ok: true,
      value: {status: 'ready'},
    });
    expect(createInstance).toHaveBeenCalledTimes(1);
  } finally {
    await lease[Symbol.asyncDispose]();
    createInstance.mockRestore();
  }
});

test('orders temporary read-only inspection with first persistent creation in either order', async () => {
  for (const firstOperation of ['status', 'reload'] as const) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-runtime-open-'));
    const databasePath = join(temporaryDirectory, 'radial.duckdb');
    const preparationInstance = await DuckDBInstance.create(databasePath);
    preparationInstance.closeSync();
    const originalCreate = DuckDBInstance.create.bind(DuckDBInstance);
    const firstCreationStarted = Promise.withResolvers<void>();
    const releaseFirstCreation = Promise.withResolvers<void>();
    const accessModes: string[] = [];
    const createInstance = vi
      .spyOn(DuckDBInstance, 'create')
      .mockImplementation(async (path, options) => {
        accessModes.push(options?.['access_mode'] ?? 'READ_WRITE');
        if (accessModes.length === 1) {
          firstCreationStarted.resolve();
          await releaseFirstCreation.promise;
        }

        return originalCreate(path, options);
      });
    const lease = await sharedDuckDBRuntime.acquire(
      runtimeConfig(databasePath),
      producerDependencies(async request => airportPage(request.page, 0, []))
    );

    try {
      const status =
        firstOperation === 'status' ? lease.status() : Promise.resolve(undefined);
      const reload =
        firstOperation === 'reload'
          ? lease.reloadNavaids({openAipApiKey: 'test-key'})
          : Promise.resolve(undefined);
      await firstCreationStarted.promise;
      const secondOperation =
        firstOperation === 'status'
          ? lease.reloadNavaids({openAipApiKey: 'test-key'})
          : lease.status();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(accessModes).toEqual([
        firstOperation === 'status' ? 'READ_ONLY' : 'READ_WRITE',
      ]);

      releaseFirstCreation.resolve();
      const [statusResult, reloadResult, secondResult] = await Promise.all([
        status,
        reload,
        secondOperation,
      ]);
      const completedStatus = firstOperation === 'status' ? statusResult : secondResult;
      const completedReload = firstOperation === 'reload' ? reloadResult : secondResult;
      expect(completedStatus).toMatchObject({ok: true});
      expect(completedReload).toMatchObject({ok: true});
      expect(accessModes).toEqual(
        firstOperation === 'status' ? ['READ_ONLY', 'READ_WRITE'] : ['READ_WRITE']
      );
    } finally {
      releaseFirstCreation.resolve();
      await lease[Symbol.asyncDispose]();
      createInstance.mockRestore();
      await rm(temporaryDirectory, {recursive: true});
    }
  }
});

test('retries persistent instance creation after an open failure', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-runtime-retry-'));
  const databaseDirectory = join(temporaryDirectory, 'missing');
  const databasePath = join(databaseDirectory, 'radial.duckdb');
  const lease = await sharedDuckDBRuntime.acquire(
    runtimeConfig(databasePath),
    producerDependencies(async request => airportPage(request.page, 0, []))
  );

  try {
    await expect(lease.openPlanning()).resolves.toMatchObject({
      ok: false,
      failure: {code: 'database-unavailable'},
    });
    await mkdir(databaseDirectory);

    const retried = await lease.openPlanning();
    expect(retried).toMatchObject({ok: true});
    if (retried.ok) {
      await retried.value[Symbol.asyncDispose]();
    }
  } finally {
    await lease[Symbol.asyncDispose]();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('disposes child planners with their owning lease', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-runtime-planner-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const lease = await sharedDuckDBRuntime.acquire(
    runtimeConfig(databasePath),
    producerDependencies(async request => airportPage(request.page, 0, []))
  );

  try {
    const opened = await lease.openPlanning();
    if (!opened.ok) {
      throw new Error('Expected the runtime planner to open.');
    }

    await lease[Symbol.asyncDispose]();
    await expect(
      opened.value.planRoute({departureIcao: 'CAAA', arrivalIcao: 'CBBB'})
    ).rejects.toThrow('Cannot plan a route after the Route Planner has been disposed.');
  } finally {
    await lease[Symbol.asyncDispose]();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('retries same-ICAO Airport resolution with the waiting lease configuration', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-runtime-airport-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const firstLookupStarted = Promise.withResolvers<void>();
  const releaseFirstLookup = Promise.withResolvers<void>();
  const secondLeaseSearches: string[] = [];
  const firstLease = await sharedDuckDBRuntime.acquire(
    runtimeConfig(databasePath),
    producerDependencies(async request => {
      if (request.search === 'CAAA') {
        firstLookupStarted.resolve();
        await releaseFirstLookup.promise;
        throw new Error('First lease source unavailable.');
      }

      return airportPage(request.page, 0, []);
    })
  );
  const secondLease = await sharedDuckDBRuntime.acquire(
    runtimeConfig(databasePath),
    producerDependencies(async request => {
      secondLeaseSearches.push(request.search);
      return airportPage(request.page, 1, [airport(request.search)]);
    })
  );

  try {
    const firstOpened = await firstLease.openPlanning();
    const secondOpened = await secondLease.openPlanning();
    if (!firstOpened.ok || !secondOpened.ok) {
      throw new Error('Expected both runtime planners to open.');
    }

    const firstPlan = firstOpened.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
    });
    await firstLookupStarted.promise;
    const secondPlan = secondOpened.value.planRoute({
      departureIcao: 'CAAA',
      arrivalIcao: 'CBBB',
    });
    releaseFirstLookup.resolve();

    await expect(firstPlan).resolves.toMatchObject({
      ok: false,
      failure: {
        code: 'airport-resolution-failed',
        role: 'departure',
        normalizedIcao: 'CAAA',
        reason: 'source-unavailable',
      },
    });
    await expect(secondPlan).resolves.not.toMatchObject({
      failure: {code: 'airport-resolution-failed'},
    });
    expect(secondLeaseSearches).toEqual(['CAAA', 'CBBB']);

    await firstOpened.value[Symbol.asyncDispose]();
    await secondOpened.value[Symbol.asyncDispose]();
  } finally {
    releaseFirstLookup.resolve();
    await firstLease[Symbol.asyncDispose]();
    await secondLease[Symbol.asyncDispose]();
    await rm(temporaryDirectory, {recursive: true});
  }
});

function runtimeConfig(databasePath: string) {
  return {
    configuredDatabasePath: databasePath,
    maxRouteFactor: 2,
    openAipApiKey: 'test-key',
  };
}

function producerDependencies(
  listOpenAIPAirports: (request: AirportPageRequest) => Promise<AirportPage>
) {
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
  return {
    now: () => new Date(timestamp),
    listOpenAIPAirports,
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
  };
}

function airport(icaoCode: string) {
  return {
    _id: `airport-${icaoCode}`,
    name: `${icaoCode} Airport`,
    icaoCode,
    geometry: {type: 'Point', coordinates: [-80, 44]},
  };
}

function airportPage(
  page: number,
  totalPages: number,
  items: readonly unknown[]
): AirportPage {
  return {page, totalPages, items};
}
