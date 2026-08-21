import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type AdmittedCommand = Readonly<{
  metadata: CliTelemetryTypes['CommandMetadata'];
  execute: (
    runtime: CliRuntimeTypes['Context'],
    telemetry: CliTelemetryTypes['Session']
  ) => Promise<CommandStatus>;
}>;

type CompatibilityCommand = Readonly<{
  metadata: CliTelemetryTypes['CommandMetadata'];
  loadDefault: () => Promise<CliInputTypes['CommandExecution']>;
}>;

type CommandStatus = 0 | 1 | 2 | 130;

function runAdmittedCliCommand(
  input: CliInputTypes['Admitted'],
  command: AdmittedCommand
): Promise<CommandStatus>;
function runAdmittedCliCommand(
  input: CliInputTypes['Input'],
  command: CompatibilityCommand
): Promise<CommandStatus>;
async function runAdmittedCliCommand(
  input: CliInputTypes['Admitted'] | CliInputTypes['Input'],
  command: AdmittedCommand | CompatibilityCommand
): Promise<CommandStatus> {
  const environmentSnapshot = Object.freeze({...input.env});
  const loadTelemetry = input.loadTelemetry ?? loadSentryTelemetry;
  const telemetry = await loadTelemetry(environmentSnapshot);
  try {
    const result = await telemetry.execute(command.metadata, async () => {
      const runtime = createCliRuntimeContext({
        env: environmentSnapshot,
        io: input.io,
        signal: input.signal ?? new AbortController().signal,
        ...(input.openApplication === undefined
          ? {}
          : {loadApplication: async () => input.openApplication!}),
      });
      runtime.selectCommand(command.metadata.id);
      try {
        if ('execute' in command) {
          const status = await command.execute(runtime.context, telemetry);
          return commandResultFor(status);
        }

        const compatibilityInput = input as CliInputTypes['Input'];
        const execute =
          compatibilityInput.loadCommand === undefined
            ? await command.loadDefault()
            : await compatibilityInput.loadCommand(
                command.metadata.id,
                command.loadDefault
              );
        return await execute(runtime.context, telemetry);
      } finally {
        await runtime[Symbol.asyncDispose]();
      }
    });
    return result.status;
  } finally {
    try {
      await telemetry.close();
    } catch {
      // Telemetry shutdown is best-effort and must not replace the CLI outcome.
    }
  }
}

function commandResultFor(status: CommandStatus): CliCommandResultTypes['Result'] {
  if (status === 0) {
    return {kind: 'success', status};
  }

  if (status === 130) {
    return {kind: 'interrupted', status};
  }

  return {kind: 'expected-failure', status};
}

async function loadSentryTelemetry(
  env: Readonly<Record<string, string | undefined>>
): Promise<CliTelemetryTypes['Session']> {
  const telemetryModule = await import('#radial/cli/telemetry/loadSentryCliTelemetry.js');
  return telemetryModule.default(env);
}

export default runAdmittedCliCommand;
