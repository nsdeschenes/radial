import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import validation from '#radial/route-planner/internal/validation.js';

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

type AdmittedCommand = Readonly<{
  metadata: CliTelemetryTypes['CommandMetadata'];
  loadDefault: () => Promise<CommandExecution>;
}>;

async function runCli(input: CliInput): Promise<number> {
  const {args, io} = input;
  if (isNavaidReloadHelp(args)) {
    io.writeStdout('Usage: radial data reload navaids\n');
    return 0;
  }

  if (isNavaidReload(args)) {
    return executeAdmittedCommand(input, {
      metadata: {id: 'reload-navaids'},
      async loadDefault() {
        const commandModule = await import('#radial/cli/commands/runReloadNavaids.js');
        return runtime => commandModule.default({}, runtime);
      },
    });
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
    const rawIcao = args[3] ?? '';
    const validatedIcao = validation.validateAirportIcao(rawIcao);
    if (!validatedIcao.ok) {
      io.writeStderr(
        airportReloadOutput.formatFailure({
          code: 'DATA_INVALID_ICAO',
          summary: 'The Airport ICAO is invalid.',
          cause: `The requested Airport ICAO ${JSON.stringify(rawIcao)} is not four ASCII letters.`,
          action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
          activeDataPreserved: true,
        })
      );
      return 2;
    }

    return executeAdmittedCommand(input, {
      metadata: {
        id: 'reload-airport',
        attributes: {'radial.airport.icao': validatedIcao.value},
      },
      async loadDefault() {
        const commandModule = await import('#radial/cli/commands/runAirportReload.js');
        return runtime => commandModule.default({icao: validatedIcao.value}, runtime);
      },
    });
  }

  if (isDataStatusHelp(args)) {
    io.writeStdout('Usage: radial data status\n');
    return 0;
  }

  if (isDataStatus(args)) {
    return executeAdmittedCommand(input, {
      metadata: {id: 'data-status'},
      async loadDefault() {
        const commandModule = await import('#radial/cli/commands/runDataStatus.js');
        return async (runtime, telemetry) => {
          const result = await commandModule.default({}, runtime);
          if (result.kind === 'expected-failure') {
            telemetry.recordOperation({
              kind: 'data-status-failed',
              activeDataPreserved: result.failure.activeDataPreserved,
              failureCode: result.failure.code,
            });
          } else if (result.kind === 'success') {
            telemetry.recordOperation({
              kind: 'data-status-completed',
              cachedAirportCount: result.success.cachedAirports.length,
              snapshotPresent: result.success.snapshot !== null,
              status: result.success.status,
            });
          }

          return result;
        };
      },
    });
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

  return executeAdmittedCommand(input, {
    metadata: {
      id: 'plan-route',
      attributes: {
        'radial.route.arrival_icao': validatedRequest.value.arrivalIcao,
        'radial.route.departure_icao': validatedRequest.value.departureIcao,
      },
    },
    async loadDefault() {
      const commandModule = await import('#radial/cli/commands/runPlanRoute.js');
      return async (runtime, telemetry) => {
        const result = await commandModule.default(
          {request: validatedRequest.value, warningDetailsRequested},
          runtime
        );
        if (result.kind === 'success') {
          telemetry.recordOperation({
            kind: 'route-plan-completed',
            arrivalIcao: result.request.arrivalIcao,
            departureIcao: result.request.departureIcao,
            routeDistanceNm: result.success.plan.totalDistanceNm,
            routeLegCount: result.success.plan.routeLegs.length,
            warningCodes: result.success.warnings.map(warning => warning.code),
          });
        }

        return result;
      };
    },
  });
}

async function executeAdmittedCommand(
  input: CliInput,
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

function writeAirportReloadUsage(io: CliRuntimeTypes['Io']): void {
  io.writeStderr(
    'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
      'Action: Run "radial data reload airport <ICAO>".\n'
  );
}

export default runCli;
