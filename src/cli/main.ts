import diagnostics from '#radial/cli/formatDiagnostics.js';
import validation from '#radial/route-planner/internal/validation.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';

type CliIo = {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
};

type CliInput = {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  io: CliIo;
};

async function runCli({args, env, io}: CliInput): Promise<number> {
  if (args.length !== 2) {
    io.writeStderr(diagnostics.formatArgumentCountDiagnostic(args.length));
    return 2;
  }

  const request = {departureIcao: args[0] ?? '', arrivalIcao: args[1] ?? ''};
  const validatedRequest = validation.validateRoutePlanningRequest(request);
  if (!validatedRequest.ok) {
    io.writeStderr(diagnostics.formatInvalidRequestDiagnostic(validatedRequest.failure));
    return 2;
  }

  const configuredFactor = env['RADIAL_MAX_ROUTE_FACTOR'];
  const opened = await openRoutePlanner({
    databasePath: env['RADIAL_DATABASE_PATH'] ?? '',
    ...(configuredFactor === undefined ? {} : {maxRouteFactor: Number(configuredFactor)}),
  });

  if (!opened.ok) {
    io.writeStderr(diagnostics.formatPlannerOpenDiagnostic(opened.failure));
    return 1;
  }

  try {
    const result = await opened.value.planRoute(validatedRequest.value);
    if (!result.ok) {
      io.writeStderr(diagnostics.formatRoutePlanningDiagnostic(result.failure));
      return result.failure.code === 'invalid-request' ? 2 : 1;
    }

    throw new Error(
      'Route Plan presentation is not available in this implementation slice.'
    );
  } finally {
    await opened.value[Symbol.asyncDispose]();
  }
}

export default runCli;
