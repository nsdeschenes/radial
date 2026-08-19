import {expect, test} from 'vitest';

import routeSearch from '#radial/route-planner/internal/routeSearch.js';
import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type CandidateFamily = RouteSearchTypes['CandidateFamily'];
type MeasuredCandidate = RouteSearchTypes['MeasuredCandidate'];
type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];
type RouteSearchDataSource = RouteSearchTypes['RouteSearchDataSource'];
type NdbRoutePoint = RoutePlannerTypes['NdbRoutePoint'];
type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];

test('returns a VOR-family Route Plan without beginning NDB fallback', async () => {
  const vor = vorFamilyCandidate('vor', 50, 50, 60);
  const dataSource = new InMemoryRouteSearchDataSource([vor], [], []);

  await expect(routeSearch.findRoute(dataSource, 1.5)).resolves.toEqual({
    status: 'found',
    searchMode: 'vor-family',
    route: {
      navaids: [vor.routePoint],
      legDistancesNm: [50, 50],
      totalDistanceNm: 100,
    },
  });
  expect(dataSource.candidateCalls.map(call => call.family)).toEqual(['vor-family']);
});

test('exhausts VOR-family discovery before adding NDBs to the retained graph', async () => {
  const vor = vorFamilyCandidate('vor', 20, 100, 30);
  const ndb = ndbCandidate('ndb', 100, 20, 30);
  const dataSource = new InMemoryRouteSearchDataSource(
    [vor],
    [ndb],
    [{firstDatabaseId: 'vor', secondDatabaseId: 'ndb', distanceNm: 50}]
  );

  await expect(routeSearch.findRoute(dataSource, 1.5)).resolves.toEqual({
    status: 'found',
    searchMode: 'ndb-fallback',
    route: {
      navaids: [vor.routePoint, ndb.routePoint],
      legDistancesNm: [20, 50, 20],
      totalDistanceNm: 90,
    },
  });
  expect(
    dataSource.candidateCalls.map(({family, nextLimitNm}) => [family, nextLimitNm])
  ).toEqual([
    ['vor-family', 110.00000000000001],
    ['vor-family', 125],
    ['vor-family', 150],
    ['ndb', 110.00000000000001],
    ['ndb', 125],
  ]);
});

test('reports exhaustion only after completing both family schedules', async () => {
  const dataSource = new InMemoryRouteSearchDataSource([], [], []);

  await expect(routeSearch.findRoute(dataSource, 2)).resolves.toEqual({
    status: 'exhausted',
    completedSearchFactors: [1.1, 1.25, 1.5],
  });
  expect(dataSource.candidateCalls.map(call => call.family)).toEqual([
    'vor-family',
    'vor-family',
    'vor-family',
    'ndb',
    'ndb',
    'ndb',
  ]);
  expect(dataSource.pairCallCount).toBe(0);
});

test.each([
  {failure: 'direct-distance' as const, phase: 'vor-family'},
  {failure: 'vor-family-candidates' as const, phase: 'vor-family'},
  {failure: 'ndb-candidates' as const, phase: 'ndb-fallback'},
])(
  'reports $phase failure for $failure without treating it as exhaustion',
  async value => {
    const dataSource = new InMemoryRouteSearchDataSource([], [], [], value.failure);

    await expect(routeSearch.findRoute(dataSource, 1.5)).resolves.toEqual({
      status: 'failed',
      phase: value.phase,
    });
  }
);

test('reports pair measurement failure in the active phase', async () => {
  const candidate = vorFamilyCandidate('vor', 20, 100, 30);
  const dataSource = new InMemoryRouteSearchDataSource(
    [candidate],
    [],
    [],
    'pair-distances'
  );

  await expect(routeSearch.findRoute(dataSource, 1.5)).resolves.toEqual({
    status: 'failed',
    phase: 'vor-family',
  });
});

test.each([
  {
    name: 'blank database ID',
    candidate: vorFamilyCandidate(' ', 50, 50, 60),
    error: /blank database ID/,
  },
  {
    name: 'wrong family',
    candidate: ndbCandidate('wrong-family', 50, 50, 60),
    error: /ndb candidate during vor-family discovery/,
  },
  {
    name: 'invalid endpoint distance',
    candidate: vorFamilyCandidate('invalid-distance', Number.NaN, 50, 60),
    error: /invalid endpoint distances/,
  },
])('rejects a candidate with $name', async ({candidate, error}) => {
  const dataSource = new InMemoryRouteSearchDataSource([candidate], [], []);

  await expect(routeSearch.findRoute(dataSource, 1.5)).rejects.toThrow(error);
});

test('rejects an incomplete candidate-pair batch', async () => {
  const first = vorFamilyCandidate('first', 50, 50, 10);
  const second = vorFamilyCandidate('second', 50, 50, 10);
  const dataSource = new InMemoryRouteSearchDataSource([first, second], [], []);

  await expect(routeSearch.findRoute(dataSource, 1.5)).rejects.toThrow(
    /did not receive candidate pair/
  );
});

class InMemoryRouteSearchDataSource implements RouteSearchDataSource {
  readonly candidateCalls: Array<{
    family: CandidateFamily;
    nextLimitNm: number;
    measuredDatabaseIds: readonly string[];
  }> = [];
  pairCallCount = 0;
  readonly #failure:
    | 'direct-distance'
    | 'vor-family-candidates'
    | 'ndb-candidates'
    | 'pair-distances'
    | undefined;
  readonly #ndbCandidates: readonly MeasuredCandidate[];
  readonly #pairDistances: readonly NavaidPairDistance[];
  readonly #vorFamilyCandidates: readonly MeasuredCandidate[];

  constructor(
    vorFamilyCandidates: readonly MeasuredCandidate[],
    ndbCandidates: readonly MeasuredCandidate[],
    pairDistances: readonly NavaidPairDistance[],
    failure?:
      | 'direct-distance'
      | 'vor-family-candidates'
      | 'ndb-candidates'
      | 'pair-distances'
  ) {
    this.#failure = failure;
    this.#ndbCandidates = ndbCandidates;
    this.#pairDistances = pairDistances;
    this.#vorFamilyCandidates = vorFamilyCandidates;
  }

  directDistanceNm(): Promise<number> {
    return this.#failure === 'direct-distance'
      ? Promise.reject(new Error('Direct-distance query failed.'))
      : Promise.resolve(100);
  }

  findNewCandidates(
    family: CandidateFamily,
    nextLimitNm: number,
    measuredDatabaseIds: readonly string[]
  ): Promise<readonly MeasuredCandidate[]> {
    this.candidateCalls.push({
      family,
      nextLimitNm,
      measuredDatabaseIds: [...measuredDatabaseIds],
    });
    if (this.#failure === `${family}-candidates`) {
      return Promise.reject(new Error(`${family} candidate query failed.`));
    }
    const candidates =
      family === 'vor-family' ? this.#vorFamilyCandidates : this.#ndbCandidates;
    return Promise.resolve(
      candidates.filter(
        candidate => !measuredDatabaseIds.includes(candidate.routePoint.databaseId)
      )
    );
  }

  findNewPairs(
    newlyAdmittedCandidates: readonly MeasuredCandidate[],
    admittedDatabaseIds: readonly string[]
  ): Promise<readonly NavaidPairDistance[]> {
    this.pairCallCount += 1;
    if (this.#failure === 'pair-distances') {
      return Promise.reject(new Error('Pair-distance query failed.'));
    }
    const newlyAdmittedIds = new Set(
      newlyAdmittedCandidates.map(candidate => candidate.routePoint.databaseId)
    );
    const admittedIds = new Set([...admittedDatabaseIds, ...newlyAdmittedIds]);
    return Promise.resolve(
      this.#pairDistances.filter(
        pairDistance =>
          admittedIds.has(pairDistance.firstDatabaseId) &&
          admittedIds.has(pairDistance.secondDatabaseId) &&
          (newlyAdmittedIds.has(pairDistance.firstDatabaseId) ||
            newlyAdmittedIds.has(pairDistance.secondDatabaseId))
      )
    );
  }
}

function vorFamilyCandidate(
  databaseId: string,
  departureDistanceNm: number,
  arrivalDistanceNm: number,
  publishedRangeNm: number
): MeasuredCandidate {
  const routePoint: VorFamilyRoutePoint = {
    kind: 'vor-family',
    databaseId,
    identifier: databaseId.toUpperCase(),
    name: databaseId,
    family: 'VOR',
    longitude: 0,
    latitude: 0,
    frequency: {unit: 'MHz', value: 113},
    publishedRangeNm,
    magneticDeclinationDegEast: null,
    facilityVariation: null,
  };
  return {routePoint, departureDistanceNm, arrivalDistanceNm};
}

function ndbCandidate(
  databaseId: string,
  departureDistanceNm: number,
  arrivalDistanceNm: number,
  publishedRangeNm: number
): MeasuredCandidate {
  const routePoint: NdbRoutePoint = {
    kind: 'ndb',
    databaseId,
    identifier: databaseId.toUpperCase(),
    name: databaseId,
    longitude: 0,
    latitude: 0,
    frequency: {unit: 'kHz', value: 365},
    publishedRangeNm,
    magneticDeclinationDegEast: null,
  };
  return {routePoint, departureDistanceNm, arrivalDistanceNm};
}
