import openRadialApplication from '#radial/application/RadialApplication.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import formatRoutePlan from '#radial/cli/formatRoutePlan.js';
import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import validation from '#radial/route-planner/internal/validation.js';

type CliIo = {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
};

type CliInput = {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  io: CliIo;
  openApplication?: typeof openRadialApplication;
};

async function runCli({
  args,
  env,
  io,
  openApplication = openRadialApplication,
}: CliInput): Promise<number> {
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
  const openedApplication = await openApplication({
    databasePath: env['RADIAL_DATABASE_PATH'] ?? '',
    ...(configuredFactor === undefined ? {} : {maxRouteFactor: Number(configuredFactor)}),
  });

  if (!openedApplication.ok) {
    io.writeStderr(diagnostics.formatPlannerOpenDiagnostic(openedApplication.failure));
    return 1;
  }

  try {
    const openedPlanner = await openedApplication.value.planning.open();
    if (!openedPlanner.ok) {
      io.writeStderr(diagnostics.formatPlannerOpenDiagnostic(openedPlanner.failure));
      return 1;
    }

    try {
      const result = await openedPlanner.value.planRoute(validatedRequest.value);
      if (!result.ok) {
        io.writeStderr(diagnostics.formatRoutePlanningDiagnostic(result.failure));
        return result.failure.code === 'invalid-request' ? 2 : 1;
      }

      io.writeStdout(formatRoutePlan(result.value.plan));
      io.writeStderr(formatRoutePlanningWarnings(result.value));
      return 0;
    } finally {
      await openedPlanner.value[Symbol.asyncDispose]();
    }
  } finally {
    await openedApplication.value[Symbol.asyncDispose]();
  }
}

export default runCli;
