import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type Result<Value, Failure> = {ok: true; value: Value} | {ok: false; failure: Failure};

type RadialApplicationConfig = RoutePlannerTypes['RoutePlannerConfig'];

interface PlanningCapability {
  open(): Promise<RoutePlannerTypes['PlannerOpenResult']>;
}

type DataManagementCapability = Readonly<Record<never, never>>;

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
  DataManagementCapability: DataManagementCapability;
  PlanningCapability: PlanningCapability;
  Planner: RoutePlannerTypes['RoutePlanner'];
  PlannerOpenFailure: RoutePlannerTypes['PlannerOpenFailure'];
  PlannerOpenResult: RoutePlannerTypes['PlannerOpenResult'];
  RoutePlanningFailure: RoutePlannerTypes['RoutePlanningFailure'];
  RoutePlanningRequest: RoutePlannerTypes['RoutePlanningRequest'];
  RoutePlanningResult: RoutePlannerTypes['RoutePlanningResult'];
  RoutePlanningSuccess: RoutePlannerTypes['RoutePlanningSuccess'];
}
