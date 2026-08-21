import {buildApplication, buildCommand, buildRouteMap, text_en} from '@stricli/core';
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
  RouteMap,
  StricliIntegration,
  StricliProcess,
} from '@stricli/core';

import type CliInputTypes from '#radial/cli/CliInput.js';
import runReloadNavaids from '#radial/cli/commands/runReloadNavaids.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import validation from '#radial/route-planner/internal/validation.js';

type CliStricliContext = CommandContext &
  Readonly<{
    input: CliInputTypes['Input'];
    process: StricliProcess;
    routePlanDepartureIcao: {value: string | undefined};
    selectedDescription: {value: object | undefined};
  }>;
type CliApplicationContext = ApplicationContext;

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
  loadCompatibilityExecution(
    flags: Flags,
    ...args: Args
  ): Promise<CliInputTypes['CommandExecution']>;
  runAdmitted?: (
    input: CliInputTypes['Admitted'],
    flags: Flags,
    ...args: Args
  ) => Promise<number>;
}>;

type RoutePlanFlags = Readonly<{warnings?: boolean}>;
type RoutePlanArgs = [departureIcao: string, arrivalIcao: string];
type AirportReloadArgs = [icao: string];
type NoFlags = Readonly<Record<never, never>>;
type NoArgs = [];

const INTERNAL_PLAN_ROUTE = '\0radial-plan-route';
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
  route: [INTERNAL_PLAN_ROUTE],
  docs: {brief: 'Plan a Route'},
  parameters: {
    flags: {
      warnings: {
        brief: 'Show Route Plan warning details',
        inferEmpty: true,
        kind: 'parsed',
        optional: true,
        parse: parseTerminalWarnings,
      },
    },
    positional: {
      kind: 'tuple',
      parameters: [
        {
          brief: 'Departure Airport ICAO',
          parse: parseRoutePlanDepartureIcao,
          placeholder: 'departure-icao',
        },
        {
          brief: 'Arrival Airport ICAO',
          parse: parseRoutePlanArrivalIcao,
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
  async loadCompatibilityExecution(flags, departureIcao, arrivalIcao) {
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
  async loadCompatibilityExecution() {
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
  runAdmitted(input) {
    return runReloadNavaids(input, {});
  },
  async loadCompatibilityExecution() {
    throw new Error('The Navaid reload command uses its deep admitted entry.');
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
  async loadCompatibilityExecution(_flags, icao) {
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

interface BuiltCliApplication {
  readonly application: Application<CliStricliContext>;
  contextFor(input: CliInputTypes['Input'], process: StricliProcess): CliStricliContext;
  rejectedInvocationDiagnostic(invocation: readonly string[]): string;
  readonly commandTypes?: Readonly<{
    id: CatalogCommandId;
    metadata: CatalogCommandMetadata;
  }>;
}

const ROOT_HELP =
  'Usage:\n' +
  commandDescriptions.map(description => description.help.rootUsageLine).join('');
const commandSelections = new WeakMap<object, CatalogCommandDescription>();
const compatibilityInvocations = new WeakMap<StricliProcess, readonly string[]>();

function parseRoutePlanDepartureIcao(this: CliStricliContext, input: string): string {
  const validated = validation.validateAirportIcao(input);
  if (!validated.ok) {
    throw new Error('Radial rejected the departure Airport ICAO.');
  }

  this.routePlanDepartureIcao.value = validated.value;
  return validated.value;
}

function parseRoutePlanArrivalIcao(this: CliStricliContext, input: string): string {
  const departureIcao = this.routePlanDepartureIcao.value;
  if (departureIcao === undefined) {
    throw new Error('Radial did not parse the departure Airport ICAO.');
  }

  const validated = validation.validateRoutePlanningRequest({
    arrivalIcao: input,
    departureIcao,
  });
  if (!validated.ok) {
    throw new Error('Radial rejected the arrival Airport ICAO.');
  }

  return validated.value.arrivalIcao;
}

function parseTerminalWarnings(input: string): boolean {
  if (input !== '') {
    throw new Error('Radial accepts --warnings only as the terminal argument.');
  }

  return true;
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

function buildCliApplication(): BuiltCliApplication {
  const compiledCommands = new Map<CatalogCommandDescription, Command<CliStricliContext>>(
    commandDescriptions.map(description => [
      description,
      buildCatalogCommand(description),
    ])
  );
  for (const [description, command] of compiledCommands) {
    commandSelections.set(command, description);
  }

  const commandFor = (description: CatalogCommandDescription) => {
    const command = compiledCommands.get(description);
    if (command === undefined) {
      throw new Error(
        `Radial command ${JSON.stringify(description.id)} was not compiled.`
      );
    }

    return command;
  };

  const root = buildCatalogRouteMap(commandDescriptions, commandFor);

  const application = buildApplication(
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

  return {
    application,
    contextFor(input, process) {
      compatibilityInvocations.set(process, input.args);
      return {
        input,
        process,
        routePlanDepartureIcao: {value: undefined},
        selectedDescription: {value: undefined},
      };
    },
    rejectedInvocationDiagnostic,
  };
}

function buildCatalogCommand(
  description: CatalogCommandDescription
): Command<CliStricliContext> {
  type ErasedCatalogDescription = CommandDescription<
    BaseFlags,
    BaseArgs,
    CatalogCommandId,
    CatalogCommandMetadata
  >;
  return buildDescribedCommand(description as unknown as ErasedCatalogDescription);
}

function buildCatalogRouteMap(
  entries: readonly CatalogCommandDescription[],
  commandFor: (description: CatalogCommandDescription) => Command<CliStricliContext>,
  depth = 0
): RouteMap<CliStricliContext> {
  const routes: Record<string, Command<CliStricliContext> | RouteMap<CliStricliContext>> =
    {};
  const routeTokens = new Set(entries.map(entry => entry.route[depth]));

  for (const token of routeTokens) {
    if (token === undefined) {
      throw new Error('Radial cannot build a route for an empty command path.');
    }

    const matchingEntries = entries.filter(entry => entry.route[depth] === token);
    const leaf = matchingEntries.find(entry => entry.route.length === depth + 1);
    if (leaf !== undefined) {
      if (matchingEntries.length !== 1) {
        throw new Error(`Radial route ${JSON.stringify(leaf.route)} is not unique.`);
      }

      routes[token] = commandFor(leaf);
      continue;
    }

    routes[token] = buildCatalogRouteMap(matchingEntries, commandFor, depth + 1);
  }

  return buildRouteMap({
    ...(depth === 0 ? {defaultCommand: INTERNAL_PLAN_ROUTE} : {}),
    docs: {
      brief:
        depth === 0
          ? 'Radial flight-simulation route planner'
          : `Radial ${entries[0]?.route[depth - 1] ?? 'nested'} commands`,
      ...(depth === 0 ? {hideRoute: {[INTERNAL_PLAN_ROUTE]: true}} : {}),
    },
    routes,
  });
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

      if (description.runAdmitted !== undefined) {
        this.process.exitCode = await description.runAdmitted(this.input, flags, ...args);
        return;
      }

      const metadata = description.metadata(flags, ...args);
      this.process.exitCode = await runAdmittedCliCommand(this.input, {
        metadata,
        loadDefault: () => description.loadCompatibilityExecution(flags, ...args),
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
        const invocation = compatibilityInvocationFor(context.process);
        const help = helpForInvocation(invocation);
        if (help === undefined) {
          context.process.stderr.write(rejectedInvocationDiagnostic(invocation));
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
          rejectedInvocationDiagnostic(compatibilityInvocationFor(context.process))
        );
        context.process.exitCode = 2;
      },
    },
  };
}

function compatibilityInvocationFor(process: StricliProcess): readonly string[] {
  const invocation = compatibilityInvocations.get(process);
  if (invocation === undefined) {
    throw new Error('Radial has no compatibility invocation for this Stricli process.');
  }

  return invocation;
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

export default buildCliApplication;
