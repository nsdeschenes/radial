import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';
import deterministicPermutation from '#radial/test/deterministicPermutation.js';
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

test('returns the same continuous multi-Navaid Route Plan for ten database row permutations and an irrelevant candidate', async () => {
  const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
  const airports = [
    syntheticAirport('departure', 'AAAA', 0),
    syntheticAirport('arrival', 'BBBB', 4),
  ];
  const routeNavaids = [
    syntheticNavaid('navaid-a', 'ALFA', 'VOR', 1, oneDegreeNm + 1),
    syntheticNavaid('navaid-b', 'BRAVO', 'VOR', 3, oneDegreeNm + 1),
  ];
  const irrelevantNavaids = [
    syntheticNavaid('navaid-x', 'XRAY', 'VOR', 50, 1),
    syntheticNavaid('navaid-y', 'YANKEE', 'VOR', 60, 1),
    syntheticNavaid('navaid-z', 'ZULU', 'VOR', 70, 1),
  ];
  let expected:
    | Awaited<ReturnType<RoutePlannerTypes['RoutePlanner']['planRoute']>>
    | undefined;

  for (let permutation = 0; permutation < 10; permutation += 1) {
    await using database = await syntheticPlannerDatabase.create({
      airports: deterministicPermutation(airports, permutation),
      navaids: deterministicPermutation(
        [...routeNavaids, ...irrelevantNavaids],
        permutation
      ),
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

    if (expected === undefined) {
      expected = result;
    } else {
      expect(result).toEqual(expected);
    }
  }

  if (expected === undefined || !expected.ok) {
    throw new Error('Expected a deterministic multi-Navaid Route Plan.');
  }
  const {plan} = expected.value;
  expect(plan.routePoints.map(routePoint => routePoint.databaseId)).toEqual([
    'departure',
    'navaid-a',
    'navaid-b',
    'arrival',
  ]);
  expect(plan.routeLegs).toHaveLength(3);
  for (const routeLeg of plan.routeLegs) {
    if (
      routeLeg.departure.kind === 'vor-family' &&
      routeLeg.arrival.kind === 'vor-family'
    ) {
      expect(routeLeg.distanceNm).toBeLessThanOrEqual(
        routeLeg.departure.publishedRangeNm + routeLeg.arrival.publishedRangeNm
      );
    } else {
      const navaid =
        routeLeg.departure.kind === 'vor-family'
          ? routeLeg.departure
          : routeLeg.arrival.kind === 'vor-family'
            ? routeLeg.arrival
            : undefined;
      if (navaid === undefined) {
        throw new Error('Expected every Route Leg to include a Navaid.');
      }
      expect(routeLeg.distanceNm).toBeLessThanOrEqual(navaid.publishedRangeNm);
    }
  }
  for (let index = 0; index < plan.routeLegs.length - 1; index += 1) {
    expect(plan.routeLegs[index]?.arrival).toEqual(plan.routeLegs[index + 1]?.departure);
  }
  expect(plan.totalDistanceNm).toBe(
    plan.routeLegs.reduce((total, routeLeg) => total + routeLeg.distanceNm, 0)
  );
  expect(plan.totalDistanceNm).toBeLessThanOrEqual(oneDegreeNm * 4 * 1.5);

  await using databaseWithoutIrrelevantCandidate = await syntheticPlannerDatabase.create({
    airports,
    navaids: routeNavaids,
  });
  const openedWithoutIrrelevantCandidate = await openRoutePlanner({
    databasePath: databaseWithoutIrrelevantCandidate.databasePath,
  });
  if (!openedWithoutIrrelevantCandidate.ok) {
    throw new Error('Expected the comparison synthetic database to open.');
  }
  const resultWithoutIrrelevantCandidate =
    await openedWithoutIrrelevantCandidate.value.planRoute({
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
    });
  await openedWithoutIrrelevantCandidate.value[Symbol.asyncDispose]();
  expect(resultWithoutIrrelevantCandidate).toEqual(expected);
}, 15_000);

test('replaces an early provisional Route Plan after completing its improving ellipse', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 10),
    ],
    navaids: [
      syntheticNavaid('early-first', 'EARLY-A', 'VOR', 3, 250, 2),
      syntheticNavaid('early-second', 'EARLY-B', 'VOR', 7, 250, -2),
      syntheticNavaid('later-shortcut', 'LATER', 'VOR', 7, 250, 2.4),
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

  if (!result.ok) {
    throw new Error(
      `Expected the provisional Route Plan to improve: ${result.failure.code}`
    );
  }
  expect(result.value.plan.routePoints.map(routePoint => routePoint.databaseId)).toEqual([
    'departure',
    'early-first',
    'later-shortcut',
    'arrival',
  ]);
});

test.each([
  {name: 'inclusive 1.10 boundary', navaidLongitude: 10.5, succeeds: true},
  {name: 'inclusive 1.25 boundary', navaidLongitude: 11.25, succeeds: true},
  {name: 'inclusive 1.50 boundary', navaidLongitude: 12.5, succeeds: true},
  {
    name: 'immediately outside the completed 1.50 ellipse',
    navaidLongitude: 12.5 + 1e-12,
    succeeds: false,
  },
])(
  'discovers a VOR-family candidate at the $name',
  async ({navaidLongitude, succeeds}) => {
    const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
    await using database = await syntheticPlannerDatabase.create({
      airports: [
        syntheticAirport('departure', 'AAAA', 0),
        syntheticAirport('arrival', 'BBBB', 10),
      ],
      navaids: [
        syntheticNavaid(
          'candidate',
          'CANDIDATE',
          'VOR',
          navaidLongitude,
          oneDegreeNm * 13
        ),
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

    expect(result.ok).toBe(succeeds);
    if (result.ok) {
      expect(
        result.value.plan.routePoints.map(routePoint => routePoint.databaseId)
      ).toEqual(['departure', 'candidate', 'arrival']);
    }
  }
);

test('discovers a VOR-family candidate across the antimeridian', async () => {
  const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 179),
      syntheticAirport('arrival', 'BBBB', -179),
    ],
    navaids: [syntheticNavaid('dateline', 'DATE', 'VOR', 180, oneDegreeNm + 1)],
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
    throw new Error(`Expected an antimeridian Route Plan: ${result.failure.code}`);
  }
  expect(result.value.plan.routePoints.map(routePoint => routePoint.databaseId)).toEqual([
    'departure',
    'dateline',
    'arrival',
  ]);
});

test('keeps the completed VOR-family Route Plan when an NDB Route Plan would be shorter', async () => {
  const airports = [
    syntheticAirport('departure', 'AAAA', 0),
    syntheticAirport('arrival', 'BBBB', 4),
  ];
  const vorFamilyNavaids = [
    syntheticNavaid('vor-first', 'VOR-A', 'VOR', 1, 100, 1),
    syntheticNavaid('vor-second', 'VOR-B', 'VOR', 3, 100, 1),
  ];
  const ndb = syntheticNdb('ndb-shortcut', 'NDB', 2, 125);

  const resultWithoutNdb = await planSyntheticRoute({
    airports,
    navaids: vorFamilyNavaids,
  });
  const resultWithNdb = await planSyntheticRoute({
    airports,
    navaids: [...vorFamilyNavaids, ndb],
  });
  const ndbOnlyResult = await planSyntheticRoute({airports, navaids: [ndb]});

  expect(resultWithNdb).toEqual(resultWithoutNdb);
  if (!resultWithNdb.ok) {
    throw new Error(`Expected the VOR-family Route Plan: ${resultWithNdb.failure.code}`);
  }
  if (!ndbOnlyResult.ok) {
    throw new Error(`Expected the shorter NDB Route Plan: ${ndbOnlyResult.failure.code}`);
  }
  expect(ndbOnlyResult.value.plan.totalDistanceNm).toBeLessThan(
    resultWithNdb.value.plan.totalDistanceNm
  );
  expect(resultWithNdb.value.plan.searchMode).toBe('vor-family');
  expect(
    resultWithNdb.value.plan.routePoints.map(routePoint => routePoint.databaseId)
  ).toEqual(['departure', 'vor-first', 'vor-second', 'arrival']);
});

test('returns a successful NDB-fallback Route Plan only after VOR-family exhaustion', async () => {
  const result = await planSyntheticRoute({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 4),
    ],
    navaids: [
      syntheticNdb('ndb-first', 'NDB-A', 1, 90, 1),
      syntheticNdb('ndb-second', 'NDB-B', 3, 90, 1),
    ],
  });

  if (!result.ok) {
    throw new Error(`Expected an NDB-fallback Route Plan: ${result.failure.code}`);
  }
  expect(result.value.plan.searchMode).toBe('ndb-fallback');
  expect(result.value.plan.routePoints.map(routePoint => routePoint.databaseId)).toEqual([
    'departure',
    'ndb-first',
    'ndb-second',
    'arrival',
  ]);
  expect(result.value.plan.routePoints.slice(1, -1)).toEqual([
    expect.objectContaining({
      kind: 'ndb',
      identifier: 'NDB-A',
      frequency: {unit: 'kHz', value: 365},
    }),
    expect.objectContaining({
      kind: 'ndb',
      identifier: 'NDB-B',
      frequency: {unit: 'kHz', value: 365},
    }),
  ]);
  expect(result.value.warnings).toContainEqual({code: 'ndb-fallback-used'});
  expect(
    result.value.plan.routeLegs.every(
      routeLeg =>
        routeLeg.departureVorGuidance === null && routeLeg.arrivalVorGuidance === null
    )
  ).toBe(true);
});

test('selects the same stable mixed-family Route Plan for ten database row permutations', async () => {
  const oneDegreeNm = 111_194.926_644_558_74 / 1_852;
  const airports = [
    syntheticAirport('departure', 'AAAA', 0),
    syntheticAirport('arrival', 'BBBB', 4),
  ];
  const navaids = [
    syntheticNavaid('vor', 'VOR', 'VOR', 1, oneDegreeNm + 1),
    syntheticNdb('ndb-z', 'SAME', 3, oneDegreeNm + 1),
    syntheticNdb('ndb-a', 'SAME', 3, oneDegreeNm + 1),
  ];
  let expected:
    | Awaited<ReturnType<RoutePlannerTypes['RoutePlanner']['planRoute']>>
    | undefined;

  for (let permutation = 0; permutation < 10; permutation += 1) {
    const result = await planSyntheticRoute({
      airports: deterministicPermutation(airports, permutation),
      navaids: deterministicPermutation(navaids, permutation),
    });
    if (expected === undefined) {
      expected = result;
    } else {
      expect(result).toEqual(expected);
    }
  }

  if (expected === undefined || !expected.ok) {
    throw new Error('Expected a deterministic mixed-family Route Plan.');
  }
  expect(expected.value.plan.searchMode).toBe('ndb-fallback');
  expect(
    expected.value.plan.routePoints.map(routePoint => routePoint.databaseId)
  ).toEqual(['departure', 'vor', 'ndb-a', 'arrival']);
}, 15_000);

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

test('preserves true-course routing and deterministically warns for unavailable magnetic references', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      {
        ...syntheticAirport('arrival', 'BBBB', 4),
        magneticDeclinationDegEast: 2,
      },
    ],
    navaids: [
      {
        ...syntheticNavaid('vor-first', 'FIRST', 'VOR', 1, 70),
        magneticDeclinationDegEast: 5,
      },
      {
        ...syntheticNavaid('vor-second', 'SECOND', 'VOR', 3, 70),
        facilityVariationDegEast: -4,
        facilityVariationSource: 'Synthetic facility record',
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
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });
  await opened.value[Symbol.asyncDispose]();

  if (!result.ok) {
    throw new Error(`Expected missing magnetic references to preserve the plan.`);
  }
  expect(result.value.plan.routePoints.map(routePoint => routePoint.databaseId)).toEqual([
    'departure',
    'vor-first',
    'vor-second',
    'arrival',
  ]);
  expect(result.value.plan.routeLegs).toMatchObject([
    {
      departureTrueCourseDeg: 90,
      departureMagneticCourseDeg: null,
      arrivalTrueCourseDeg: 90,
      arrivalMagneticCourseDeg: 85,
      departureVorGuidance: null,
      arrivalVorGuidance: null,
    },
    {
      departureTrueCourseDeg: 90,
      departureMagneticCourseDeg: 85,
      arrivalTrueCourseDeg: 90,
      arrivalMagneticCourseDeg: null,
      departureVorGuidance: null,
      arrivalVorGuidance: {trueCourseDeg: 90, magneticCourseDeg: 94},
    },
    {
      departureTrueCourseDeg: 90,
      departureMagneticCourseDeg: null,
      arrivalTrueCourseDeg: 90,
      arrivalMagneticCourseDeg: 88,
      departureVorGuidance: {trueCourseDeg: 90, magneticCourseDeg: 94},
      arrivalVorGuidance: null,
    },
  ]);
  expect(result.value.warnings).toEqual([
    {code: 'magnetic-course-unavailable', legNumber: 1, endpoint: 'departure'},
    {code: 'magnetic-course-unavailable', legNumber: 2, endpoint: 'arrival'},
    {code: 'magnetic-course-unavailable', legNumber: 3, endpoint: 'departure'},
    {code: 'vor-guidance-unavailable', legNumber: 1, endpoint: 'arrival'},
    {code: 'vor-guidance-unavailable', legNumber: 2, endpoint: 'departure'},
    {
      code: 'facility-variation-date-unavailable',
      legNumber: 2,
      endpoint: 'arrival',
    },
    {
      code: 'facility-variation-date-unavailable',
      legNumber: 3,
      endpoint: 'departure',
    },
  ]);
});

test('does not interpret ambiguous OpenAIP magnetic fields as accepted references', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    navaids: [syntheticNavaid('vor', 'VOR', 'VOR', 1, 70)],
  });
  await syntheticPlannerDatabase.modify(
    database.databasePath,
    `CREATE OR REPLACE VIEW planner_navaids AS
      SELECT *,
        ST_Point(longitude, latitude) AS point,
        12.0 AS openaip_magnetic_declination,
        true AS openaip_true_north_aligned
      FROM synthetic_navaids`
  );
  const opened = await openRoutePlanner({databasePath: database.databasePath});
  if (!opened.ok) {
    throw new Error(
      `Expected extra raw-source fields to be ignored: ${opened.failure.code}`
    );
  }

  const result = await opened.value.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });
  await opened.value[Symbol.asyncDispose]();

  if (!result.ok) {
    throw new Error(`Expected ambiguous raw-source fields to preserve the plan.`);
  }
  expect(result.value.plan.routePoints[1]).toMatchObject({
    kind: 'vor-family',
    magneticDeclinationDegEast: null,
    facilityVariation: null,
  });
  expect(result.value.plan.routeLegs).toMatchObject([
    {arrivalMagneticCourseDeg: null, arrivalVorGuidance: null},
    {departureMagneticCourseDeg: null, departureVorGuidance: null},
  ]);
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

test('exhausts the mixed graph after excluding ineligible facilities', async () => {
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
      syntheticNdb('eligible-but-unreachable', 'NDB', 1, 1),
      {...syntheticNdb('blank-ndb-id', 'NDB', 1, oneDegreeNm), databaseId: ''},
      syntheticNdb('blank-ndb-identifier', '', 1, oneDegreeNm),
      {
        ...syntheticNdb('fractional-ndb-frequency', 'FRA', 1, oneDegreeNm),
        frequencyValue: 365.5,
      },
      {
        ...syntheticNdb('wrong-ndb-frequency-unit', 'WRG', 1, oneDegreeNm),
        frequencyUnit: 'MHz',
      },
      {
        ...syntheticNdb('nonfinite-ndb-frequency', 'INF', 1, oneDegreeNm),
        frequencyValue: Number.POSITIVE_INFINITY,
      },
      {
        ...syntheticNdb('zero-ndb-range', 'ZER', 1, oneDegreeNm),
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

async function planSyntheticRoute(
  definition: NonNullable<Parameters<typeof syntheticPlannerDatabase.create>[0]>
) {
  await using database = await syntheticPlannerDatabase.create(definition);
  const opened = await openRoutePlanner({databasePath: database.databasePath});
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }
  const result = await opened.value.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });
  await opened.value[Symbol.asyncDispose]();
  return result;
}

function syntheticNavaid(
  databaseId: string,
  identifier: string,
  family: string,
  longitude: number,
  publishedRangeNm: number,
  latitude = 0
) {
  return {
    databaseId,
    identifier,
    name: `Navaid ${databaseId}`,
    family,
    longitude,
    latitude,
    frequencyValue: 113,
    frequencyUnit: 'MHz',
    publishedRangeNm,
  } as const;
}

function syntheticNdb(
  databaseId: string,
  identifier: string,
  longitude: number,
  publishedRangeNm: number,
  latitude = 0
) {
  return {
    ...syntheticNavaid(
      databaseId,
      identifier,
      'NDB',
      longitude,
      publishedRangeNm,
      latitude
    ),
    frequencyValue: 365,
    frequencyUnit: 'kHz',
  } as const;
}
