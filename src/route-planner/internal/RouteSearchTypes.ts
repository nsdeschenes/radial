import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type NavaidRoutePoint =
  | RoutePlannerTypes['VorFamilyRoutePoint']
  | RoutePlannerTypes['NdbRoutePoint'];

type CandidateFamily = 'vor-family' | 'ndb';

type MeasuredCandidate = Readonly<{
  routePoint: NavaidRoutePoint;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

type NavaidPairDistance = Readonly<{
  firstDatabaseId: string;
  secondDatabaseId: string;
  distanceNm: number;
}>;

type SelectedRoute = Readonly<{
  navaids: readonly NavaidRoutePoint[];
  legDistancesNm: readonly number[];
  totalDistanceNm: number;
}>;

type RouteSearchResult =
  | Readonly<{
      status: 'found';
      route: SelectedRoute;
      searchMode: RoutePlannerTypes['RoutePlan']['searchMode'];
    }>
  | Readonly<{status: 'exhausted'; completedSearchFactors: readonly number[]}>
  | Readonly<{status: 'failed'; phase: 'vor-family' | 'ndb-fallback'}>;

type RouteSearchDataSource = Readonly<{
  directDistanceNm(): Promise<number>;
  findNewCandidates(
    family: CandidateFamily,
    nextLimitNm: number,
    measuredDatabaseIds: readonly string[]
  ): Promise<readonly MeasuredCandidate[]>;
  findNewPairs(
    newlyAdmittedCandidates: readonly MeasuredCandidate[],
    admittedDatabaseIds: readonly string[]
  ): Promise<readonly NavaidPairDistance[]>;
}>;

export default interface RouteSearchTypes {
  CandidateFamily: CandidateFamily;
  MeasuredCandidate: MeasuredCandidate;
  NavaidPairDistance: NavaidPairDistance;
  RouteSearchDataSource: RouteSearchDataSource;
  RouteSearchResult: RouteSearchResult;
  SelectedRoute: SelectedRoute;
}
