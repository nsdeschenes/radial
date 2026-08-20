import type CliInputTypes from '#radial/cli/CliInput.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type AdmittedCommand = Readonly<{
  metadata: CliTelemetryTypes['CommandMetadata'];
  loadDefault: () => Promise<CliInputTypes['CommandExecution']>;
}>;

async function runAdmittedCliCommand(
  input: CliInputTypes['Input'],
  command: AdmittedCommand
): Promise<number> {
  const loadTelemetry = input.loadTelemetry ?? loadSentryTelemetry;
  const telemetry = await loadTelemetry(input.env);
  try {
    const result = await telemetry.execute(command.metadata, async () => {
      const runtime = createCliRuntimeContext({
        env: input.env,
        io: input.io,
        signal: input.signal ?? new AbortController().signal,
        ...(input.openApplication === undefined
          ? {}
          : {loadApplication: async () => input.openApplication!}),
      });
      runtime.selectCommand(command.metadata.id);
      try {
        const execute =
          input.loadCommand === undefined
            ? await command.loadDefault()
            : await input.loadCommand(command.metadata.id, command.loadDefault);
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

async function loadSentryTelemetry(
  env: Readonly<Record<string, string | undefined>>
): Promise<CliTelemetryTypes['Session']> {
  const telemetryModule = await import('#radial/cli/telemetry/loadSentryCliTelemetry.js');
  return telemetryModule.default(env);
}

export default runAdmittedCliCommand;
