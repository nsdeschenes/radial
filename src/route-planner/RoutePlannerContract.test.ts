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
  {
    name: 'non-finite magnetic model epoch',
    metadata: [
      {
        ...completeMetadata(),
        magneticModelEpochYear: Number.POSITIVE_INFINITY,
      },
    ],
    expectedViolation: 'planner_metadata magnetic reference bundle is invalid',
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

test.each([
  {referenceDate: '2025-07-03', opens: true},
  {referenceDate: '2030-07-03', opens: false},
])(
  'validates reference date $referenceDate against a fractional magnetic-model epoch',
  async ({referenceDate, opens}) => {
    await using database = await syntheticPlannerDatabase.create({
      metadata: [
        {
          magneticModel: 'SYNTHETIC',
          magneticModelVersion: '2025.5',
          magneticModelEpochYear: 2025.5,
          magneticReferenceDate: referenceDate,
          magneticModelSource: 'https://example.test/magnetic-model',
        },
      ],
    });

    const result = await openRoutePlanner({databasePath: database.databasePath});
    if (opens) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        await result.value[Symbol.asyncDispose]();
      }
    } else {
      expect(result).toEqual({
        ok: false,
        failure: {
          code: 'database-contract-invalid',
          violations: [
            'planner_metadata reference date is outside the model validity period',
          ],
        },
      });
    }
  }
);

test('requires complete magnetic metadata when any Local Magnetic Declination exists', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      {
        databaseId: 'airport',
        icao: 'AAAA',
        name: 'Airport',
        longitude: 0,
        latitude: 0,
        magneticDeclinationDegEast: 1,
      },
    ],
  });

  await expect(openRoutePlanner({databasePath: database.databasePath})).resolves.toEqual({
    ok: false,
    failure: {
      code: 'database-contract-invalid',
      violations: ['local magnetic declination requires complete planner_metadata'],
    },
  });
});

test.each([
  {
    name: 'unnormalized Local Magnetic Declination',
    magneticDeclinationDegEast: 180,
    facilityVariationDegEast: null,
    facilityVariationSource: null,
    family: 'VOR',
    violation: 'planner data contains an invalid Local Magnetic Declination',
  },
  {
    name: 'non-finite Local Magnetic Declination',
    magneticDeclinationDegEast: Number.POSITIVE_INFINITY,
    facilityVariationDegEast: null,
    facilityVariationSource: null,
    family: 'VOR',
    violation: 'planner data contains an invalid Local Magnetic Declination',
  },
  {
    name: 'Facility Variation of Record without a source',
    magneticDeclinationDegEast: null,
    facilityVariationDegEast: 3,
    facilityVariationSource: null,
    family: 'VOR',
    violation: 'planner_navaids contains invalid Facility Variation of Record data',
  },
  {
    name: 'non-finite Facility Variation of Record',
    magneticDeclinationDegEast: null,
    facilityVariationDegEast: Number.NEGATIVE_INFINITY,
    facilityVariationSource: 'Synthetic record',
    family: 'VOR',
    violation: 'planner_navaids contains invalid Facility Variation of Record data',
  },
  {
    name: 'Facility Variation source without a variation',
    magneticDeclinationDegEast: null,
    facilityVariationDegEast: null,
    facilityVariationSource: 'Synthetic record',
    family: 'VOR',
    violation: 'planner_navaids contains invalid Facility Variation of Record data',
  },
  {
    name: 'Facility Variation of Record on an NDB',
    magneticDeclinationDegEast: null,
    facilityVariationDegEast: 3,
    facilityVariationSource: 'Synthetic record',
    family: 'NDB',
    violation: 'planner_navaids contains invalid Facility Variation of Record data',
  },
])(
  'rejects $name before route search',
  async ({
    magneticDeclinationDegEast,
    facilityVariationDegEast,
    facilityVariationSource,
    family,
    violation,
  }) => {
    await using database = await syntheticPlannerDatabase.create({
      navaids: [
        {
          databaseId: 'navaid',
          identifier: 'TEST',
          name: 'Test Navaid',
          family,
          longitude: 0,
          latitude: 0,
          frequencyValue: family === 'NDB' ? 365 : 113,
          frequencyUnit: family === 'NDB' ? 'kHz' : 'MHz',
          publishedRangeNm: 40,
          magneticDeclinationDegEast,
          facilityVariationDegEast,
          facilityVariationSource,
        },
      ],
      metadata: [completeMetadata()],
    });

    await expect(
      openRoutePlanner({databasePath: database.databasePath})
    ).resolves.toEqual({
      ok: false,
      failure: {code: 'database-contract-invalid', violations: [violation]},
    });
  }
);

function nullMetadata() {
  return {
    magneticModel: null,
    magneticModelVersion: null,
    magneticModelEpochYear: null,
    magneticReferenceDate: null,
    magneticModelSource: null,
  } as const;
}

function completeMetadata() {
  return {
    magneticModel: 'WMM',
    magneticModelVersion: 'WMM2025',
    magneticModelEpochYear: 2025,
    magneticReferenceDate: '2025-01-01',
    magneticModelSource: 'https://example.test/wmm2025',
  } as const;
}
