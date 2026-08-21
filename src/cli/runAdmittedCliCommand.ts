import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type AdmittedCommand =
  | Readonly<{
      applicationAccess: false;
      metadata: CliTelemetryTypes['CommandMetadata'];
      execute: (
        runtime: CliRuntimeTypes['LifecycleContext'],
        telemetry: CliTelemetryTypes['Session']
      ) => Promise<CommandStatus>;
    }>
  | Readonly<{
      applicationAccess?: true;
      metadata: CliTelemetryTypes['CommandMetadata'];
      execute: (
        runtime: CliRuntimeTypes['Context'],
        telemetry: CliTelemetryTypes['Session']
      ) => Promise<CommandStatus>;
    }>;

type CommandStatus = 0 | 1 | 2 | 130;
type CommandResult =
  | Readonly<{kind: 'success'; status: 0}>
  | Readonly<{kind: 'expected-failure'; status: 1 | 2}>
  | Readonly<{kind: 'interrupted'; status: 130}>;

async function runAdmittedCliCommand(
  input: CliInputTypes['Admitted'],
  command: AdmittedCommand
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
      try {
        const status =
          command.applicationAccess === false
            ? await command.execute(runtime.lifecycleContext, telemetry)
            : await command.execute(runtime.context, telemetry);
        return commandResultFor(status);
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

function commandResultFor(status: CommandStatus): CommandResult {
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
