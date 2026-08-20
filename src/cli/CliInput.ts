import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type CommandExecution = (
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
) => Promise<CliCommandResultTypes['Result']>;

type CliInput = Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  io: CliRuntimeTypes['Io'];
  loadCommand?: (
    commandId: CliRuntimeTypes['CommandId'],
    loadDefault: () => Promise<CommandExecution>
  ) => Promise<CommandExecution>;
  loadTelemetry?: CliTelemetryTypes['Loader'];
  openApplication?: CliRuntimeTypes['ApplicationOpener'];
  signal?: AbortSignal;
}>;

export default interface CliInputTypes {
  Input: CliInput;
  CommandExecution: CommandExecution;
}
