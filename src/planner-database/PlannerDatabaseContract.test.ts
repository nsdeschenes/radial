import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test('accepts compatible planner relations and interprets their metadata', async () => {
  await using database = await syntheticPlannerDatabase.create({
    metadata: [
      {
        magneticModel: 'WMM',
        magneticModelVersion: '2025',
        magneticModelEpochYear: 2025,
        magneticReferenceDate: '2025-01-01',
        magneticModelSource: 'https://example.test/wmm',
      },
    ],
  });

  await expect(validateDatabase(database.databasePath)).resolves.toEqual({
    ok: true,
    metadata: {
      model: 'WMM',
      version: '2025',
      epochYear: 2025,
      referenceDate: '2025-01-01',
      source: 'https://example.test/wmm',
    },
  });
});

test('accepts an additive compatible table in place of a canonical view', async () => {
  await using database = await syntheticPlannerDatabase.create();
  await syntheticPlannerDatabase.modify(
    database.databasePath,
    `CREATE TABLE compatible_airports AS SELECT *, 47 AS producer_extension
      FROM main.planner_airports;
    DROP VIEW main.planner_airports;
    ALTER TABLE compatible_airports RENAME TO planner_airports;`
  );

  await expect(validateDatabase(database.databasePath)).resolves.toEqual({
    ok: true,
    metadata: null,
  });
});

test('rejects a noncanonical Airport ICAO as non-planner-ready data', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      {
        databaseId: 'airport',
        icao: ' aaaa ',
        name: 'Airport',
        longitude: 0,
        latitude: 0,
      },
    ],
  });

  await expect(validateDatabase(database.databasePath)).resolves.toEqual({
    ok: false,
    violations: ['planner_airports contains invalid planner-ready identity data'],
  });
});

test('rejects duplicate planner identities before a query interprets them', async () => {
  await using database = await syntheticPlannerDatabase.create({
    navaids: [
      syntheticNavaid('duplicate', 'FIRST'),
      syntheticNavaid('duplicate', 'SECOND'),
    ],
  });

  await expect(validateDatabase(database.databasePath)).resolves.toEqual({
    ok: false,
    violations: ['planner_navaids contains duplicate planner-ready identity data'],
  });
});

test('rejects a Navaid whose family and frequency representation disagree', async () => {
  await using database = await syntheticPlannerDatabase.create({
    navaids: [
      {
        ...syntheticNavaid('ndb', 'NDB'),
        family: 'NDB',
        frequencyValue: 365.5,
        frequencyUnit: 'kHz',
      },
    ],
  });

  await expect(validateDatabase(database.databasePath)).resolves.toEqual({
    ok: false,
    violations: ['planner_navaids contains invalid planner-ready navigation data'],
  });
});

test('strictly interprets contract rows without JavaScript coercion', () => {
  expect(() =>
    plannerDatabaseContract.decodeAirport({
      database_id: undefined,
      icao: 'AAAA',
      name: 'Airport',
      longitude: 0,
      latitude: 0,
      magnetic_declination_deg_east: null,
    })
  ).toThrow('Planner Database Contract invalid-field: database_id');
});

async function validateDatabase(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    await connection.run('SET geometry_always_xy = true');
    return await plannerDatabaseContract.validate(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function syntheticNavaid(databaseId: string, identifier: string) {
  return {
    databaseId,
    identifier,
    name: identifier,
    family: 'VOR',
    longitude: 0,
    latitude: 0,
    frequencyValue: 113,
    frequencyUnit: 'MHz',
    publishedRangeNm: 40,
  };
}
