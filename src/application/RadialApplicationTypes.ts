import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type Result<Value, Failure> = {ok: true; value: Value} | {ok: false; failure: Failure};

type RadialApplicationConfig = RoutePlannerTypes['RoutePlannerConfig'] &
  Readonly<{
    openAipApiKey?: string;
  }>;

type NavaidReloadProgress = Readonly<{
  stage: 'database' | 'openaip' | 'nasr' | 'derive' | 'publish' | 'complete';
  message: string;
}>;

type NavaidReloadRequest = Readonly<{
  openAipApiKey: string;
  onProgress?: (progress: NavaidReloadProgress) => void;
  signal?: AbortSignal;
}>;

type AirportReloadProgress = Readonly<{
  stage: 'database' | 'openaip' | 'derive' | 'publish' | 'complete';
  message: string;
}>;

type AirportReloadRequest = Readonly<{
  icao: string;
  openAipApiKey: string;
  onProgress?: (progress: AirportReloadProgress) => void;
  signal?: AbortSignal;
}>;

type DataFailure = Readonly<{
  code:
    | 'DATA_DATABASE_PATH_MISSING'
    | 'DATA_INVALID_ICAO'
    | 'DATA_CREDENTIALS_MISSING'
    | 'DATA_DATABASE_UNAVAILABLE'
    | 'DATA_DATABASE_INVALID'
    | 'DATA_OPENAIP_AUTH'
    | 'DATA_OPENAIP_FORBIDDEN'
    | 'DATA_OPENAIP_UNAVAILABLE'
    | 'DATA_OPENAIP_INVALID_RESPONSE'
    | 'DATA_AIRPORT_NOT_FOUND'
    | 'DATA_AIRPORT_AMBIGUOUS'
    | 'DATA_AIRPORT_INVALID'
    | 'DATA_SNAPSHOT_DRIFT'
    | 'DATA_NASR_UNAVAILABLE'
    | 'DATA_NASR_INVALID_RESPONSE'
    | 'DATA_MAGNETIC_MODEL_INVALID'
    | 'DATA_VALIDATION_FAILED'
    | 'DATA_DERIVATION_FAILED'
    | 'DATA_PUBLICATION_FAILED';
  summary: string;
  cause: string;
  action: string;
  activeDataPreserved: boolean;
}>;

type NavaidReloadSuccess = Readonly<{
  snapshotId: string;
  snapshotChecksum: string;
  rawNavaidCount: number;
  plannerNavaidCount: number;
  vorFamilyNavaidCount: number;
  fallbackNavaidCount: number;
  exclusionCount: number;
  exclusionCounts: readonly Readonly<{reason: string; count: number}>[];
  facilityVariationPresentCount: number;
  facilityVariationMissingCount: number;
  facilityVariationEpochYearMissingCount: number;
  retrievedAt: string;
  retrievalCompletedAt: string;
  provenance: Readonly<{
    sourceIdentity: string;
    derivationPolicyIdentity: string;
    matchingPolicyIdentity: string;
    magneticModel: Readonly<{
      model: string;
      version: string;
      epochYear: number;
      referenceDate: string;
      source: string;
      coefficientChecksum: string;
    }>;
    faaNasr: Readonly<{
      archiveChecksum: string;
      archiveIdentity: string;
      contentChecksum: string;
      cycleId: string;
      effectiveDate: string;
      publishedAt: string;
      retrievedAt: string;
      sourceUrl: string;
    }>;
  }>;
}>;

type NavaidReloadResult = Result<NavaidReloadSuccess, DataFailure>;

type AirportReloadSuccess = Readonly<{
  status: 'cached' | 'replaced';
  icao: string;
  sourceId: string;
  retrievedAt: string;
}>;

type AirportReloadResult = Result<AirportReloadSuccess, DataFailure>;

type PlanningOpenFailure = RoutePlannerTypes['PlannerOpenFailure'] | DataFailure;
type PlanningOpenResult = Result<RoutePlannerTypes['RoutePlanner'], PlanningOpenFailure>;

interface PlanningCapability {
  open(): Promise<PlanningOpenResult>;
}

interface DataManagementCapability {
  reloadNavaids(request: NavaidReloadRequest): Promise<NavaidReloadResult>;
  reloadAirport(request: AirportReloadRequest): Promise<AirportReloadResult>;
}

interface RadialApplication {
  readonly databasePath: string;
  readonly planning: PlanningCapability;
  readonly dataManagement: DataManagementCapability;
  [Symbol.asyncDispose](): Promise<void>;
}

export default interface RadialApplicationTypes {
  Application: RadialApplication;
  ApplicationConfig: RadialApplicationConfig;
  ApplicationOpenFailure: RoutePlannerTypes['PlannerOpenFailure'];
  ApplicationOpenResult: Result<
    RadialApplication,
    RoutePlannerTypes['PlannerOpenFailure']
  >;
  DataFailure: DataFailure;
  DataManagementCapability: DataManagementCapability;
  AirportReloadProgress: AirportReloadProgress;
  AirportReloadRequest: AirportReloadRequest;
  AirportReloadResult: AirportReloadResult;
  AirportReloadSuccess: AirportReloadSuccess;
  NavaidReloadProgress: NavaidReloadProgress;
  NavaidReloadRequest: NavaidReloadRequest;
  NavaidReloadResult: NavaidReloadResult;
  NavaidReloadSuccess: NavaidReloadSuccess;
  PlanningCapability: PlanningCapability;
  PlanningOpenFailure: PlanningOpenFailure;
  PlanningOpenResult: PlanningOpenResult;
  Planner: RoutePlannerTypes['RoutePlanner'];
  PlannerOpenFailure: RoutePlannerTypes['PlannerOpenFailure'];
  PlannerOpenResult: RoutePlannerTypes['PlannerOpenResult'];
  RoutePlanningFailure: RoutePlannerTypes['RoutePlanningFailure'];
  RoutePlanningRequest: RoutePlannerTypes['RoutePlanningRequest'];
  RoutePlanningResult: RoutePlannerTypes['RoutePlanningResult'];
  RoutePlanningSuccess: RoutePlannerTypes['RoutePlanningSuccess'];
}
