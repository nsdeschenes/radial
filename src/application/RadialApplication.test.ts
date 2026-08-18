import {mkdtemp, realpath, rm, stat, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import openRadialApplication from 'radial';
import type RadialApplicationTypes from 'radial/types';
import {expect, test} from 'vitest';

import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test('canonicalizes database aliases to one process-scoped identity', async () => {
  await using database = await syntheticPlannerDatabase.create();
  const directConfig: RadialApplicationTypes['ApplicationConfig'] = {
    databasePath: database.databasePath,
  };
  const aliasDirectory = await mkdtemp(join(tmpdir(), 'radial-application-alias-'));
  const aliasPath = join(aliasDirectory, 'planner-alias.duckdb');
  await symlink(database.databasePath, aliasPath);

  try {
    const direct = await openRadialApplication(directConfig);
    const aliased = await openRadialApplication({databasePath: aliasPath});
    const relativeAlias = await openRadialApplication({
      databasePath: relative(process.cwd(), database.databasePath),
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
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      {
        databaseId: 'departure',
        icao: 'AAAA',
        name: 'Departure',
        longitude: 0,
        latitude: 0,
      },
      {
        databaseId: 'arrival',
        icao: 'BBBB',
        name: 'Arrival',
        longitude: 2,
        latitude: 0,
      },
    ],
    navaids: [
      {
        databaseId: 'navaid',
        identifier: 'MID',
        name: 'Middle VOR',
        family: 'VOR',
        longitude: 1,
        latitude: 0,
        frequencyValue: 113,
        frequencyUnit: 'MHz',
        publishedRangeNm: 70,
      },
    ],
  });
  const first = await openRadialApplication({databasePath: database.databasePath});
  const second = await openRadialApplication({databasePath: database.databasePath});
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

  await expect(activePlanning).resolves.toMatchObject({ok: true});
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
});
