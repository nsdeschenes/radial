import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';

type RoutePlanningWarningCode =
  ApplicationTypes['RoutePlanningSuccess']['warnings'][number]['code'];

type CommandMetadata =
  | Readonly<{
      id: 'plan-route';
      attributes: Readonly<{
        'radial.route.arrival_icao': string;
        'radial.route.departure_icao': string;
      }>;
    }>
  | Readonly<{id: 'data-status'}>
  | Readonly<{id: 'reload-navaids'}>
  | Readonly<{
      id: 'reload-airport';
      attributes: Readonly<{'radial.airport.icao': string}>;
    }>;

type CommandOutcome = Readonly<{status: number}>;

type OperationEvent =
  | Readonly<{
      kind: 'data-status-failed';
      activeDataPreserved: boolean;
      failureCode: ApplicationTypes['DataFailure']['code'];
    }>
  | Readonly<{
      kind: 'data-status-completed';
      cachedAirportCount: number;
      snapshotPresent: boolean;
      status: ApplicationTypes['DataStatusSuccess']['status'];
    }>
  | Readonly<{
      kind: 'route-plan-completed';
      arrivalIcao: string;
      departureIcao: string;
      routeDistanceNm: number;
      routeLegCount: number;
      warningCodes: readonly RoutePlanningWarningCode[];
    }>;

type CliTelemetrySession = Readonly<{
  execute<Result extends CommandOutcome>(
    metadata: CommandMetadata,
    operation: () => Promise<Result>
  ): Promise<Result>;
  recordOperation(event: OperationEvent): void;
  close(): Promise<void>;
}>;

export default interface CliTelemetryTypes {
  CommandMetadata: CommandMetadata;
  Loader: (
    env: Readonly<Record<string, string | undefined>>
  ) => Promise<CliTelemetrySession>;
  Session: CliTelemetrySession;
  OperationEvent: OperationEvent;
}
