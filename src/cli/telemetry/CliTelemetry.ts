import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import type runCli from '#radial/cli/runCli.js';

type CliCommandTypes = NonNullable<(typeof runCli)['commandTypes']>;
type RoutePlanningWarningCode =
  ApplicationTypes['RoutePlanningSuccess']['warnings'][number]['code'];

type CommandMetadata = CliCommandTypes['metadata'];

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
  execute(
    metadata: CommandMetadata,
    operation: () => Promise<CliCommandResultTypes['Result']>
  ): Promise<CliCommandResultTypes['Result']>;
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
