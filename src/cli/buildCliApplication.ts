import {buildApplication, buildCommand, buildRouteMap, text_en} from '@stricli/core';
import type {
  Application,
  ApplicationContext,
  ApplicationText,
  BaseArgs,
  BaseFlags,
  Command,
  CommandFunction,
  StricliIntegration,
} from '@stricli/core';

import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliStricliTypes from '#radial/cli/CliStricliContext.js';
import formatCliCompatibilityDiagnostic from '#radial/cli/formatCliCompatibilityDiagnostic.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import validation from '#radial/route-planner/internal/validation.js';

type CommandSelection = CliStricliTypes['CommandSelection'];
type CliStricliContext = CliStricliTypes['Context'];

type CliApplicationContext = ApplicationContext &
  Readonly<{
    invocation: readonly string[];
  }>;

const INTERNAL_PLAN_ROUTE = '__radial_internal_plan_route__';
const ROOT_HELP =
  'Usage:\n' +
  '  radial <departure-icao> <arrival-icao> [--warnings]\n' +
  '  radial data status\n' +
  '  radial data reload navaids\n' +
  '  radial data reload airport <ICAO>\n';
const commandSelections = new WeakMap<object, CommandSelection>();

function buildCliApplication(): Application<CliStricliContext> {
  const noFlags = {};
  const noPositionals = {kind: 'tuple' as const, parameters: [] as const};
  const dataStatus = registerCommand(
    {id: 'data-status'},
    buildCommand<Readonly<Record<never, never>>, [], CliStricliContext>({
      docs: {brief: 'Read local data status'},
      loader: admittedLoader(async () => {
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
      }),
      parameters: {flags: noFlags, positional: noPositionals},
    })
  );
  const reloadNavaids = registerCommand(
    {id: 'reload-navaids'},
    buildCommand<Readonly<Record<never, never>>, [], CliStricliContext>({
      docs: {brief: 'Reload the Navaid Snapshot'},
      loader: admittedLoader(async () => {
        const commandModule = await import('#radial/cli/commands/runReloadNavaids.js');
        return runtime => commandModule.default({}, runtime);
      }),
      parameters: {flags: noFlags, positional: noPositionals},
    })
  );
  const reloadAirport = registerCommand(
    {id: 'reload-airport'},
    buildCommand<Readonly<Record<never, never>>, [icao: string], CliStricliContext>({
      docs: {brief: 'Reload one Cached Airport'},
      loader: admittedLoader(async (_flags, icao) => {
        const commandModule = await import('#radial/cli/commands/runAirportReload.js');
        return runtime => commandModule.default({icao}, runtime);
      }),
      parameters: {
        flags: noFlags,
        positional: {
          kind: 'tuple',
          parameters: [
            {brief: 'Airport ICAO', parse: parseAirportIcao, placeholder: 'ICAO'},
          ],
        },
      },
    })
  );
  const planRoute = registerCommand(
    {id: 'plan-route'},
    buildCommand<
      Readonly<{warnings?: boolean}>,
      [departureIcao: string, arrivalIcao: string],
      CliStricliContext
    >({
      docs: {brief: 'Plan a Route'},
      loader: admittedLoader(async (flags, departureIcao, arrivalIcao) => {
        const commandModule = await import('#radial/cli/commands/runPlanRoute.js');
        const request = {arrivalIcao, departureIcao};
        return async (runtime, telemetry) => {
          const result = await commandModule.default(
            {request, warningDetailsRequested: flags.warnings === true},
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
      }),
      parameters: {
        flags: {
          warnings: {
            brief: 'Show Route Plan warning details',
            kind: 'boolean',
            optional: true,
          },
        },
        positional: {
          kind: 'tuple',
          parameters: [
            {
              brief: 'Departure Airport ICAO',
              parse: parseRouteIcao,
              placeholder: 'departure-icao',
            },
            {
              brief: 'Arrival Airport ICAO',
              parse: parseRouteIcao,
              placeholder: 'arrival-icao',
            },
          ],
        },
      },
    })
  );
  const reload = buildRouteMap({
    docs: {brief: 'Reload local data'},
    routes: {airport: reloadAirport, navaids: reloadNavaids},
  });
  const data = buildRouteMap({
    docs: {brief: 'Inspect or reload local data'},
    routes: {reload, status: dataStatus},
  });
  const root = buildRouteMap({
    defaultCommand: INTERNAL_PLAN_ROUTE,
    docs: {
      brief: 'Radial flight-simulation route planner',
      hideRoute: {[INTERNAL_PLAN_ROUTE]: true},
    },
    routes: {[INTERNAL_PLAN_ROUTE]: planRoute, data},
  });

  return buildApplication(
    root,
    {
      name: 'radial',
      localization: {defaultLocale: 'en', loadText: loadCliApplicationText},
    },
    {
      help: helpIntegration(),
      lifecycle: commandSelectionIntegration(),
      missingSubcommand: missingSubcommandIntegration(),
    }
  );
}

function registerCommand(
  selection: CommandSelection,
  command: Command<CliStricliContext>
): Command<CliStricliContext> {
  commandSelections.set(command, selection);
  return command;
}

function admittedLoader<Flags extends BaseFlags, Args extends BaseArgs>(
  loadExecution: (
    flags: Flags,
    ...args: Args
  ) => Promise<CliInputTypes['CommandExecution']>
): () => Promise<CommandFunction<Flags, Args, CliStricliContext>> {
  return async () =>
    async function (flags, ...args) {
      const selection = this.selectedCommand.value;
      if (selection === undefined) {
        throw new Error('Stricli did not select a registered Radial command.');
      }

      const attributes = commandAttributes(selection.id, args);
      this.process.exitCode = await runAdmittedCliCommand(this.input, {
        metadata: {id: selection.id, ...(attributes === undefined ? {} : {attributes})},
        loadDefault: () => loadExecution(flags, ...args),
      });
    };
}

function commandAttributes(
  commandId: CliRuntimeTypes['CommandId'],
  args: readonly unknown[]
): Readonly<Record<string, string>> | undefined {
  if (commandId === 'plan-route') {
    return {
      'radial.route.arrival_icao': String(args[1]),
      'radial.route.departure_icao': String(args[0]),
    };
  }

  if (commandId === 'reload-airport') {
    return {'radial.airport.icao': String(args[0])};
  }

  return undefined;
}

function commandSelectionIntegration(): StricliIntegration<CliStricliContext> {
  return {
    hooks: {
      'command:start'({result}) {
        const selection = commandSelections.get(result.target);
        if (selection === undefined) {
          throw new Error('Stricli selected an unregistered Radial command object.');
        }

        this.selectedCommand.value = selection;
      },
    },
  };
}

function helpIntegration(): StricliIntegration<CliStricliContext> {
  return {
    flag: {
      aliases: ['h'],
      brief: 'Print help information and exit',
      global: true,
      run() {
        const context = this as CliApplicationContext;
        const help = helpForInvocation(context.invocation);
        if (help === undefined) {
          context.process.stderr.write(
            formatCliCompatibilityDiagnostic(context.invocation)
          );
          context.process.exitCode = 2;
          return;
        }

        context.process.stdout.write(help);
      },
    },
  };
}

function missingSubcommandIntegration(): StricliIntegration<CliStricliContext> {
  return {
    flag: {
      aliases: [],
      brief: 'Render Radial compatibility diagnostics for an incomplete route',
      defaultForRouteMap: true,
      global: true,
      hidden: true,
      run() {
        const context = this as CliApplicationContext;
        context.process.stderr.write(
          formatCliCompatibilityDiagnostic(context.invocation)
        );
        context.process.exitCode = 2;
      },
    },
  };
}

function helpForInvocation(invocation: readonly string[]): string | undefined {
  const key = invocation.join(' ');
  if (key === '--help') {
    return ROOT_HELP;
  }

  if (key === 'data status --help') {
    return 'Usage: radial data status\n';
  }

  if (key === 'data reload navaids --help') {
    return 'Usage: radial data reload navaids\n';
  }

  if (key === 'data reload airport --help') {
    return 'Usage: radial data reload airport <ICAO>\n';
  }

  return undefined;
}

function parseRouteIcao(this: CliStricliContext, input: string): string {
  const routeArguments =
    this.invocation.at(-1) === '--warnings'
      ? this.invocation.slice(0, -1)
      : this.invocation;
  const validated = validation.validateRoutePlanningRequest({
    arrivalIcao: routeArguments[1] ?? '',
    departureIcao: routeArguments[0] ?? '',
  });
  if (
    routeArguments.length !== 2 ||
    this.invocation[0] === INTERNAL_PLAN_ROUTE ||
    !validated.ok
  ) {
    throw new Error('Radial rejected the Route Plan invocation.');
  }

  return input.trim().toUpperCase();
}

function parseAirportIcao(input: string): string {
  const validated = validation.validateAirportIcao(input);
  if (!validated.ok) {
    throw new Error('Radial rejected the Airport ICAO.');
  }

  return validated.value;
}

function loadCliApplicationText(locale: string): ApplicationText | undefined {
  if (!locale.startsWith('en')) {
    return undefined;
  }

  const rethrow = (error: unknown): never => {
    throw error;
  };

  return {
    ...text_en,
    exceptionWhileLoadingCommandContext: rethrow,
    exceptionWhileLoadingCommandFunction: rethrow,
    exceptionWhileRunningCommand: rethrow,
    exceptionWhileRunningIntegrationFlag({exception}) {
      throw exception;
    },
    exceptionWhileRunningIntegrationHook({exception}) {
      throw exception;
    },
  };
}

export default buildCliApplication;
