import {expect, test} from 'vitest';

import routeSearch from '#radial/route-planner/internal/routeSearch.js';
import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';
import deterministicPermutation from '#radial/test/deterministicPermutation.js';

type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];
type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];
type Candidate = ReturnType<typeof candidate>;
type SelectedRoute = NonNullable<ReturnType<typeof routeSearch.selectOptimalRoute>>;

const PROPERTY_SEED = 0x20_24_08_17;

test('selects the shorter Route Plan even when it contains more Route Legs', () => {
  const shortFirst = candidate('short-first', 'FIRST', 2, 50);
  const shortSecond = candidate('short-second', 'SECOND', 50, 2);
  const fewerLegs = candidate('fewer-legs', 'DIRECT', 5, 5);

  const selected = routeSearch.selectOptimalRoute(
    [fewerLegs, shortSecond, shortFirst],
    [{firstDatabaseId: 'short-first', secondDatabaseId: 'short-second', distanceNm: 4}],
    20
  );

  expect(selected).toEqual({
    navaids: [shortFirst.routePoint, shortSecond.routePoint],
    legDistancesNm: [2, 4, 2],
    totalDistanceNm: 8,
  });
});

test('retains one monotonic graph while newly admitted candidates improve a provisional Route Plan', () => {
  const first = candidate('first', 'FIRST', 2, 50);
  const second = candidate('second', 'SECOND', 50, 2);
  const later = candidate('later', 'LATER', 5, 5);
  const graph = routeSearch.createGraph();

  graph.admit(
    [first, second],
    [{firstDatabaseId: 'first', secondDatabaseId: 'second', distanceNm: 10}]
  );
  expect(graph.selectOptimalRoute(20)?.totalDistanceNm).toBe(14);

  graph.admit([later], []);
  expect(graph.selectOptimalRoute(20)).toEqual({
    navaids: [later.routePoint],
    legDistancesNm: [5, 5],
    totalDistanceNm: 10,
  });
  expect(() =>
    graph.admit(
      [],
      [{firstDatabaseId: 'second', secondDatabaseId: 'first', distanceNm: 10}]
    )
  ).toThrow(/candidate pair was compared more than once/);
  expect(() => graph.admit([later], [])).toThrow(/candidate was admitted more than once/);
});

test('uses exact Float64 distance, then Route Leg count, then stable Navaid identity sequence', () => {
  const exact = candidate('distance-exact', 'ZULU', 0.5, 0.5);
  const nextFloat = candidate('distance-next-float', 'ALFA', 0.5, 0.5 + Number.EPSILON);
  const fewerLegs = candidate('fewer-legs', 'ZULU', 5, 5);
  const moreLegsFirst = candidate('more-legs-first', 'ALFA', 2, 50);
  const moreLegsSecond = candidate('more-legs-second', 'BRAVO', 50, 2);
  const stableIdFirst = candidate('database-id-1', 'SAME', 8, 8);
  const stableIdSecond = candidate('database-id-2', 'SAME', 8, 8);
  const identifierFirst = candidate('database-id-z', 'ALFA', 8, 8);
  const identifierSecond = candidate('database-id-a', 'ZULU', 8, 8);

  expect(routeSearch.selectOptimalRoute([nextFloat, exact], [], 2)?.navaids).toEqual([
    exact.routePoint,
  ]);
  expect(
    routeSearch.selectOptimalRoute(
      [moreLegsSecond, fewerLegs, moreLegsFirst],
      [
        {
          firstDatabaseId: 'more-legs-first',
          secondDatabaseId: 'more-legs-second',
          distanceNm: 6,
        },
      ],
      20
    )?.navaids
  ).toEqual([fewerLegs.routePoint]);
  expect(
    routeSearch.selectOptimalRoute([stableIdSecond, stableIdFirst], [], 20)?.navaids
  ).toEqual([stableIdFirst.routePoint]);
  expect(
    routeSearch.selectOptimalRoute([identifierSecond, identifierFirst], [], 20)?.navaids
  ).toEqual([identifierFirst.routePoint]);
});

test('retains a higher partial Float64 distance when later rounding can make its fewer-leg route win', () => {
  const first = candidate('first', 'ALFA', 0.5, 2 ** 53, 1);
  const second = candidate('second', 'BRAVO', 2 ** 53, 2 ** 53, 1);
  const finish = candidate('finish', 'ZULU', 1 + Number.EPSILON, 2 ** 52, 2 ** 52);

  const selected = routeSearch.selectOptimalRoute(
    [first, second, finish],
    [
      {firstDatabaseId: 'first', secondDatabaseId: 'second', distanceNm: 0.25},
      {firstDatabaseId: 'second', secondDatabaseId: 'finish', distanceNm: 0.25},
    ],
    2 ** 52 + 10
  );

  expect(selected).toEqual({
    navaids: [finish.routePoint],
    legDistancesNm: [1 + Number.EPSILON, 2 ** 52],
    totalDistanceNm: 2 ** 52 + 1,
  });
});

test('produces deeply equal structured results for ten deterministic input permutations', () => {
  const first = candidate('first', 'ALFA', 2, 50);
  const second = candidate('second', 'BRAVO', 50, 2);
  const direct = candidate('direct', 'CHARLIE', 8, 8);
  const irrelevantFirst = candidate('irrelevant-1', 'IGNORE-1', 50, 50);
  const irrelevantSecond = candidate('irrelevant-2', 'IGNORE-2', 50, 50);
  const candidates = [first, second, direct, irrelevantFirst, irrelevantSecond];
  const legs = [
    {firstDatabaseId: 'first', secondDatabaseId: 'second', distanceNm: 4},
    {firstDatabaseId: 'direct', secondDatabaseId: 'irrelevant-1', distanceNm: 4},
    {firstDatabaseId: 'first', secondDatabaseId: 'irrelevant-2', distanceNm: 100},
  ];
  const expected = routeSearch.selectOptimalRoute(
    [first, second, direct],
    [legs[0]].filter(leg => leg !== undefined),
    20
  );

  for (let permutation = 0; permutation < 10; permutation += 1) {
    expect(
      routeSearch.selectOptimalRoute(
        deterministicPermutation(candidates, permutation),
        deterministicPermutation(legs, permutation + 3),
        20
      )
    ).toEqual(expected);
  }
});

test(`matches an exhaustive reference solver for 1,000 generated small graphs (seed ${PROPERTY_SEED})`, () => {
  const random = seededRandom(PROPERTY_SEED);

  for (let example = 0; example < 1_000; example += 1) {
    const graph = generatedGraph(random);
    const actual = routeSearch.selectOptimalRoute(
      graph.candidates,
      graph.legs,
      graph.maximumDistanceNm
    );
    const expected = exhaustiveRoute(graph);

    if (!deeplyEqual(actual, expected)) {
      const counterexample = minimizeCounterexample(graph);
      throw new Error(
        `Route search disagreed with the exhaustive reference solver. Replay seed: ${PROPERTY_SEED}; example: ${example}; minimized counterexample: ${JSON.stringify(counterexample)}`
      );
    }

    expect(
      routeSearch.selectOptimalRoute(
        graph.candidates.toReversed(),
        graph.legs.toReversed(),
        graph.maximumDistanceNm
      )
    ).toEqual(actual);
    expect(
      routeSearch.selectOptimalRoute(
        [
          ...graph.candidates,
          candidate(
            `irrelevant-${example}`,
            'IRRELEVANT',
            graph.maximumDistanceNm + 2,
            graph.maximumDistanceNm + 2,
            1
          ),
        ],
        graph.legs,
        graph.maximumDistanceNm
      )
    ).toEqual(actual);

    if (actual !== undefined) {
      assertSelectedRouteProperties(actual, graph);
    }
  }
});

function candidate(
  databaseId: string,
  identifier: string,
  departureDistanceNm: number,
  arrivalDistanceNm: number,
  publishedRangeNm = 40
) {
  return {
    routePoint: vorFamilyRoutePoint(databaseId, identifier, publishedRangeNm),
    departureDistanceNm,
    arrivalDistanceNm,
  };
}

function vorFamilyRoutePoint(
  databaseId: string,
  identifier: string,
  publishedRangeNm: number
): VorFamilyRoutePoint {
  return {
    kind: 'vor-family',
    databaseId,
    identifier,
    name: identifier,
    family: 'VOR',
    longitude: 0,
    latitude: 0,
    frequency: {unit: 'MHz', value: 113},
    publishedRangeNm,
    magneticDeclinationDegEast: null,
    facilityVariation: null,
  };
}

type GeneratedGraph = Readonly<{
  candidates: readonly Candidate[];
  legs: readonly NavaidPairDistance[];
  maximumDistanceNm: number;
}>;

function generatedGraph(random: () => number): GeneratedGraph {
  const candidateCount = 1 + randomInteger(random, 6);
  const candidates = Array.from({length: candidateCount}, (_, index) =>
    candidate(
      `id-${index.toString().padStart(2, '0')}`,
      `IDENT-${randomInteger(random, 3)}`,
      1 + randomInteger(random, 12),
      1 + randomInteger(random, 12),
      1 + randomInteger(random, 8)
    )
  );
  const legs: NavaidPairDistance[] = [];
  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      const firstCandidate = candidates[first];
      const secondCandidate = candidates[second];
      if (firstCandidate !== undefined && secondCandidate !== undefined) {
        legs.push({
          firstDatabaseId: firstCandidate.routePoint.databaseId,
          secondDatabaseId: secondCandidate.routePoint.databaseId,
          distanceNm: 1 + randomInteger(random, 15),
        });
      }
    }
  }

  return {
    candidates: shuffle(candidates, random),
    legs: shuffle(legs, random),
    maximumDistanceNm: 6 + randomInteger(random, 25),
  };
}

function assertSelectedRouteProperties(
  selected: SelectedRoute,
  graph: GeneratedGraph
): void {
  expect(selected.legDistancesNm).toHaveLength(selected.navaids.length + 1);
  expect(selected.totalDistanceNm).toBe(
    selected.legDistancesNm.reduce((total, distanceNm) => total + distanceNm, 0)
  );
  expect(selected.totalDistanceNm).toBeLessThanOrEqual(graph.maximumDistanceNm);
  expect(new Set(selected.navaids.map(navaid => navaid.databaseId)).size).toBe(
    selected.navaids.length
  );

  const candidateById = new Map(
    graph.candidates.map(value => [value.routePoint.databaseId, value])
  );
  const first = selected.navaids[0];
  const last = selected.navaids.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Generated Route Plan endpoint invariant failed.');
  }
  expect(selected.legDistancesNm[0]).toBe(
    candidateById.get(first.databaseId)?.departureDistanceNm
  );
  expect(selected.legDistancesNm.at(-1)).toBe(
    candidateById.get(last.databaseId)?.arrivalDistanceNm
  );
  expect(selected.legDistancesNm[0]).toBeLessThanOrEqual(first.publishedRangeNm);
  expect(selected.legDistancesNm.at(-1)).toBeLessThanOrEqual(last.publishedRangeNm);

  for (let index = 0; index < selected.navaids.length - 1; index += 1) {
    const departure = selected.navaids[index];
    const arrival = selected.navaids[index + 1];
    if (departure === undefined || arrival === undefined) {
      throw new Error('Generated Route Plan continuity invariant failed.');
    }
    const pair = graph.legs.find(
      leg =>
        (leg.firstDatabaseId === departure.databaseId &&
          leg.secondDatabaseId === arrival.databaseId) ||
        (leg.firstDatabaseId === arrival.databaseId &&
          leg.secondDatabaseId === departure.databaseId)
    );
    expect(selected.legDistancesNm[index + 1]).toBe(pair?.distanceNm);
    expect(pair?.distanceNm).toBeLessThanOrEqual(
      departure.publishedRangeNm + arrival.publishedRangeNm
    );
  }
}

function exhaustiveRoute(graph: GeneratedGraph): SelectedRoute | undefined {
  const candidatesById = new Map(
    graph.candidates.map(value => [value.routePoint.databaseId, value])
  );
  const navigableLegs = graph.legs.filter(leg => {
    const first = candidatesById.get(leg.firstDatabaseId);
    const second = candidatesById.get(leg.secondDatabaseId);
    return (
      first !== undefined &&
      second !== undefined &&
      leg.distanceNm <=
        first.routePoint.publishedRangeNm + second.routePoint.publishedRangeNm
    );
  });
  const completeRoutes: SelectedRoute[] = [];

  for (const start of graph.candidates) {
    if (start.departureDistanceNm <= start.routePoint.publishedRangeNm) {
      visit(
        [start.routePoint],
        [start.departureDistanceNm],
        start.departureDistanceNm,
        new Set([start.routePoint.databaseId])
      );
    }
  }

  return completeRoutes.toSorted(compareReferenceRoutes)[0];

  function visit(
    navaids: readonly VorFamilyRoutePoint[],
    distances: readonly number[],
    totalDistanceNm: number,
    visited: ReadonlySet<string>
  ): void {
    const current = navaids.at(-1);
    if (current === undefined || totalDistanceNm > graph.maximumDistanceNm) {
      return;
    }
    const currentCandidate = candidatesById.get(current.databaseId);
    if (
      currentCandidate !== undefined &&
      currentCandidate.arrivalDistanceNm <= current.publishedRangeNm &&
      totalDistanceNm + currentCandidate.arrivalDistanceNm <= graph.maximumDistanceNm
    ) {
      completeRoutes.push({
        navaids,
        legDistancesNm: [...distances, currentCandidate.arrivalDistanceNm],
        totalDistanceNm: totalDistanceNm + currentCandidate.arrivalDistanceNm,
      });
    }

    for (const leg of navigableLegs) {
      const adjacentId =
        leg.firstDatabaseId === current.databaseId
          ? leg.secondDatabaseId
          : leg.secondDatabaseId === current.databaseId
            ? leg.firstDatabaseId
            : undefined;
      const adjacent =
        adjacentId === undefined ? undefined : candidatesById.get(adjacentId);
      if (adjacent !== undefined && !visited.has(adjacent.routePoint.databaseId)) {
        visit(
          [...navaids, adjacent.routePoint],
          [...distances, leg.distanceNm],
          totalDistanceNm + leg.distanceNm,
          new Set([...visited, adjacent.routePoint.databaseId])
        );
      }
    }
  }
}

function compareReferenceRoutes(first: SelectedRoute, second: SelectedRoute): number {
  if (first.totalDistanceNm !== second.totalDistanceNm) {
    return first.totalDistanceNm < second.totalDistanceNm ? -1 : 1;
  }
  if (first.legDistancesNm.length !== second.legDistancesNm.length) {
    return first.legDistancesNm.length - second.legDistancesNm.length;
  }
  const firstIdentity = first.navaids.map(navaid => [
    navaid.identifier,
    navaid.databaseId,
  ]);
  const secondIdentity = second.navaids.map(navaid => [
    navaid.identifier,
    navaid.databaseId,
  ]);
  return JSON.stringify(firstIdentity) < JSON.stringify(secondIdentity) ? -1 : 1;
}

function minimizeCounterexample(graph: GeneratedGraph): GeneratedGraph {
  let minimized = graph;
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of minimized.candidates) {
      const candidates = minimized.candidates.filter(value => value !== candidate);
      const databaseIds = new Set(candidates.map(value => value.routePoint.databaseId));
      const attempted = {
        ...minimized,
        candidates,
        legs: minimized.legs.filter(
          leg =>
            databaseIds.has(leg.firstDatabaseId) && databaseIds.has(leg.secondDatabaseId)
        ),
      };
      if (isCounterexample(attempted)) {
        minimized = attempted;
        changed = true;
        break;
      }
    }
    if (changed) {
      continue;
    }
    for (const leg of minimized.legs) {
      const attempted = {
        ...minimized,
        legs: minimized.legs.filter(value => value !== leg),
      };
      if (isCounterexample(attempted)) {
        minimized = attempted;
        changed = true;
        break;
      }
    }
  }
  return minimized;
}

function isCounterexample(graph: GeneratedGraph): boolean {
  return !deeplyEqual(
    routeSearch.selectOptimalRoute(graph.candidates, graph.legs, graph.maximumDistanceNm),
    exhaustiveRoute(graph)
  );
}

function deeplyEqual(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function randomInteger(random: () => number, maximumExclusive: number): number {
  return Math.floor(random() * maximumExclusive);
}

function shuffle<Value>(values: readonly Value[], random: () => number): Value[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInteger(random, index + 1);
    const value = shuffled[index];
    const otherValue = shuffled[otherIndex];
    if (value !== undefined && otherValue !== undefined) {
      shuffled[index] = otherValue;
      shuffled[otherIndex] = value;
    }
  }
  return shuffled;
}
