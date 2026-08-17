/* eslint-disable import/no-named-export -- The approved public planner contract requires named types. */

type Coordinates = {
  latitude: number;
  longitude: number;
};

type MagneticReferenceMetadata = {
  model: string;
  version: string;
  epochYear: number;
  referenceDate: string;
  source: string;
};

type RoutePointBase = Coordinates & {
  databaseId: string;
  name: string;
  magneticDeclinationDegEast: number | null;
};

type VorFamily = 'VOR' | 'VOR-DME' | 'VORTAC' | 'DVOR' | 'DVOR-DME' | 'DVORTAC';

type FacilityVariation = {
  degreesEast: number;
  source: string;
  effectiveDate: string | null;
};

type VorGuidance = {
  trueCourseDeg: number;
  magneticCourseDeg: number | null;
};

export type Result<Value, Failure> =
  | {ok: true; value: Value}
  | {ok: false; failure: Failure};

export type RoutePlannerConfig = {
  readonly databasePath: string;
  readonly maxRouteFactor?: number;
};

export type RoutePlanningRequest = {
  departureIcao: string;
  arrivalIcao: string;
};

export type AirportRoutePoint = RoutePointBase & {
  kind: 'airport';
  icao: string;
};

export type VorFamilyRoutePoint = RoutePointBase & {
  kind: 'vor-family';
  identifier: string;
  family: VorFamily;
  frequency: {unit: 'MHz'; value: number};
  publishedRangeNm: number;
  facilityVariation: FacilityVariation | null;
};

export type NdbRoutePoint = RoutePointBase & {
  kind: 'ndb';
  identifier: string;
  frequency: {unit: 'kHz'; value: number};
  publishedRangeNm: number;
};

export type RoutePoint = AirportRoutePoint | VorFamilyRoutePoint | NdbRoutePoint;

export type RouteLeg = {
  departure: RoutePoint;
  arrival: RoutePoint;
  distanceNm: number;
  departureTrueCourseDeg: number;
  arrivalTrueCourseDeg: number;
  departureMagneticCourseDeg: number | null;
  arrivalMagneticCourseDeg: number | null;
  departureVorGuidance: VorGuidance | null;
  arrivalVorGuidance: VorGuidance | null;
};

export type RoutePlan = {
  totalDistanceNm: number;
  searchMode: 'vor-family' | 'ndb-fallback';
  routePoints: readonly RoutePoint[];
  routeLegs: readonly RouteLeg[];
  magneticReference: MagneticReferenceMetadata | null;
};

export type RoutePlanningWarning =
  | {code: 'ndb-fallback-used'}
  | {
      code: 'magnetic-course-unavailable';
      legNumber: number;
      endpoint: 'departure' | 'arrival';
    }
  | {
      code: 'vor-guidance-unavailable';
      legNumber: number;
      endpoint: 'departure' | 'arrival';
    }
  | {
      code: 'facility-variation-date-unavailable';
      legNumber: number;
      endpoint: 'departure' | 'arrival';
    };

export type RoutePlanningSuccess = {
  plan: RoutePlan;
  warnings: readonly RoutePlanningWarning[];
};

export type InvalidRequestFailure = {
  code: 'invalid-request';
  field: 'departureIcao' | 'arrivalIcao';
  reason: 'invalid-icao' | 'identical-airports';
  value: string;
  normalizedIcao: string;
};

export type RoutePlanningFailure =
  | InvalidRequestFailure
  | {code: 'airport-not-found'; role: 'departure' | 'arrival'; normalizedIcao: string}
  | {code: 'airport-ambiguous'; role: 'departure' | 'arrival'; normalizedIcao: string}
  | {code: 'database-query-failed'; operation: string}
  | {
      code: 'no-route';
      departureIcao: string;
      arrivalIcao: string;
      maxRouteFactor: number;
      completedSearchLimits: readonly number[];
    };

export type PlannerOpenFailure =
  | {
      code: 'invalid-configuration';
      field: 'databasePath';
      reason: 'required';
      value: string;
    }
  | {
      code: 'invalid-configuration';
      field: 'maxRouteFactor';
      reason: 'must-be-finite-and-at-least-one';
      value: number;
    }
  | {code: 'database-unavailable'; databasePath: string}
  | {code: 'database-contract-invalid'; violations: readonly string[]};

export interface RoutePlanner {
  planRoute(
    request: RoutePlanningRequest
  ): Promise<Result<RoutePlanningSuccess, RoutePlanningFailure>>;
  [Symbol.asyncDispose](): Promise<void>;
}
