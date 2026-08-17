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

type Result<Value, Failure> = {ok: true; value: Value} | {ok: false; failure: Failure};

type RoutePlannerConfig = {
  readonly databasePath: string;
  readonly maxRouteFactor?: number;
};

type RoutePlanningRequest = {
  departureIcao: string;
  arrivalIcao: string;
};

type AirportRoutePoint = RoutePointBase & {
  kind: 'airport';
  icao: string;
};

type VorFamilyRoutePoint = RoutePointBase & {
  kind: 'vor-family';
  identifier: string;
  family: VorFamily;
  frequency: {unit: 'MHz'; value: number};
  publishedRangeNm: number;
  facilityVariation: FacilityVariation | null;
};

type NdbRoutePoint = RoutePointBase & {
  kind: 'ndb';
  identifier: string;
  frequency: {unit: 'kHz'; value: number};
  publishedRangeNm: number;
};

type RoutePoint = AirportRoutePoint | VorFamilyRoutePoint | NdbRoutePoint;

type RouteLeg = {
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

type RoutePlan = {
  totalDistanceNm: number;
  searchMode: 'vor-family' | 'ndb-fallback';
  routePoints: readonly RoutePoint[];
  routeLegs: readonly RouteLeg[];
  magneticReference: MagneticReferenceMetadata | null;
};

type RoutePlanningWarning =
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

type RoutePlanningSuccess = {
  plan: RoutePlan;
  warnings: readonly RoutePlanningWarning[];
};

type InvalidRequestFailure = {
  code: 'invalid-request';
  field: 'departureIcao' | 'arrivalIcao';
  reason: 'invalid-icao' | 'identical-airports';
  value: string;
  normalizedIcao: string;
};

type RoutePlanningFailure =
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

type PlannerOpenFailure =
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

interface RoutePlanner {
  planRoute(
    request: RoutePlanningRequest
  ): Promise<Result<RoutePlanningSuccess, RoutePlanningFailure>>;
  [Symbol.asyncDispose](): Promise<void>;
}

export default interface RoutePlannerTypes {
  AirportRoutePoint: AirportRoutePoint;
  InvalidRequestFailure: InvalidRequestFailure;
  NdbRoutePoint: NdbRoutePoint;
  PlannerOpenFailure: PlannerOpenFailure;
  PlannerOpenResult: Result<RoutePlanner, PlannerOpenFailure>;
  RouteLeg: RouteLeg;
  RoutePlan: RoutePlan;
  RoutePlanner: RoutePlanner;
  RoutePlannerConfig: RoutePlannerConfig;
  RoutePlanningFailure: RoutePlanningFailure;
  RoutePlanningRequest: RoutePlanningRequest;
  RoutePlanningResult: Result<RoutePlanningSuccess, RoutePlanningFailure>;
  RoutePlanningSuccess: RoutePlanningSuccess;
  RoutePlanningWarning: RoutePlanningWarning;
  RoutePoint: RoutePoint;
  VorFamilyRoutePoint: VorFamilyRoutePoint;
}
