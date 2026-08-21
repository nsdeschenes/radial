import {mkdtemp, readdir, realpath, rm, stat, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import openRadialApplication from 'radial';
import {expect, test} from 'vitest';

import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';
test('canonicalizes database aliases to one process-scoped identity', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-application-alias-'));
  const databasePath = join(temporaryDirectory, 'planner.duckdb');
  const aliasDirectory = await mkdtemp(join(tmpdir(), 'radial-application-alias-'));
  const aliasPath = join(aliasDirectory, 'planner-alias.duckdb');

  try {
    const bootstrapped = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      bootstrapDependencies(() => {})
    );
    if (!bootstrapped.ok) {
      throw new Error('Expected the bootstrap application to open.');
    }

    const bootstrappedPlanner = await bootstrapped.value.planning.open();
    if (!bootstrappedPlanner.ok) {
      throw new Error('Expected the bootstrap planner to open.');
    }

    await bootstrappedPlanner.value[Symbol.asyncDispose]();
    await bootstrapped.value[Symbol.asyncDispose]();

    await symlink(databasePath, aliasPath);
    const direct = await openRadialApplication({databasePath});
    const aliased = await openRadialApplication({databasePath: aliasPath});
    const relativeAlias = await openRadialApplication({
      databasePath: relative(process.cwd(), databasePath),
    });
    if (!direct.ok || !aliased.ok || !relativeAlias.ok) {
      throw new Error('Expected all database aliases to open.');
    }

    expect(aliased.value.databasePath).toBe(direct.value.databasePath);
    expect(relativeAlias.value.databasePath).toBe(direct.value.databasePath);
    expect(aliased.value.planning).not.toBe(aliased.value.dataManagement);

    await direct.value[Symbol.asyncDispose]();
    await unlink(aliasPath);

    const planner = await aliased.value.planning.open();
    expect(planner.ok).toBe(true);
    if (planner.ok) {
      await planner.value[Symbol.asyncDispose]();
    }

    await relativeAlias.value[Symbol.asyncDispose]();
    await aliased.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
    await rm(aliasDirectory, {recursive: true});
  }
});

test('opening the application does not bootstrap or validate planner storage', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-application-'));
  const databasePath = join(temporaryDirectory, 'missing', 'radial.duckdb');

  try {
    const opened = await openRadialApplication({databasePath});
    if (!opened.ok) {
      throw new Error(`Expected application open to succeed: ${opened.failure.code}`);
    }

    const canonicalDatabasePath = join(
      await realpath(dirname(dirname(databasePath))),
      'missing',
      'radial.duckdb'
    );
    expect(opened.value.databasePath).toBe(canonicalDatabasePath);
    await expect(opened.value.planning.open()).resolves.toEqual({
      ok: false,
      failure: {code: 'database-unavailable', databasePath},
    });
    await opened.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports a missing database as uninitialized without creating storage', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-missing-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const opened = await openRadialApplication({databasePath});
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    await expect(opened.value.dataManagement.status()).resolves.toEqual({
      ok: true,
      value: {
        databasePath: opened.value.databasePath,
        status: 'uninitialized',
        legacyObjects: [],
        producerSchema: null,
        snapshot: null,
        cachedAirports: [],
      },
    });
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
    await opened.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reads existing committed storage without changing it', async () => {
  for (const storageKind of ['empty', 'legacy', 'invalid'] as const) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-existing-'));
    const databasePath = join(temporaryDirectory, `${storageKind}.duckdb`);
    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      if (storageKind === 'legacy') {
        await connection.run('CREATE TABLE navaids (identifier VARCHAR)');
      } else if (storageKind === 'invalid') {
        await connection.run('CREATE SCHEMA radial_producer');
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    try {
      const beforeStatus = await stat(databasePath);
      const opened = await openRadialApplication({databasePath});
      if (!opened.ok) {
        throw new Error('Expected the application to open.');
      }

      const status = await opened.value.dataManagement.status();
      if (storageKind === 'invalid') {
        expect(status).toMatchObject({
          ok: false,
          failure: {code: 'DATA_DATABASE_INVALID', activeDataPreserved: true},
        });
      } else {
        expect(status).toMatchObject({
          ok: true,
          value: {
            status: 'uninitialized',
            legacyObjects: storageKind === 'legacy' ? ['main.navaids'] : [],
          },
        });
      }

      const afterStatus = await stat(databasePath);
      expect({size: afterStatus.size, mtimeMs: afterStatus.mtimeMs}).toEqual({
        size: beforeStatus.size,
        mtimeMs: beforeStatus.mtimeMs,
      });
      const reopenedWritable = await DuckDBInstance.create(databasePath);
      reopenedWritable.closeSync();
      await opened.value[Symbol.asyncDispose]();
    } finally {
      await rm(temporaryDirectory, {recursive: true});
    }
  }
});

test('bootstraps the first Navaid Snapshot when planning opens and reuses it offline', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-application-bootstrap-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  let openAipRequestCount = 0;

  try {
    const opened = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      bootstrapDependencies(() => {
        openAipRequestCount += 1;
      })
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const planner = await opened.value.planning.open();
    expect(planner.ok).toBe(true);
    if (planner.ok) {
      await planner.value[Symbol.asyncDispose]();
    }

    await opened.value[Symbol.asyncDispose]();

    const offline = await openRadialApplication(
      {databasePath},
      {
        createOpenAIPTransport() {
          throw new Error('Planning against a committed snapshot must not use OpenAIP.');
        },
      }
    );
    if (!offline.ok) {
      throw new Error('Expected the committed database to open.');
    }

    const offlinePlanner = await offline.value.planning.open();
    expect(offlinePlanner.ok).toBe(true);
    if (offlinePlanner.ok) {
      await offlinePlanner.value[Symbol.asyncDispose]();
    }

    await offline.value[Symbol.asyncDispose]();

    expect(openAipRequestCount).toBe(1);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('cancels Navaid acquisition before publication without activating a snapshot', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-application-interruption-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const requestStarted = Promise.withResolvers<void>();
  const controller = new AbortController();

  try {
    const opened = await openRadialApplication(
      {databasePath},
      {
        now: () => new Date('2026-07-10T00:00:00.000Z'),
        createOpenAIPTransport: () => async request => {
          requestStarted.resolve();
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('The acquisition was interrupted.');
                error.name = 'AbortError';
                reject(error);
              },
              {once: true}
            );
          });
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const reload = opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
      signal: controller.signal,
    });
    await requestStarted.promise;
    controller.abort();

    await expect(reload).rejects.toMatchObject({name: 'AbortError'});
    await expect(opened.value.dataManagement.status()).resolves.toMatchObject({
      ok: true,
      value: {status: 'uninitialized', snapshot: null, cachedAirports: []},
    });
    await opened.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('concurrent first planners share one Navaid Snapshot bootstrap attempt', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-application-bootstrap-concurrent-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const requestStarted = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();
  let openAipRequestCount = 0;

  try {
    const dependencies = {
      ...bootstrapDependencies(() => {}),
      createOpenAIPTransport() {
        return async () => {
          openAipRequestCount += 1;
          requestStarted.resolve();
          await releaseRequest.promise;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              page: 1,
              limit: 1000,
              totalCount: 1,
              totalPages: 1,
              items: [bootstrapNavaid()],
            }),
          };
        };
      },
    };
    const first = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      dependencies
    );
    const second = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      dependencies
    );
    if (!first.ok || !second.ok) {
      throw new Error('Expected both applications to open.');
    }

    const firstOpening = first.value.planning.open();
    const secondOpening = second.value.planning.open();
    await requestStarted.promise;
    expect(openAipRequestCount).toBe(1);

    releaseRequest.resolve();
    const [firstPlanner, secondPlanner] = await Promise.all([
      firstOpening,
      secondOpening,
    ]);
    expect(firstPlanner.ok).toBe(true);
    expect(secondPlanner.ok).toBe(true);
    if (firstPlanner.ok) {
      await firstPlanner.value[Symbol.asyncDispose]();
    }

    if (secondPlanner.ok) {
      await secondPlanner.value[Symbol.asyncDispose]();
    }

    await first.value[Symbol.asyncDispose]();
    await second.value[Symbol.asyncDispose]();
  } finally {
    releaseRequest.resolve();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports bootstrap failure safely and retries without activating a partial snapshot', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-application-bootstrap-failure-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  let shouldSucceed = false;

  try {
    const opened = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      {
        ...bootstrapDependencies(() => {}),
        createOpenAIPTransport() {
          return async () =>
            shouldSucceed
              ? {
                  status: 200,
                  headers: {},
                  body: JSON.stringify({
                    page: 1,
                    limit: 1000,
                    totalCount: 1,
                    totalPages: 1,
                    items: [bootstrapNavaid()],
                  }),
                }
              : {status: 401, headers: {}, body: 'not exposed'};
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    await expect(opened.value.planning.open()).resolves.toMatchObject({
      ok: false,
      failure: {code: 'DATA_OPENAIP_AUTH', activeDataPreserved: true},
    });

    shouldSucceed = true;
    const retried = await opened.value.planning.open();
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      await retried.value[Symbol.asyncDispose]();
    }

    await opened.value[Symbol.asyncDispose]();

    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      const active = await connection.runAndReadAll(`
        SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS snapshot_id
        FROM radial_producer.producer_state
        WHERE singleton
      `);
      expect(active.getRowObjectsJS()).toHaveLength(1);
      expect(active.getRowObjectsJS()[0]?.['snapshot_id']).not.toBeNull();
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects a missing OpenAIP credential before creating producer storage', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-reload-config-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const opened = await openRadialApplication({databasePath});
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    await expect(
      opened.value.dataManagement.reloadNavaids({openAipApiKey: '  '})
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Navaid reload.',
        action: 'Set OPENAIP_API_KEY and retry the Navaid reload.',
        activeDataPreserved: true,
      },
    });
    await expect(stat(databasePath)).rejects.toMatchObject({code: 'ENOENT'});
    await opened.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('validates Airport reload ICAOs and still requires credentials for a cache hit', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-airport-reload-config-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  let lookupCount = 0;

  try {
    const opened = await openRadialApplication(
      {databasePath},
      {
        listOpenAIPAirports: async ({page}: {page: number}) => {
          lookupCount += 1;
          return {
            page,
            totalPages: 1,
            items: [
              {
                _id: 'airport-caaa',
                name: 'CAAA Airport',
                icaoCode: 'CAAA',
                geometry: {type: 'Point', coordinates: [-80, 44]},
              },
            ],
          };
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    await expect(
      opened.value.dataManagement.reloadAirport({
        icao: ' bad ',
        openAipApiKey: 'test-key',
      })
    ).resolves.toMatchObject({
      ok: false,
      failure: {code: 'DATA_INVALID_ICAO', activeDataPreserved: true},
    });
    await expect(stat(databasePath)).rejects.toMatchObject({code: 'ENOENT'});

    await expect(
      opened.value.dataManagement.reloadAirport({
        icao: ' caaa ',
        openAipApiKey: 'test-key',
      })
    ).resolves.toMatchObject({ok: true, value: {status: 'cached', icao: 'CAAA'}});
    await expect(
      opened.value.dataManagement.reloadAirport({icao: 'CAAA', openAipApiKey: ' '})
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Airport reload.',
        action: 'Set OPENAIP_API_KEY and retry the Airport reload.',
        activeDataPreserved: true,
      },
    });
    expect(lookupCount).toBe(1);
    await opened.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('publishes fresh reload identities and preserves the active snapshot on acquisition failure', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-reload-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const timestamp = '2026-07-10T00:00:00.000Z';
  const navaid = {
    _id: 'ndb-1',
    type: 2,
    identifier: 'ND',
    name: 'Fallback NDB',
    geometry: {type: 'Point', coordinates: [-80, 44]},
    frequency: {value: '365.000', unit: 1},
    range: {value: 45, unit: 2},
  };
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
  let openAipUnavailable = false;

  try {
    const opened = await openRadialApplication(
      {databasePath},
      {
        now: () => new Date(timestamp),
        createOpenAIPTransport: () => async () =>
          openAipUnavailable
            ? {status: 401, headers: {}, body: 'not exposed'}
            : {
                status: 200,
                headers: {},
                body: JSON.stringify({
                  page: 1,
                  limit: 1000,
                  totalCount: 1,
                  totalPages: 1,
                  items: [navaid],
                }),
              },
        async acquireFAANasrCycles() {
          return [nasrCycle];
        },
      }
    );
    if (!opened.ok) {
      throw new Error('Expected the application to open.');
    }

    const first = await opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });
    const second = await opened.value.dataManagement.reloadNavaids({
      openAipApiKey: 'test-key',
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.snapshotId).not.toBe(first.value.snapshotId);
      expect(second.value.snapshotChecksum).toBe(first.value.snapshotChecksum);
      expect(second.value).toMatchObject({
        rawNavaidCount: 1,
        plannerNavaidCount: 1,
        vorFamilyNavaidCount: 0,
        fallbackNavaidCount: 1,
        exclusionCount: 0,
        exclusionCounts: [],
        facilityVariationPresentCount: 0,
        facilityVariationMissingCount: 0,
        facilityVariationEpochYearMissingCount: 0,
      });
    }

    await expect(opened.value.dataManagement.status()).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        snapshot: {snapshotId: second.ok ? second.value.snapshotId : ''},
      },
    });

    openAipUnavailable = true;
    await expect(
      opened.value.dataManagement.reloadNavaids({openAipApiKey: 'test-key'})
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: 'DATA_OPENAIP_AUTH',
        summary: 'OpenAIP Navaid acquisition failed.',
        cause: 'OpenAIP Navaid acquisition did not complete.',
        action: 'Check OpenAIP availability and credentials, then retry.',
        activeDataPreserved: true,
      },
    });
    await opened.value[Symbol.asyncDispose]();

    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    const active = await connection.runAndReadAll(
      `SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS snapshot_id
       FROM radial_producer.producer_state WHERE singleton`
    );
    expect(active.getRowObjectsJS()).toEqual([
      {snapshot_id: second.ok ? second.value.snapshotId : ''},
    ]);
    connection.closeSync();
    instance.closeSync();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('graceful disposal rejects new work while another alias remains usable', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'radial-application-disposal-')
  );
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const first = await openRadialApplication(
      {databasePath, openAipApiKey: 'test-key'},
      bootstrapDependencies(() => {})
    );
    const second = await openRadialApplication({databasePath});
    if (!first.ok || !second.ok) {
      throw new Error('Expected applications to open.');
    }

    const firstPlanner = await first.value.planning.open();
    if (!firstPlanner.ok) {
      throw new Error('Expected first planner to open.');
    }

    const activePlanning = firstPlanner.value.planRoute({
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
    });
    const disposal = first.value[Symbol.asyncDispose]();

    await expect(activePlanning).resolves.toMatchObject({
      ok: false,
      failure: {code: 'airport-not-found', role: 'departure', normalizedIcao: 'AAAA'},
    });
    await disposal;

    await expect(first.value.planning.open()).rejects.toThrow(
      'Cannot start work after the Radial application has been disposed.'
    );
    const planner = await second.value.planning.open();
    expect(planner.ok).toBe(true);
    if (planner.ok) {
      await planner.value[Symbol.asyncDispose]();
    }

    await second.value[Symbol.asyncDispose]();
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

function bootstrapDependencies(onOpenAipRequest: () => void) {
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
    createOpenAIPTransport: () => async () => {
      onOpenAipRequest();
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          page: 1,
          limit: 1000,
          totalCount: 1,
          totalPages: 1,
          items: [bootstrapNavaid()],
        }),
      };
    },
    async listOpenAIPAirports({page}: {page: number}) {
      return {page, totalPages: 1, items: []};
    },
    async acquireFAANasrCycles() {
      return [nasrCycle];
    },
  };
}

function bootstrapNavaid() {
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
