import {mkdtemp, realpath, rm, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';

import openRadialApplication from 'radial';
import type RadialApplicationTypes from 'radial/types';
import {expect, test} from 'vitest';

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
