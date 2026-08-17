import {expect, test} from 'vitest';

import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test.each([
  {
    name: 'missing metadata',
    metadata: [],
    expectedViolation: 'planner_metadata must contain exactly one row',
  },
  {
    name: 'duplicate metadata',
    metadata: [nullMetadata(), nullMetadata()],
    expectedViolation: 'planner_metadata must contain exactly one row',
  },
  {
    name: 'partial magnetic metadata',
    metadata: [
      {
        magneticModel: 'WMM',
        magneticModelVersion: null,
        magneticModelEpochYear: 2025,
        magneticReferenceDate: '2025-01-01',
        magneticModelSource: 'https://example.test/wmm',
      },
    ],
    expectedViolation:
      'planner_metadata magnetic reference bundle must be all null or complete',
  },
])('rejects $name before route search', async ({metadata, expectedViolation}) => {
  await using database = await syntheticPlannerDatabase.create({metadata});

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: [expectedViolation],
    },
  });
});

test('rejects a missing required planner-ready column before route search', async () => {
  await using database = await syntheticPlannerDatabase.create();
  await syntheticPlannerDatabase.modify(
    database.databasePath,
    `CREATE OR REPLACE VIEW planner_airports AS
      SELECT database_id, icao, name, longitude, latitude,
        magnetic_declination_deg_east
      FROM synthetic_airports`
  );

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: ['planner_airports is missing required column point'],
    },
  });
});

test('rejects geometry whose point ordinates are not longitude/latitude', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      {
        databaseId: 'airport-a',
        icao: 'AAAA',
        name: 'Airport A',
        longitude: -79,
        latitude: 43,
      },
    ],
  });
  await syntheticPlannerDatabase.modify(
    database.databasePath,
    `CREATE OR REPLACE VIEW planner_airports AS
      SELECT database_id, icao, name, longitude, latitude,
        ST_Point(latitude, longitude) AS point,
        magnetic_declination_deg_east
      FROM synthetic_airports`
  );

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: ['planner_airports contains invalid longitude/latitude point geometry'],
    },
  });
});

test('rejects an incompatible required-column type before route search', async () => {
  await using database = await syntheticPlannerDatabase.create();
  await syntheticPlannerDatabase.modify(
    database.databasePath,
    `CREATE OR REPLACE VIEW planner_navaids AS
      SELECT
        * EXCLUDE (frequency_value),
        ST_Point(longitude, latitude) AS point,
        CAST(frequency_value AS VARCHAR) AS frequency_value
      FROM synthetic_navaids`
  );

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: [
        'planner_navaids.frequency_value must have type DOUBLE; received VARCHAR',
      ],
    },
  });
});

test('rejects non-finite Navaid coordinates as invalid geometry before route search', async () => {
  await using database = await syntheticPlannerDatabase.create({
    navaids: [
      {
        databaseId: 'navaid-invalid',
        identifier: 'BAD',
        name: 'Invalid Navaid',
        family: 'VOR',
        longitude: Number.NaN,
        latitude: 0,
        frequencyValue: 113,
        frequencyUnit: 'MHz',
        publishedRangeNm: 40,
      },
    ],
  });

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: ['planner_navaids contains invalid longitude/latitude point geometry'],
    },
  });
});

function nullMetadata() {
  return {
    magneticModel: null,
    magneticModelVersion: null,
    magneticModelEpochYear: null,
    magneticReferenceDate: null,
    magneticModelSource: null,
  } as const;
}
