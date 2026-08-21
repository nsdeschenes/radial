import {buildApplication, buildCommand, buildRouteMap, text_en} from '@stricli/core';
import type {
  Application,
  ApplicationContext,
  ApplicationText,
  BaseArgs,
  BaseFlags,
  Command,
  CommandBuilderArguments,
  CommandFunction,
  StricliIntegration,
} from '@stricli/core';

import commandCatalog from '#radial/cli/CliCommandCatalog.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliStricliTypes from '#radial/cli/CliStricliContext.js';
import formatCliCompatibilityDiagnostic from '#radial/cli/formatCliCompatibilityDiagnostic.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type CommandSelection = CliStricliTypes['CommandSelection'];
type CliStricliContext = CliStricliTypes['Context'];

type CliApplicationContext = ApplicationContext &
  Readonly<{
    invocation: readonly string[];
  }>;

const INTERNAL_PLAN_ROUTE = '__radial_internal_plan_route__';
const ROOT_HELP =
  'Usage:\n' +
  commandCatalog.routePlan.help.rootUsageLine +
  commandCatalog.dataStatus.help.rootUsageLine +
  commandCatalog.reloadNavaids.help.rootUsageLine +
  commandCatalog.reloadAirport.help.rootUsageLine;
const commandSelections = new WeakMap<object, CommandSelection>();

function buildCliApplication(): Application<CliStricliContext> {
  const dataStatus = buildDescribedCommand(commandCatalog.dataStatus);
  const reloadNavaids = buildDescribedCommand(commandCatalog.reloadNavaids);
  const reloadAirport = buildDescribedCommand(commandCatalog.reloadAirport);
  const planRoute = buildDescribedCommand(commandCatalog.routePlan);
  const reload = buildRouteMap({
    docs: {brief: 'Reload local data'},
    routes: {
      airport: reloadAirport,
      [commandCatalog.reloadNavaids.route[2]]: reloadNavaids,
    },
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

function buildDescribedCommand<Flags extends BaseFlags, Args extends BaseArgs>(
  description: Readonly<{
    id: CliRuntimeTypes['CommandId'];
    docs: CommandBuilderArguments<Flags, Args, CliStricliContext>['docs'];
    parameters: CommandBuilderArguments<Flags, Args, CliStricliContext>['parameters'];
    metadata(flags: Flags, ...args: Args): CliTelemetryTypes['CommandMetadata'];
    loadExecution(
      flags: Flags,
      ...args: Args
    ): Promise<CliInputTypes['CommandExecution']>;
  }>
): Command<CliStricliContext> {
  return registerCommand(
    {id: description.id},
    buildCommand<Flags, Args, CliStricliContext>({
      docs: description.docs,
      loader: admittedLoader(description.loadExecution, description.metadata),
      parameters: description.parameters,
    })
  );
}

function admittedLoader<Flags extends BaseFlags, Args extends BaseArgs>(
  loadExecution: (
    flags: Flags,
    ...args: Args
  ) => Promise<CliInputTypes['CommandExecution']>,
  describeMetadata?: (flags: Flags, ...args: Args) => CliTelemetryTypes['CommandMetadata']
): () => Promise<CommandFunction<Flags, Args, CliStricliContext>> {
  return async () =>
    async function (flags, ...args) {
      const selection = this.selectedCommand.value;
      if (selection === undefined) {
        throw new Error('Stricli did not select a registered Radial command.');
      }

      const metadata =
        describeMetadata?.(flags, ...args) ?? legacyCommandMetadata(selection.id, args);
      this.process.exitCode = await runAdmittedCliCommand(this.input, {
        metadata,
        loadDefault: () => loadExecution(flags, ...args),
      });
    };
}

function legacyCommandMetadata(
  commandId: CliRuntimeTypes['CommandId'],
  args: readonly unknown[]
): CliTelemetryTypes['CommandMetadata'] {
  if (commandId === 'reload-airport') {
    return {
      id: commandId,
      attributes: {'radial.airport.icao': String(args[0])},
    };
  }

  return {id: commandId};
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
    return commandCatalog.dataStatus.help.leafUsage;
  }

  if (key === `${commandCatalog.reloadNavaids.route.join(' ')} --help`) {
    return commandCatalog.reloadNavaids.help.leafUsage;
  }

  if (key === 'data reload airport --help') {
    return commandCatalog.reloadAirport.help.leafUsage;
  }

  return undefined;
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
