import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type CommandExecution = (
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
) => Promise<CliCommandResultTypes['Result']>;

type AdmittedCliInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  io: CliRuntimeTypes['Io'];
  loadTelemetry?: CliTelemetryTypes['Loader'];
  openApplication?: CliRuntimeTypes['ApplicationOpener'];
  signal?: AbortSignal;
}>;

type CliInput = AdmittedCliInput &
  Readonly<{
    args: readonly string[];
    loadCommand?: (
      commandId: CliRuntimeTypes['CommandId'],
      loadDefault: () => Promise<CommandExecution>
    ) => Promise<CommandExecution>;
  }>;

export default interface CliInputTypes {
  Admitted: AdmittedCliInput;
  Input: CliInput;
  CommandExecution: CommandExecution;
}
