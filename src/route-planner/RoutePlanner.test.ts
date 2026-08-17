import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test.each([
  {
    config: {databasePath: ''},
    failure: {
      code: 'invalid-configuration',
      field: 'databasePath',
      reason: 'required',
      value: '',
    },
  },
  {
    config: {databasePath: ':memory:', maxRouteFactor: Number.NaN},
    failure: {
      code: 'invalid-configuration',
      field: 'maxRouteFactor',
      reason: 'must-be-finite-and-at-least-one',
      value: Number.NaN,
    },
  },
  {
    config: {databasePath: ':memory:', maxRouteFactor: 0.99},
    failure: {
      code: 'invalid-configuration',
      field: 'maxRouteFactor',
      reason: 'must-be-finite-and-at-least-one',
      value: 0.99,
    },
  },
])(
  'rejects invalid planner configuration as a structured failure',
  async ({config, failure}) => {
    await expect(openRoutePlanner(config)).resolves.toEqual({
      ok: false,
      failure,
    });
  }
);

test('rejects a database path that does not identify an existing file', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-planner-'));
  const databasePath = join(temporaryDirectory, 'missing.duckdb');

  try {
    const opened = await openRoutePlanner({databasePath});

    if (opened.ok) {
      await opened.value[Symbol.asyncDispose]();
    }

    expect(opened).toEqual({
      ok: false,
      failure: {code: 'database-unavailable', databasePath},
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test.each([
  {
    request: {departureIcao: ' YYZ ', arrivalIcao: 'CYOW'},
    failure: {
      code: 'invalid-request',
      field: 'departureIcao',
      reason: 'invalid-icao',
      value: ' YYZ ',
      normalizedIcao: 'YYZ',
    },
  },
  {
    request: {departureIcao: 'ÇYYZ', arrivalIcao: 'CYOW'},
    failure: {
      code: 'invalid-request',
      field: 'departureIcao',
      reason: 'invalid-icao',
      value: 'ÇYYZ',
      normalizedIcao: 'ÇYYZ',
    },
  },
  {
    request: {departureIcao: 'cyyz', arrivalIcao: ' CYYZ '},
    failure: {
      code: 'invalid-request',
      field: 'arrivalIcao',
      reason: 'identical-airports',
      value: ' CYYZ ',
      normalizedIcao: 'CYYZ',
    },
  },
])(
  'normalizes and rejects invalid route requests through the public boundary',
  async ({request, failure}) => {
    await using database = await syntheticPlannerDatabase.create();
    const opened = await openRoutePlanner({databasePath: database.databasePath});

    if (!opened.ok) {
      throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
    }

    await expect(opened.value.planRoute(request)).resolves.toEqual({ok: false, failure});
    await opened.value[Symbol.asyncDispose]();
  }
);

test('plans a complete two-leg Route Plan using a VOR-family Navaid from a fresh synthetic database', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      {
        databaseId: 'airport-departure',
        icao: 'AAAA',
        name: 'Departure Airport',
        longitude: 0,
        latitude: 0,
        magneticDeclinationDegEast: 5,
      },
      {
        databaseId: 'airport-arrival',
        icao: 'BBBB',
        name: 'Arrival Airport',
        longitude: 30,
        latitude: 35,
        magneticDeclinationDegEast: -2,
      },
    ],
    navaids: [
      {
        databaseId: 'navaid-vor',
        identifier: 'MID',
        name: 'Middle VOR/DME',
        family: 'VOR-DME',
        longitude: 10,
        latitude: 20,
        frequencyValue: 113.7,
        frequencyUnit: 'MHz',
        publishedRangeNm: 1_500,
        magneticDeclinationDegEast: 3,
        facilityVariationDegEast: 7,
        facilityVariationSource: 'Synthetic chart',
        facilityVariationEffectiveDate: '2025-01-01',
      },
    ],
    metadata: [
      {
        magneticModel: 'WMM',
        magneticModelVersion: 'WMM2025',
        magneticModelEpochYear: 2025,
        magneticReferenceDate: '2025-01-01',
        magneticModelSource: 'https://example.test/wmm2025',
      },
    ],
  });
  const opened = await openRoutePlanner({databasePath: database.databasePath});

  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  const result = await opened.value.planRoute({
    departureIcao: ' aaaa ',
    arrivalIcao: 'bbbb',
  });
  await opened.value[Symbol.asyncDispose]();

  expect(result).toEqual({
    ok: true,
    value: {
      warnings: [],
      plan: {
        totalDistanceNm: 2726.7400455011434,
        searchMode: 'vor-family',
        magneticReference: {
          model: 'WMM',
          version: 'WMM2025',
          epochYear: 2025,
          referenceDate: '2025-01-01',
          source: 'https://example.test/wmm2025',
        },
        routePoints: [
          {
            kind: 'airport',
            databaseId: 'airport-departure',
            icao: 'AAAA',
            name: 'Departure Airport',
            longitude: 0,
            latitude: 0,
            magneticDeclinationDegEast: 5,
          },
          {
            kind: 'vor-family',
            databaseId: 'navaid-vor',
            identifier: 'MID',
            name: 'Middle VOR/DME',
            family: 'VOR-DME',
            longitude: 10,
            latitude: 20,
            frequency: {unit: 'MHz', value: 113.7},
            publishedRangeNm: 1_500,
            magneticDeclinationDegEast: 3,
            facilityVariation: {
              degreesEast: 7,
              source: 'Synthetic chart',
              effectiveDate: '2025-01-01',
            },
          },
          {
            kind: 'airport',
            databaseId: 'airport-arrival',
            icao: 'BBBB',
            name: 'Arrival Airport',
            longitude: 30,
            latitude: 35,
            magneticDeclinationDegEast: -2,
          },
        ],
        routeLegs: [
          {
            departure: {
              kind: 'airport',
              databaseId: 'airport-departure',
              icao: 'AAAA',
              name: 'Departure Airport',
              longitude: 0,
              latitude: 0,
              magneticDeclinationDegEast: 5,
            },
            arrival: {
              kind: 'vor-family',
              databaseId: 'navaid-vor',
              identifier: 'MID',
              name: 'Middle VOR/DME',
              family: 'VOR-DME',
              longitude: 10,
              latitude: 20,
              frequency: {unit: 'MHz', value: 113.7},
              publishedRangeNm: 1_500,
              magneticDeclinationDegEast: 3,
              facilityVariation: {
                degreesEast: 7,
                source: 'Synthetic chart',
                effectiveDate: '2025-01-01',
              },
            },
            distanceNm: 1337.025599687342,
            departureTrueCourseDeg: 25.505550260982545,
            arrivalTrueCourseDeg: 27.273169556803623,
            departureMagneticCourseDeg: 20.505550260982545,
            arrivalMagneticCourseDeg: 24.273169556803623,
            departureVorGuidance: null,
            arrivalVorGuidance: {
              trueCourseDeg: 27.273169556803623,
              magneticCourseDeg: 20.273169556803623,
            },
          },
          {
            departure: {
              kind: 'vor-family',
              databaseId: 'navaid-vor',
              identifier: 'MID',
              name: 'Middle VOR/DME',
              family: 'VOR-DME',
              longitude: 10,
              latitude: 20,
              frequency: {unit: 'MHz', value: 113.7},
              publishedRangeNm: 1_500,
              magneticDeclinationDegEast: 3,
              facilityVariation: {
                degreesEast: 7,
                source: 'Synthetic chart',
                effectiveDate: '2025-01-01',
              },
            },
            arrival: {
              kind: 'airport',
              databaseId: 'airport-arrival',
              icao: 'BBBB',
              name: 'Arrival Airport',
              longitude: 30,
              latitude: 35,
              magneticDeclinationDegEast: -2,
            },
            distanceNm: 1389.7144458138014,
            departureTrueCourseDeg: 45.4587990142586,
            arrivalTrueCourseDeg: 54.84813745171772,
            departureMagneticCourseDeg: 42.4587990142586,
            arrivalMagneticCourseDeg: 56.84813745171772,
            departureVorGuidance: {
              trueCourseDeg: 45.4587990142586,
              magneticCourseDeg: 38.4587990142586,
            },
            arrivalVorGuidance: null,
          },
        ],
      },
    },
  });
});

test.each([
  {
    name: 'missing departure',
    airports: [syntheticAirport('arrival', 'BBBB', 2)],
    failure: {code: 'airport-not-found', role: 'departure', normalizedIcao: 'AAAA'},
  },
  {
    name: 'ambiguous normalized departure',
    airports: [
      syntheticAirport('departure-1', 'AAAA', 0),
      syntheticAirport('departure-2', ' aaaa ', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    failure: {code: 'airport-ambiguous', role: 'departure', normalizedIcao: 'AAAA'},
  },
])('returns a structured failure for $name', async ({airports, failure}) => {
  await using database = await syntheticPlannerDatabase.create({airports});
  const opened = await openRoutePlanner({databasePath: database.databasePath});
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  await expect(
    opened.value.planRoute({departureIcao: ' aaaa ', arrivalIcao: 'bbbb'})
  ).resolves.toEqual({ok: false, failure});
  await opened.value[Symbol.asyncDispose]();
});

test('filters ineligible facilities and never creates an airport-to-airport Route Leg', async () => {
  const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    navaids: [
      syntheticNavaid('dme', 'DME', 'DME', 1, oneDegreeNm),
      syntheticNavaid('tacan', 'TCN', 'TACAN', 1, oneDegreeNm),
      {...syntheticNavaid('blank-id', 'BAD', 'VOR', 1, oneDegreeNm), databaseId: ''},
      {...syntheticNavaid('blank-identifier', '', 'VOR', 1, oneDegreeNm)},
      {
        ...syntheticNavaid('wrong-frequency', 'WRG', 'VOR', 1, oneDegreeNm),
        frequencyUnit: 'kHz',
      },
      {
        ...syntheticNavaid('nan-frequency', 'NAN', 'VOR', 1, oneDegreeNm),
        frequencyValue: Number.NaN,
      },
      {
        ...syntheticNavaid('infinite-frequency', 'INF', 'VOR', 1, oneDegreeNm),
        frequencyValue: Number.POSITIVE_INFINITY,
      },
      {
        ...syntheticNavaid('zero-frequency', 'ZRO', 'VOR', 1, oneDegreeNm),
        frequencyValue: 0,
      },
      {
        ...syntheticNavaid('negative-frequency', 'NEG', 'VOR', 1, oneDegreeNm),
        frequencyValue: -1,
      },
      {
        ...syntheticNavaid('zero-range', 'ZER', 'VOR', 1, oneDegreeNm),
        publishedRangeNm: 0,
      },
    ],
  });
  const opened = await openRoutePlanner({databasePath: database.databasePath});
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  const result = await opened.value.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });
  await opened.value[Symbol.asyncDispose]();

  expect(result).toEqual({
    ok: false,
    failure: {
      code: 'no-route',
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
      maxRouteFactor: 1.5,
      completedSearchLimits: [1.1, 1.25, 1.5],
    },
  });
});

test.each(['VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC'])(
  'admits an eligible %s facility into a Route Plan using VOR-family Navaids',
  async family => {
    const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
    await using database = await syntheticPlannerDatabase.create({
      airports: [
        syntheticAirport('departure', 'AAAA', 0),
        syntheticAirport('arrival', 'BBBB', 2),
      ],
      navaids: [syntheticNavaid('vor', family, family, 1, oneDegreeNm)],
    });
    const opened = await openRoutePlanner({databasePath: database.databasePath});
    if (!opened.ok) {
      throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
    }

    const result = await opened.value.planRoute({
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
    });
    await opened.value[Symbol.asyncDispose]();

    if (!result.ok) {
      throw new Error(
        `Expected a Route Plan using a ${family} Navaid: ${result.failure.code}`
      );
    }
    expect(result.value.plan.searchMode).toBe('vor-family');
    expect(result.value.plan.routePoints[1]).toMatchObject({kind: 'vor-family', family});
  }
);

test.each([
  {name: 'exactly at range', rangeAdjustmentNm: 0, succeeds: true},
  {name: 'just outside range', rangeAdjustmentNm: -1e-12, succeeds: false},
])(
  'makes an airport–VOR-family Navaid Route Leg navigable at the inclusive published coverage boundary: $name',
  async ({rangeAdjustmentNm, succeeds}) => {
    const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
    await using database = await syntheticPlannerDatabase.create({
      airports: [
        syntheticAirport('departure', 'AAAA', 0),
        syntheticAirport('arrival', 'BBBB', 2),
      ],
      navaids: [syntheticNavaid('vor', 'VOR', 'VOR', 1, oneDegreeNm + rangeAdjustmentNm)],
    });
    const opened = await openRoutePlanner({databasePath: database.databasePath});
    if (!opened.ok) {
      throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
    }

    const result = await opened.value.planRoute({
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
    });
    await opened.value[Symbol.asyncDispose]();

    expect(result.ok).toBe(succeeds);
    if (result.ok) {
      expect(result.value.plan.routeLegs).toHaveLength(2);
      expect(result.value.plan.routeLegs[0]?.distanceNm).toBe(oneDegreeNm);
      expect(result.value.plan.routeLegs[1]?.distanceNm).toBe(oneDegreeNm);
    } else {
      expect(result.failure.code).toBe('no-route');
    }
  }
);

function syntheticAirport(databaseId: string, icao: string, longitude: number) {
  return {
    databaseId,
    icao,
    name: `Airport ${databaseId}`,
    longitude,
    latitude: 0,
  } as const;
}

function syntheticNavaid(
  databaseId: string,
  identifier: string,
  family: string,
  longitude: number,
  publishedRangeNm: number
) {
  return {
    databaseId,
    identifier,
    name: `Navaid ${databaseId}`,
    family,
    longitude,
    latitude: 0,
    frequencyValue: 113,
    frequencyUnit: 'MHz',
    publishedRangeNm,
  } as const;
}
