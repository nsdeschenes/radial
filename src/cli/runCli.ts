import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  ExitCode,
  run,
  text_en,
} from '@stricli/core';
import type {
  Application,
  ApplicationContext,
  ApplicationText,
  BaseArgs,
  BaseFlags,
  Command,
  CommandBuilderArguments,
  CommandContext,
  CommandFunction,
  StricliIntegration,
  StricliProcess,
} from '@stricli/core';

import type CliInputTypes from '#radial/cli/CliInput.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import validation from '#radial/route-planner/internal/validation.js';

type SelectedDescriptionCell = {value: object | undefined};
type CliStricliContext = CommandContext &
  Readonly<{
    input: CliInputTypes['Input'];
    invocation: readonly string[];
    process: StricliProcess;
    selectedDescription: SelectedDescriptionCell;
  }>;
type CliApplicationContext = ApplicationContext &
  Readonly<{invocation: readonly string[]}>;

type CommandDescription<
  Flags extends BaseFlags,
  Args extends BaseArgs,
  Id extends string,
  Metadata extends Readonly<{id: Id}>,
> = Readonly<{
  id: Id;
  route: readonly string[];
  docs: CommandBuilderArguments<Flags, Args, CliStricliContext>['docs'];
  parameters: CommandBuilderArguments<Flags, Args, CliStricliContext>['parameters'];
  help: Readonly<{leafUsage?: string; rootUsageLine: string}>;
  rejection: Readonly<{
    owns(invocation: readonly string[]): boolean;
    format(invocation: readonly string[]): string | undefined;
  }>;
  metadata(flags: Flags, ...args: Args): Metadata;
  loadExecution(flags: Flags, ...args: Args): Promise<CliInputTypes['CommandExecution']>;
}>;

type RoutePlanFlags = Readonly<{warnings?: boolean}>;
type RoutePlanArgs = [departureIcao: string, arrivalIcao: string];
type AirportReloadArgs = [icao: string];
type NoFlags = Readonly<Record<never, never>>;
type NoArgs = [];

const INTERNAL_PLAN_ROUTE = '__radial_internal_plan_route__';
const airportReloadUsage =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
  'Action: Run "radial data reload airport <ICAO>".\n';

function describeCommand<Flags extends BaseFlags, Args extends BaseArgs>() {
  return <const Id extends string, const Metadata extends Readonly<{id: Id}>>(
    description: CommandDescription<Flags, Args, Id, Metadata>
  ) => description;
}

const routePlan = describeCommand<RoutePlanFlags, RoutePlanArgs>()({
  id: 'plan-route',
  route: [],
  docs: {brief: 'Plan a Route'},
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
          parse(this: CliStricliContext) {
            return parseRoutePlanInvocation(this.invocation).departureIcao;
          },
          placeholder: 'departure-icao',
        },
        {
          brief: 'Arrival Airport ICAO',
          parse(this: CliStricliContext) {
            return parseRoutePlanInvocation(this.invocation).arrivalIcao;
          },
          placeholder: 'arrival-icao',
        },
      ],
    },
  },
  help: {
    rootUsageLine: '  radial <departure-icao> <arrival-icao> [--warnings]\n',
  },
  rejection: {
    owns(invocation) {
      return invocation[0] !== 'data';
    },
    format(invocation) {
      const routeArguments = routeArgumentsFromInvocation(invocation);
      if (routeArguments.length !== 2) {
        return diagnostics.formatArgumentCountDiagnostic(routeArguments.length);
      }

      const validated = validation.validateRoutePlanningRequest({
        arrivalIcao: routeArguments[1] ?? '',
        departureIcao: routeArguments[0] ?? '',
      });
      return validated.ok
        ? undefined
        : diagnostics.formatInvalidRequestDiagnostic(validated.failure);
    },
  },
  metadata(_flags, departureIcao, arrivalIcao) {
    return {
      id: 'plan-route',
      attributes: {
        'radial.route.arrival_icao': arrivalIcao,
        'radial.route.departure_icao': departureIcao,
      },
    } as const;
  },
  async loadExecution(flags, departureIcao, arrivalIcao) {
    const commandModule = await import('#radial/cli/commands/runPlanRoute.js');
    const request = {arrivalIcao, departureIcao};
    return (runtime, telemetry) =>
      commandModule.default(
        {request, warningDetailsRequested: flags.warnings === true},
        runtime,
        telemetry
      );
  },
});

const dataStatus = describeCommand<NoFlags, NoArgs>()({
  id: 'data-status',
  route: ['data', 'status'],
  docs: {brief: 'Read local data status'},
  parameters: {
    flags: {},
    positional: {kind: 'tuple', parameters: []},
  },
  help: {
    leafUsage: 'Usage: radial data status\n',
    rootUsageLine: '  radial data status\n',
  },
  rejection: {
    owns(invocation) {
      return invocation[0] === 'data' && invocation[1] === 'status';
    },
    format(invocation) {
      if (matchesInvocation(invocation, dataStatus.route)) {
        return undefined;
      }

      return (
        'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The data status command accepts no arguments or operational flags.\n' +
        'Action: Run "radial data status".\n'
      );
    },
  },
  metadata() {
    return {id: 'data-status'} as const;
  },
  async loadExecution() {
    const commandModule = await import('#radial/cli/commands/runDataStatus.js');
    return (runtime, telemetry) => commandModule.default({}, runtime, telemetry);
  },
});

const reloadNavaids = describeCommand<NoFlags, NoArgs>()({
  id: 'reload-navaids',
  route: ['data', 'reload', 'navaids'],
  docs: {brief: 'Reload the Navaid Snapshot'},
  parameters: {
    flags: {},
    positional: {kind: 'tuple', parameters: []},
  },
  help: {
    leafUsage: 'Usage: radial data reload navaids\n',
    rootUsageLine: '  radial data reload navaids\n',
  },
  rejection: {
    owns(invocation) {
      return (
        invocation[0] === 'data' &&
        invocation[1] !== 'status' &&
        !(invocation[1] === 'reload' && invocation[2] === 'airport')
      );
    },
    format(invocation) {
      if (matchesInvocation(invocation, reloadNavaids.route)) {
        return undefined;
      }

      return (
        'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
        'Action: Run "radial data reload navaids".\n'
      );
    },
  },
  metadata() {
    return {id: 'reload-navaids'} as const;
  },
  async loadExecution() {
    const commandModule = await import('#radial/cli/commands/runReloadNavaids.js');
    return runtime => commandModule.default({}, runtime);
  },
});

const reloadAirport = describeCommand<NoFlags, AirportReloadArgs>()({
  id: 'reload-airport',
  route: ['data', 'reload', 'airport'],
  docs: {brief: 'Reload one Cached Airport'},
  parameters: {
    flags: {},
    positional: {
      kind: 'tuple',
      parameters: [
        {
          brief: 'Airport ICAO',
          parse: parseAirportReloadInvocation,
          placeholder: 'ICAO',
        },
      ],
    },
  },
  help: {
    rootUsageLine: '  radial data reload airport <ICAO>\n',
    leafUsage: 'Usage: radial data reload airport <ICAO>\n',
  },
  rejection: {
    owns(invocation) {
      return (
        invocation[0] === 'data' &&
        invocation[1] === 'reload' &&
        invocation[2] === 'airport'
      );
    },
    format(invocation) {
      const value = invocation[3];
      if (invocation.length === 4 && value !== undefined && !value.startsWith('--')) {
        const validated = validation.validateAirportIcao(value);
        if (validated.ok) {
          return undefined;
        }

        return airportReloadOutput.formatFailure({
          code: 'DATA_INVALID_ICAO',
          summary: 'The Airport ICAO is invalid.',
          cause: `The requested Airport ICAO ${JSON.stringify(value)} is not four ASCII letters.`,
          action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
          activeDataPreserved: true,
        });
      }

      return airportReloadUsage;
    },
  },
  metadata(_flags, icao) {
    return {
      id: 'reload-airport',
      attributes: {'radial.airport.icao': icao},
    } as const;
  },
  async loadExecution(_flags, icao) {
    const commandModule = await import('#radial/cli/commands/runAirportReload.js');
    return runtime => commandModule.default({icao}, runtime);
  },
});

const commandDescriptions = [
  routePlan,
  dataStatus,
  reloadNavaids,
  reloadAirport,
] as const;
type CatalogCommandDescription = (typeof commandDescriptions)[number];
type CatalogCommandId = CatalogCommandDescription['id'];
type CatalogCommandMetadata = ReturnType<CatalogCommandDescription['metadata']>;

interface RunCli {
  (input: CliInputTypes['Input']): Promise<number>;
  readonly commandTypes?: Readonly<{
    id: CatalogCommandId;
    metadata: CatalogCommandMetadata;
  }>;
}

const ROOT_HELP =
  'Usage:\n' +
  commandDescriptions.map(description => description.help.rootUsageLine).join('');
const commandSelections = new WeakMap<object, object>();
const application = buildCliApplication();

function parseRoutePlanInvocation(invocation: readonly string[]) {
  const routeArguments = routeArgumentsFromInvocation(invocation);
  const validated = validation.validateRoutePlanningRequest({
    arrivalIcao: routeArguments[1] ?? '',
    departureIcao: routeArguments[0] ?? '',
  });
  if (routeArguments.length !== 2 || !validated.ok) {
    throw new Error('Radial rejected the Route Plan invocation.');
  }

  return validated.value;
}

function routeArgumentsFromInvocation(invocation: readonly string[]) {
  return invocation.at(-1) === '--warnings' ? invocation.slice(0, -1) : invocation;
}

function parseAirportReloadInvocation(input: string): string {
  const validated = validation.validateAirportIcao(input);
  if (!validated.ok) {
    throw new Error('Radial rejected the Airport ICAO.');
  }

  return validated.value;
}

function matchesInvocation(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

function buildCliApplication(): Application<CliStricliContext> {
  const compiledCommands = new Map<object, Command<CliStricliContext>>([
    [routePlan, buildDescribedCommand(routePlan)],
    [dataStatus, buildDescribedCommand(dataStatus)],
    [reloadNavaids, buildDescribedCommand(reloadNavaids)],
    [reloadAirport, buildDescribedCommand(reloadAirport)],
  ]);
  const commandFor = (description: CatalogCommandDescription) => {
    const command = compiledCommands.get(description);
    if (command === undefined) {
      throw new Error(
        `Radial command ${JSON.stringify(description.id)} was not compiled.`
      );
    }

    return command;
  };

  const reload = buildRouteMap({
    docs: {brief: 'Reload local data'},
    routes: {
      [routeToken(reloadAirport, 2)]: commandFor(reloadAirport),
      [routeToken(reloadNavaids, 2)]: commandFor(reloadNavaids),
    },
  });
  const data = buildRouteMap({
    docs: {brief: 'Inspect or reload local data'},
    routes: {
      [routeToken(reloadNavaids, 1)]: reload,
      [routeToken(dataStatus, 1)]: commandFor(dataStatus),
    },
  });
  const root = buildRouteMap({
    defaultCommand: INTERNAL_PLAN_ROUTE,
    docs: {
      brief: 'Radial flight-simulation route planner',
      hideRoute: {[INTERNAL_PLAN_ROUTE]: true},
    },
    routes: {
      [INTERNAL_PLAN_ROUTE]: commandFor(routePlan),
      [routeToken(dataStatus, 0)]: data,
    },
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

function routeToken(description: CatalogCommandDescription, index: number): string {
  const token = description.route[index];
  if (token === undefined) {
    throw new Error(
      `Radial command ${JSON.stringify(description.id)} has no route token at index ${index}.`
    );
  }

  return token;
}

function buildDescribedCommand<
  Flags extends BaseFlags,
  Args extends BaseArgs,
  Id extends CatalogCommandId,
  Metadata extends Extract<CatalogCommandMetadata, Readonly<{id: Id}>>,
>(
  description: CommandDescription<Flags, Args, Id, Metadata>
): Command<CliStricliContext> {
  const command = buildCommand<Flags, Args, CliStricliContext>({
    docs: description.docs,
    loader: admittedLoader(description),
    parameters: description.parameters,
  });
  commandSelections.set(command, description);
  return command;
}

function admittedLoader<
  Flags extends BaseFlags,
  Args extends BaseArgs,
  Id extends CatalogCommandId,
  Metadata extends Extract<CatalogCommandMetadata, Readonly<{id: Id}>>,
>(
  description: CommandDescription<Flags, Args, Id, Metadata>
): () => Promise<CommandFunction<Flags, Args, CliStricliContext>> {
  return async () =>
    async function (flags, ...args) {
      if (this.selectedDescription.value !== description) {
        throw new Error('Stricli did not select the expected registered Radial command.');
      }

      const metadata = description.metadata(flags, ...args);
      this.process.exitCode = await runAdmittedCliCommand(this.input, {
        metadata,
        loadDefault: () => description.loadExecution(flags, ...args),
      });
    };
}

function commandSelectionIntegration(): StricliIntegration<CliStricliContext> {
  return {
    hooks: {
      'command:start'({result}) {
        const description = commandSelections.get(result.target);
        if (description === undefined) {
          throw new Error('Stricli selected an unregistered Radial command object.');
        }

        this.selectedDescription.value = description;
      },
    },
  };
}

function helpIntegration(): StricliIntegration<CliStricliContext> {
  return {
    flag: {
      aliases: [],
      brief: 'Print help information and exit',
      global: true,
      run() {
        const context = this as CliApplicationContext;
        const help = helpForInvocation(context.invocation);
        if (help === undefined) {
          context.process.stderr.write(rejectedInvocationDiagnostic(context.invocation));
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
        context.process.stderr.write(rejectedInvocationDiagnostic(context.invocation));
        context.process.exitCode = 2;
      },
    },
  };
}

function helpForInvocation(invocation: readonly string[]): string | undefined {
  if (matchesInvocation(invocation, ['--help'])) {
    return ROOT_HELP;
  }

  const description = commandDescriptions.find(
    candidate =>
      candidate.help.leafUsage !== undefined &&
      matchesInvocation(invocation, [...candidate.route, '--help'])
  );
  return description?.help.leafUsage;
}

function rejectedInvocationDiagnostic(invocation: readonly string[]): string {
  const owner = commandDescriptions.find(description =>
    description.rejection.owns(invocation)
  );
  const diagnostic = owner?.rejection.format(invocation);
  if (diagnostic === undefined) {
    throw new Error(
      `Stricli rejected an invocation that has no Radial compatibility diagnostic: ${JSON.stringify(invocation)}.`
    );
  }

  return diagnostic;
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

const runCli: RunCli = async input => {
  let frameworkStderr = '';
  const processFacade: StricliProcess = {
    env: {STRICLI_NO_COLOR: '1'},
    stderr: {
      write(text) {
        frameworkStderr += text;
      },
    },
    stdout: {
      write(text) {
        input.io.writeStdout(text);
      },
    },
  };
  const context: CliStricliContext = {
    input,
    invocation: input.args,
    process: processFacade,
    selectedDescription: {value: undefined},
  };

  await run(application, input.args, context);

  const exitCode = processFacade.exitCode;
  if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
    input.io.writeStderr(rejectedInvocationDiagnostic(input.args));
  } else if (frameworkStderr !== '') {
    input.io.writeStderr(frameworkStderr);
  }

  return translateExitCode(exitCode);
};

function translateExitCode(exitCode: number | string | null | undefined): number {
  if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
    return 2;
  }

  if (exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 130) {
    return exitCode;
  }

  throw new Error(`Unexpected Stricli framework exit code ${JSON.stringify(exitCode)}.`);
}

export default runCli;
