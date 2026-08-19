import * as Sentry from '@sentry/node';

import openRadialApplication from '#radial/application/RadialApplication.js';
import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import dataStatusOutput from '#radial/cli/formatDataStatus.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import navaidReloadOutput from '#radial/cli/formatNavaidReload.js';
import formatRoutePlan from '#radial/cli/formatRoutePlan.js';
import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import formatRoutePlanningWarningSummary from '#radial/cli/formatRoutePlanningWarningSummary.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';
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
  signal?: AbortSignal;
};

async function runCli(input: CliInput): Promise<number> {
  const interrupt = createInterruptSignal(input.signal);
  try {
    return await runCliWithSignal({...input, signal: interrupt.signal});
  } finally {
    interrupt.dispose();
  }
}

async function runCliWithSignal({
  args,
  env,
  io,
  openApplication = openRadialApplication,
  signal,
}: Omit<CliInput, 'signal'> & {signal: AbortSignal}): Promise<number> {
  if (isNavaidReloadHelp(args)) {
    io.writeStdout('Usage: radial data reload navaids\n');
    return 0;
  }

  if (isNavaidReload(args)) {
    return runNavaidReload({env, io, openApplication, signal});
  }

  if (isAirportReloadHelp(args)) {
    io.writeStdout('Usage: radial data reload airport <ICAO>\n');
    return 0;
  }

  if (isAirportReloadOption(args)) {
    writeAirportReloadUsage(io);
    return 2;
  }

  if (isAirportReload(args)) {
    return runAirportReload({args, env, io, openApplication, signal});
  }

  if (isDataStatusHelp(args)) {
    io.writeStdout('Usage: radial data status\n');
    return 0;
  }

  if (isDataStatus(args)) {
    return runDataStatus({env, io});
  }

  if (args[0] === 'data') {
    if (args[1] === 'reload' && args[2] === 'airport') {
      writeAirportReloadUsage(io);
      return 2;
    }

    if (args[1] === 'status') {
      io.writeStderr(
        'error [DATA_USAGE]: Invalid data command.\n' +
          'Cause: The data status command accepts no arguments or operational flags.\n' +
          'Action: Run "radial data status".\n'
      );
      return 2;
    }

    io.writeStderr(
      'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
        'Action: Run "radial data reload navaids".\n'
    );
    return 2;
  }

  const warningDetailsRequested = args.at(-1) === '--warnings';
  const routeArguments = warningDetailsRequested ? args.slice(0, -1) : args;

  if (routeArguments.length !== 2) {
    io.writeStderr(diagnostics.formatArgumentCountDiagnostic(routeArguments.length));
    return 2;
  }

  const request = {
    departureIcao: routeArguments[0] ?? '',
    arrivalIcao: routeArguments[1] ?? '',
  };
  const validatedRequest = validation.validateRoutePlanningRequest(request);
  if (!validatedRequest.ok) {
    io.writeStderr(diagnostics.formatInvalidRequestDiagnostic(validatedRequest.failure));
    return 2;
  }

  const configuredFactor = env['RADIAL_MAX_ROUTE_FACTOR'];
  const openedApplication = await openApplication({
    databasePath: env['RADIAL_DATABASE_PATH'] ?? '',
    ...(configuredFactor === undefined ? {} : {maxRouteFactor: Number(configuredFactor)}),
    openAipApiKey: env['OPENAIP_API_KEY'] ?? '',
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
      const result = await openedPlanner.value.planRoute({
        ...validatedRequest.value,
        signal,
      });
      if (!result.ok) {
        io.writeStderr(diagnostics.formatRoutePlanningDiagnostic(result.failure));
        return result.failure.code === 'invalid-request' ? 2 : 1;
      }

      Sentry.metrics.distribution('total_route_legs', result.value.plan.routeLegs.length);
      Sentry.metrics.distribution(
        'total_route_distance',
        result.value.plan.totalDistanceNm,
        {
          attributes: {
            arrival_icao: request.arrivalIcao,
            departure_icao: request.departureIcao,
          },
        }
      );

      logRoutePlanningWarnings(result.value, validatedRequest.value);
      io.writeStdout(formatRoutePlan(result.value.plan));
      io.writeStderr(
        warningDetailsRequested
          ? formatRoutePlanningWarnings(result.value)
          : formatRoutePlanningWarningSummary(result.value)
      );
      return 0;
    } finally {
      await openedPlanner.value[Symbol.asyncDispose]();
    }
  } finally {
    await openedApplication.value[Symbol.asyncDispose]();
  }
}

function logRoutePlanningWarnings(
  success: ApplicationTypes['RoutePlanningSuccess'],
  request: ApplicationTypes['RoutePlanningRequest']
): void {
  if (success.warnings.length === 0) {
    return;
  }

  const attributes: Record<string, string | number> = {
    'radial.route.arrival_icao': request.arrivalIcao,
    'radial.route.departure_icao': request.departureIcao,
    'radial.route.warning_count': success.warnings.length,
  };

  for (const warning of success.warnings) {
    const countAttribute = `radial.route.warning.${warning.code}.count`;
    const currentCount = attributes[countAttribute];
    attributes[countAttribute] = typeof currentCount === 'number' ? currentCount + 1 : 1;
  }

  Sentry.logger.warn(
    Sentry.logger
      .fmt`Route plan ${request.departureIcao} to ${request.arrivalIcao} completed with warnings`,
    attributes
  );
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

function isAirportReload(args: readonly string[]): boolean {
  return (
    args.length === 4 &&
    args[0] === 'data' &&
    args[1] === 'reload' &&
    args[2] === 'airport'
  );
}

function isAirportReloadOption(args: readonly string[]): boolean {
  return (
    args.length >= 4 &&
    args[0] === 'data' &&
    args[1] === 'reload' &&
    args[2] === 'airport' &&
    args[3] !== '--help' &&
    args[3]?.startsWith('--') === true
  );
}

function isAirportReloadHelp(args: readonly string[]): boolean {
  return (
    args.length === 4 &&
    args[0] === 'data' &&
    args[1] === 'reload' &&
    args[2] === 'airport' &&
    args[3] === '--help'
  );
}

function isDataStatus(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === 'data' && args[1] === 'status';
}

function isDataStatusHelp(args: readonly string[]): boolean {
  return (
    args.length === 3 &&
    args[0] === 'data' &&
    args[1] === 'status' &&
    args[2] === '--help'
  );
}

function writeAirportReloadUsage(io: CliIo): void {
  io.writeStderr(
    'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
      'Action: Run "radial data reload airport <ICAO>".\n'
  );
}

async function runDataStatus({
  env,
  io,
}: Omit<CliInput, 'args' | 'openApplication'>): Promise<number> {
  const result = await readDataStatus(env['RADIAL_DATABASE_PATH'] ?? '');
  if (!result.ok) {
    Sentry.logger.error('Data status read failed', {
      'radial.data.active_preserved': result.failure.activeDataPreserved,
      'radial.failure.code': result.failure.code,
    });
    io.writeStderr(dataStatusOutput.formatFailure(result.failure));
    return 1;
  }

  Sentry.logger.info('Data status read completed', {
    'radial.airport.cached_count': result.value.cachedAirports.length,
    'radial.data.snapshot_present': result.value.snapshot !== null,
    'radial.data.status': result.value.status,
  });
  io.writeStdout(dataStatusOutput.formatSuccess(result.value));
  return 0;
}

async function runNavaidReload({
  env,
  io,
  openApplication,
  signal,
}: Omit<CliInput, 'args'> & {
  openApplication: typeof openRadialApplication;
  signal: AbortSignal;
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

  let openedApplication: Awaited<ReturnType<typeof openRadialApplication>>;
  try {
    openedApplication = await openApplication({
      databasePath: env['RADIAL_DATABASE_PATH']!,
    });
  } catch (error) {
    if (isInterrupted(error, signal)) {
      return 130;
    }

    io.writeStderr(navaidReloadOutput.formatFailure(unexpectedDataFailure()));
    return 1;
  }

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

  let result: ApplicationTypes['NavaidReloadResult'] | undefined;
  let interrupted = false;
  try {
    result = await openedApplication.value.dataManagement.reloadNavaids({
      openAipApiKey: env['OPENAIP_API_KEY']!,
      onProgress(progress) {
        io.writeStderr(navaidReloadOutput.formatProgress(progress));
      },
      signal,
    });
  } catch (error) {
    if (isInterrupted(error, signal)) {
      interrupted = true;
    } else {
      io.writeStderr(navaidReloadOutput.formatFailure(unexpectedDataFailure()));
    }
  }

  let disposed = true;
  try {
    await openedApplication.value[Symbol.asyncDispose]();
  } catch {
    disposed = false;
    if (!interrupted) {
      io.writeStderr(navaidReloadOutput.formatFailure(unexpectedDataFailure()));
    }
  }

  if (interrupted) {
    return 130;
  }

  if (!disposed || result === undefined) {
    return 1;
  }

  if (!result.ok) {
    io.writeStderr(navaidReloadOutput.formatFailure(result.failure));
    return 1;
  }

  io.writeStdout(navaidReloadOutput.formatSuccess(result.value));
  return 0;
}

async function runAirportReload({
  args,
  env,
  io,
  openApplication,
  signal,
}: Omit<CliInput, 'args'> & {
  args: readonly string[];
  openApplication: typeof openRadialApplication;
  signal: AbortSignal;
}): Promise<number> {
  if ((env['RADIAL_DATABASE_PATH'] ?? '').trim() === '') {
    io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_DATABASE_PATH_MISSING',
        summary: 'Database path is missing.',
        cause: 'RADIAL_DATABASE_PATH is required.',
        action:
          'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  const validatedIcao = validation.validateAirportIcao(args[3] ?? '');
  if (!validatedIcao.ok) {
    io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_INVALID_ICAO',
        summary: 'The Airport ICAO is invalid.',
        cause: `The requested Airport ICAO ${JSON.stringify(args[3] ?? '')} is not four ASCII letters.`,
        action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 2;
  }

  if ((env['OPENAIP_API_KEY'] ?? '').trim() === '') {
    io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Airport reload.',
        action: 'Set OPENAIP_API_KEY and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  let openedApplication: Awaited<ReturnType<typeof openRadialApplication>>;
  try {
    openedApplication = await openApplication({
      databasePath: env['RADIAL_DATABASE_PATH']!,
    });
  } catch (error) {
    if (isInterrupted(error, signal)) {
      return 130;
    }

    io.writeStderr(airportReloadOutput.formatFailure(unexpectedDataFailure()));
    return 1;
  }

  if (!openedApplication.ok) {
    io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_DATABASE_UNAVAILABLE',
        summary: 'The configured database is unavailable.',
        cause: 'The configured database could not be opened.',
        action: 'Check RADIAL_DATABASE_PATH and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  let result: ApplicationTypes['AirportReloadResult'] | undefined;
  let interrupted = false;
  try {
    result = await openedApplication.value.dataManagement.reloadAirport({
      icao: validatedIcao.value,
      openAipApiKey: env['OPENAIP_API_KEY']!,
      onProgress(progress) {
        io.writeStderr(airportReloadOutput.formatProgress(progress));
      },
      signal,
    });
  } catch (error) {
    if (isInterrupted(error, signal)) {
      interrupted = true;
    } else {
      io.writeStderr(airportReloadOutput.formatFailure(unexpectedDataFailure()));
    }
  }

  let disposed = true;
  try {
    await openedApplication.value[Symbol.asyncDispose]();
  } catch {
    disposed = false;
    if (!interrupted) {
      io.writeStderr(airportReloadOutput.formatFailure(unexpectedDataFailure()));
    }
  }

  if (interrupted) {
    return 130;
  }

  if (!disposed || result === undefined) {
    return 1;
  }

  if (!result.ok) {
    io.writeStderr(airportReloadOutput.formatFailure(result.failure));
    return result.failure.code === 'DATA_INVALID_ICAO' ? 2 : 1;
  }

  io.writeStdout(airportReloadOutput.formatSuccess(result.value));
  return 0;
}

function createInterruptSignal(parentSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  const onParentAbort = () => controller.abort();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  parentSignal?.addEventListener('abort', onParentAbort, {once: true});
  if (parentSignal?.aborted) {
    onParentAbort();
  }

  return {
    signal: controller.signal,
    dispose() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

function isInterrupted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function unexpectedDataFailure(): ApplicationTypes['DataFailure'] {
  return {
    code: 'DATA_DATABASE_UNAVAILABLE',
    summary: 'The configured database is unavailable.',
    cause: 'Radial could not complete the data operation.',
    action: 'Check RADIAL_DATABASE_PATH and retry.',
    activeDataPreserved: true,
  };
}

export default runCli;
