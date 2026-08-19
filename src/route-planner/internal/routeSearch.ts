import progressiveDiscovery from '#radial/route-planner/internal/progressiveDiscovery.js';
import routeGraph from '#radial/route-planner/internal/routeGraph.js';
import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';

type CandidateFamily = RouteSearchTypes['CandidateFamily'];
type MeasuredCandidate = RouteSearchTypes['MeasuredCandidate'];
type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];
type RouteSearchDataSource = RouteSearchTypes['RouteSearchDataSource'];
type RouteSearchResult = RouteSearchTypes['RouteSearchResult'];
type SelectedRoute = RouteSearchTypes['SelectedRoute'];
type IncrementalRouteGraph = ReturnType<typeof routeGraph.createGraph>;

type ProgressiveSearchResult =
  | Readonly<{status: 'completed'; route: SelectedRoute | undefined}>
  | Readonly<{status: 'failed'}>;

async function findRoute(
  dataSource: RouteSearchDataSource,
  maxRouteFactor: number
): Promise<RouteSearchResult> {
  let directDistanceNm: number;
  try {
    directDistanceNm = await dataSource.directDistanceNm();
  } catch {
    return {status: 'failed', phase: 'vor-family'};
  }

  if (!Number.isFinite(directDistanceNm) || directDistanceNm < 0) {
    throw new Error(`Route Search received invalid direct distance: ${directDistanceNm}`);
  }

  const graph = routeGraph.createGraph();
  const admittedDatabaseIds: string[] = [];
  const maximumRouteDistanceNm = directDistanceNm * maxRouteFactor;
  const vorFamilySearch = await searchProgressively(
    dataSource,
    'vor-family',
    directDistanceNm,
    maxRouteFactor,
    maximumRouteDistanceNm,
    graph,
    admittedDatabaseIds
  );
  if (vorFamilySearch.status === 'failed') {
    return {status: 'failed', phase: 'vor-family'};
  }

  if (vorFamilySearch.route !== undefined) {
    return {
      status: 'found',
      route: vorFamilySearch.route,
      searchMode: 'vor-family',
    };
  }

  const ndbSearch = await searchProgressively(
    dataSource,
    'ndb',
    directDistanceNm,
    maxRouteFactor,
    maximumRouteDistanceNm,
    graph,
    admittedDatabaseIds
  );
  if (ndbSearch.status === 'failed') {
    return {status: 'failed', phase: 'ndb-fallback'};
  }

  if (ndbSearch.route !== undefined) {
    return {
      status: 'found',
      route: ndbSearch.route,
      searchMode: 'ndb-fallback',
    };
  }

  return {
    status: 'exhausted',
    completedSearchFactors: progressiveDiscovery.scheduledFactors(maxRouteFactor),
  };
}

async function searchProgressively(
  dataSource: RouteSearchDataSource,
  family: CandidateFamily,
  directDistanceNm: number,
  maxRouteFactor: number,
  maximumRouteDistanceNm: number,
  graph: IncrementalRouteGraph,
  admittedDatabaseIds: string[]
): Promise<ProgressiveSearchResult> {
  const discoverySession = progressiveDiscovery.createSession<MeasuredCandidate>(
    directDistanceNm,
    maxRouteFactor
  );
  let selectedRoute: SelectedRoute | undefined;

  for (;;) {
    const nextLimitNm = discoverySession.nextLimitNm(selectedRoute?.totalDistanceNm);
    if (nextLimitNm === undefined) {
      return {status: 'completed', route: selectedRoute};
    }

    let measuredCandidates: readonly MeasuredCandidate[];
    try {
      measuredCandidates = await dataSource.findNewCandidates(
        family,
        nextLimitNm,
        discoverySession.measuredDatabaseIds
      );
    } catch {
      return {status: 'failed'};
    }

    validateMeasuredCandidates(family, measuredCandidates);
    const newlyAdmittedCandidates = discoverySession.admitMeasuredCandidates(
      measuredCandidates,
      nextLimitNm
    );
    if (newlyAdmittedCandidates.length > 0) {
      let newPairDistances: readonly NavaidPairDistance[];
      try {
        newPairDistances = await dataSource.findNewPairs(
          newlyAdmittedCandidates,
          admittedDatabaseIds
        );
      } catch {
        return {status: 'failed'};
      }

      validateNewPairDistances(
        newlyAdmittedCandidates,
        admittedDatabaseIds,
        newPairDistances
      );
      graph.admit(newlyAdmittedCandidates, newPairDistances);
      admittedDatabaseIds.push(
        ...newlyAdmittedCandidates.map(candidate => candidate.routePoint.databaseId)
      );
      selectedRoute = graph.selectOptimalRoute(maximumRouteDistanceNm);
    }
  }
}

function validateMeasuredCandidates(
  family: CandidateFamily,
  candidates: readonly MeasuredCandidate[]
): void {
  for (const candidate of candidates) {
    const {databaseId, kind} = candidate.routePoint;
    if (databaseId.trim() === '') {
      throw new Error('Route Search received a candidate with a blank database ID.');
    }

    if (kind !== family) {
      throw new Error(
        `Route Search received a ${kind} candidate during ${family} discovery: ${databaseId}`
      );
    }

    if (
      !Number.isFinite(candidate.departureDistanceNm) ||
      candidate.departureDistanceNm < 0 ||
      !Number.isFinite(candidate.arrivalDistanceNm) ||
      candidate.arrivalDistanceNm < 0
    ) {
      throw new Error(
        `Route Search received invalid endpoint distances for candidate: ${databaseId}`
      );
    }
  }
}

function validateNewPairDistances(
  newlyAdmittedCandidates: readonly MeasuredCandidate[],
  admittedDatabaseIds: readonly string[],
  pairDistances: readonly NavaidPairDistance[]
): void {
  const newlyAdmittedIds = newlyAdmittedCandidates.map(
    candidate => candidate.routePoint.databaseId
  );
  const newlyAdmittedIdSet = new Set(newlyAdmittedIds);
  const allAdmittedIds = [...admittedDatabaseIds, ...newlyAdmittedIds];
  const allAdmittedIdSet = new Set(allAdmittedIds);
  const expectedPairKeys = new Set<string>();
  for (let firstIndex = 0; firstIndex < allAdmittedIds.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < allAdmittedIds.length;
      secondIndex += 1
    ) {
      const firstDatabaseId = allAdmittedIds[firstIndex];
      const secondDatabaseId = allAdmittedIds[secondIndex];
      if (
        firstDatabaseId !== undefined &&
        secondDatabaseId !== undefined &&
        (newlyAdmittedIdSet.has(firstDatabaseId) ||
          newlyAdmittedIdSet.has(secondDatabaseId))
      ) {
        expectedPairKeys.add(pairKey(firstDatabaseId, secondDatabaseId));
      }
    }
  }

  const measuredPairKeys = new Set<string>();
  for (const pairDistance of pairDistances) {
    const {firstDatabaseId, secondDatabaseId, distanceNm} = pairDistance;
    if (
      firstDatabaseId === secondDatabaseId ||
      !allAdmittedIdSet.has(firstDatabaseId) ||
      !allAdmittedIdSet.has(secondDatabaseId) ||
      (!newlyAdmittedIdSet.has(firstDatabaseId) &&
        !newlyAdmittedIdSet.has(secondDatabaseId))
    ) {
      throw new Error(
        `Route Search received an unexpected candidate pair: ${firstDatabaseId}, ${secondDatabaseId}`
      );
    }

    if (!Number.isFinite(distanceNm) || distanceNm < 0) {
      throw new Error(
        `Route Search received an invalid candidate-pair distance: ${firstDatabaseId}, ${secondDatabaseId}`
      );
    }

    const key = pairKey(firstDatabaseId, secondDatabaseId);
    if (measuredPairKeys.has(key)) {
      throw new Error(`Route Search received a duplicate candidate pair: ${key}`);
    }

    measuredPairKeys.add(key);
  }

  for (const expectedPairKey of expectedPairKeys) {
    if (!measuredPairKeys.has(expectedPairKey)) {
      throw new Error(`Route Search did not receive candidate pair: ${expectedPairKey}`);
    }
  }
}

function pairKey(firstDatabaseId: string, secondDatabaseId: string): string {
  return [firstDatabaseId, secondDatabaseId].toSorted().join('\0');
}

export default {findRoute};
