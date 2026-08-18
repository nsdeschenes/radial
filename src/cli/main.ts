import openRadialApplication from '#radial/application/RadialApplication.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import navaidReloadOutput from '#radial/cli/formatNavaidReload.js';
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
  if (isNavaidReloadHelp(args)) {
    io.writeStdout('Usage: radial data reload navaids\n');
    return 0;
  }
  if (isNavaidReload(args)) {
    return runNavaidReload({env, io, openApplication});
  }
  if (args[0] === 'data') {
    io.writeStderr(
      'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
        'Action: Run "radial data reload navaids".\n'
    );
    return 2;
  }

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

function isNavaidReload(args: readonly string[]): boolean {
  return (
    args.length === 3 &&
    args.every((value, index) => value === ['data', 'reload', 'navaids'][index])
  );
}

function isNavaidReloadHelp(args: readonly string[]): boolean {
  return (
    args.length === 4 &&
    args[0] === 'data' &&
    args[1] === 'reload' &&
    args[2] === 'navaids' &&
    args[3] === '--help'
  );
}

async function runNavaidReload({
  env,
  io,
  openApplication,
}: Omit<CliInput, 'args'> & {
  openApplication: typeof openRadialApplication;
}): Promise<number> {
  if ((env['RADIAL_DATABASE_PATH'] ?? '').trim() === '') {
    io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_DATABASE_PATH_MISSING',
        summary: 'Database path is missing.',
        cause: 'RADIAL_DATABASE_PATH is required.',
        action: 'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }
  if ((env['OPENAIP_API_KEY'] ?? '').trim() === '') {
    io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Navaid reload.',
        action: 'Set OPENAIP_API_KEY and retry the Navaid reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  const openedApplication = await openApplication({
    databasePath: env['RADIAL_DATABASE_PATH']!,
  });
  if (!openedApplication.ok) {
    io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_DATABASE_UNAVAILABLE',
        summary: 'The configured database is unavailable.',
        cause: 'The configured database could not be opened.',
        action: 'Check RADIAL_DATABASE_PATH and retry the Navaid reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  try {
    const result = await openedApplication.value.dataManagement.reloadNavaids({
      openAipApiKey: env['OPENAIP_API_KEY']!,
      onProgress(progress) {
        io.writeStderr(navaidReloadOutput.formatProgress(progress));
      },
    });
    if (!result.ok) {
      io.writeStderr(navaidReloadOutput.formatFailure(result.failure));
      return 1;
    }
    io.writeStdout(navaidReloadOutput.formatSuccess(result.value));
    return 0;
  } finally {
    await openedApplication.value[Symbol.asyncDispose]();
  }
}

export default runCli;
