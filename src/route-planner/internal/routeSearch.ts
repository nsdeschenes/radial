import coverage from '#radial/route-planner/internal/coverage.js';
import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];

type RouteCandidate = Readonly<{
  routePoint: VorFamilyRoutePoint;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];

type SelectedRoute = Readonly<{
  navaids: readonly VorFamilyRoutePoint[];
  legDistancesNm: readonly number[];
  totalDistanceNm: number;
}>;

type SearchRoute = SelectedRoute & Readonly<{currentDatabaseId: string}>;

type Adjacency = Readonly<{databaseId: string; distanceNm: number}>;

function selectOptimalRoute(
  candidates: readonly RouteCandidate[],
  navaidPairDistances: readonly NavaidPairDistance[],
  maximumDistanceNm: number
): SelectedRoute | undefined {
  const graph = createGraph();
  graph.admit(candidates, navaidPairDistances);
  return graph.selectOptimalRoute(maximumDistanceNm);
}

class IncrementalRouteGraph {
  readonly #adjacencyByDatabaseId = new Map<string, Adjacency[]>();
  readonly #candidateByDatabaseId = new Map<string, RouteCandidate>();
  readonly #comparedPairKeys = new Set<string>();

  admit(
    candidates: readonly RouteCandidate[],
    navaidPairDistances: readonly NavaidPairDistance[]
  ): void {
    for (const candidate of candidates) {
      const databaseId = candidate.routePoint.databaseId;
      if (this.#candidateByDatabaseId.has(databaseId)) {
        throw new Error(
          `Route graph candidate was admitted more than once: ${databaseId}`
        );
      }
      this.#candidateByDatabaseId.set(databaseId, candidate);
      this.#adjacencyByDatabaseId.set(databaseId, []);
    }

    for (const leg of navaidPairDistances) {
      const pairKey = [leg.firstDatabaseId, leg.secondDatabaseId].toSorted().join('\0');
      if (this.#comparedPairKeys.has(pairKey)) {
        throw new Error(
          `Route graph candidate pair was compared more than once: ${pairKey}`
        );
      }
      this.#comparedPairKeys.add(pairKey);
      const first = this.#candidateByDatabaseId.get(leg.firstDatabaseId);
      const second = this.#candidateByDatabaseId.get(leg.secondDatabaseId);
      if (
        first === undefined ||
        second === undefined ||
        leg.firstDatabaseId === leg.secondDatabaseId ||
        !coverage.isNavaidToNavaidNavigable(
          leg.distanceNm,
          first.routePoint.publishedRangeNm,
          second.routePoint.publishedRangeNm
        )
      ) {
        continue;
      }

      this.#adjacencyByDatabaseId
        .get(leg.firstDatabaseId)
        ?.push({databaseId: leg.secondDatabaseId, distanceNm: leg.distanceNm});
      this.#adjacencyByDatabaseId
        .get(leg.secondDatabaseId)
        ?.push({databaseId: leg.firstDatabaseId, distanceNm: leg.distanceNm});
    }
  }

  selectOptimalRoute(maximumDistanceNm: number): SelectedRoute | undefined {
    const routesByDatabaseId = new Map<string, SearchRoute[]>();
    const pendingRoutes: SearchRoute[] = [];
    let bestCompleteRoute: SelectedRoute | undefined;

    for (const candidate of this.#candidateByDatabaseId.values()) {
      if (
        coverage.isAirportToNavaidNavigable(
          candidate.departureDistanceNm,
          candidate.routePoint.publishedRangeNm
        ) &&
        candidate.departureDistanceNm <= maximumDistanceNm
      ) {
        addRouteIfNondominated(
          {
            currentDatabaseId: candidate.routePoint.databaseId,
            navaids: [candidate.routePoint],
            legDistancesNm: [candidate.departureDistanceNm],
            totalDistanceNm: candidate.departureDistanceNm,
          },
          routesByDatabaseId,
          pendingRoutes
        );
      }
    }

    while (pendingRoutes.length > 0) {
      pendingRoutes.sort(compareSelectedRoutes);
      const route = pendingRoutes.shift();
      if (
        route === undefined ||
        !routesByDatabaseId.get(route.currentDatabaseId)?.includes(route)
      ) {
        continue;
      }

      const currentCandidate = this.#candidateByDatabaseId.get(route.currentDatabaseId);
      if (currentCandidate === undefined) {
        continue;
      }

      if (
        coverage.isAirportToNavaidNavigable(
          currentCandidate.arrivalDistanceNm,
          currentCandidate.routePoint.publishedRangeNm
        )
      ) {
        const completeRoute = appendArrival(route, currentCandidate.arrivalDistanceNm);
        if (
          completeRoute.totalDistanceNm <= maximumDistanceNm &&
          (bestCompleteRoute === undefined ||
            compareSelectedRoutes(completeRoute, bestCompleteRoute) < 0)
        ) {
          bestCompleteRoute = completeRoute;
        }
      }

      for (const adjacent of this.#adjacencyByDatabaseId.get(route.currentDatabaseId) ??
        []) {
        const adjacentCandidate = this.#candidateByDatabaseId.get(adjacent.databaseId);
        if (adjacentCandidate === undefined) {
          continue;
        }
        const extendedRoute: SearchRoute = {
          currentDatabaseId: adjacent.databaseId,
          navaids: [...route.navaids, adjacentCandidate.routePoint],
          legDistancesNm: [...route.legDistancesNm, adjacent.distanceNm],
          totalDistanceNm: route.totalDistanceNm + adjacent.distanceNm,
        };
        if (extendedRoute.totalDistanceNm <= maximumDistanceNm) {
          addRouteIfNondominated(extendedRoute, routesByDatabaseId, pendingRoutes);
        }
      }
    }

    return bestCompleteRoute;
  }
}

function createGraph(): IncrementalRouteGraph {
  return new IncrementalRouteGraph();
}

function addRouteIfNondominated(
  route: SearchRoute,
  routesByDatabaseId: Map<string, SearchRoute[]>,
  pendingRoutes: SearchRoute[]
): void {
  const routes = routesByDatabaseId.get(route.currentDatabaseId) ?? [];
  if (routes.some(existingRoute => dominates(existingRoute, route))) {
    return;
  }
  routesByDatabaseId.set(
    route.currentDatabaseId,
    routes.filter(existingRoute => !dominates(route, existingRoute)).concat(route)
  );
  pendingRoutes.push(route);
}

function appendArrival(route: SearchRoute, arrivalDistanceNm: number): SelectedRoute {
  return {
    navaids: route.navaids,
    legDistancesNm: [...route.legDistancesNm, arrivalDistanceNm],
    totalDistanceNm: route.totalDistanceNm + arrivalDistanceNm,
  };
}

function dominates(first: SearchRoute, second: SearchRoute): boolean {
  if (
    first.totalDistanceNm > second.totalDistanceNm ||
    first.legDistancesNm.length > second.legDistancesNm.length
  ) {
    return false;
  }
  return (
    first.legDistancesNm.length < second.legDistancesNm.length ||
    compareNavaidSequences(first.navaids, second.navaids) <= 0
  );
}

function compareSelectedRoutes(first: SelectedRoute, second: SelectedRoute): number {
  return (
    compareNumber(first.totalDistanceNm, second.totalDistanceNm) ||
    compareNumber(first.legDistancesNm.length, second.legDistancesNm.length) ||
    compareNavaidSequences(first.navaids, second.navaids)
  );
}

function compareNavaidSequences(
  first: readonly VorFamilyRoutePoint[],
  second: readonly VorFamilyRoutePoint[]
): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const firstNavaid = first[index];
    const secondNavaid = second[index];
    if (firstNavaid === undefined || secondNavaid === undefined) {
      continue;
    }
    const identityComparison =
      compareString(firstNavaid.identifier, secondNavaid.identifier) ||
      compareString(firstNavaid.databaseId, secondNavaid.databaseId);
    if (identityComparison !== 0) {
      return identityComparison;
    }
  }
  return compareNumber(first.length, second.length);
}

function compareNumber(first: number, second: number): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function compareString(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export default {createGraph, selectOptimalRoute};
