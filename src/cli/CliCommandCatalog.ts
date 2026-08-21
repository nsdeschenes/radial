import type {BaseArgs, BaseFlags, CommandBuilderArguments} from '@stricli/core';

import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliStricliTypes from '#radial/cli/CliStricliContext.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import validation from '#radial/route-planner/internal/validation.js';

type CommandDescription<Flags extends BaseFlags, Args extends BaseArgs> = Readonly<{
  id: CliTelemetryTypes['CommandMetadata']['id'];
  route: readonly string[];
  docs: CommandBuilderArguments<Flags, Args, CliStricliTypes['Context']>['docs'];
  parameters: CommandBuilderArguments<
    Flags,
    Args,
    CliStricliTypes['Context']
  >['parameters'];
  help: Readonly<{leafUsage?: string; rootUsageLine: string}>;
  rejection: Readonly<{
    owns(invocation: readonly string[]): boolean;
    format(invocation: readonly string[]): string;
  }>;
  metadata(flags: Flags, ...args: Args): CliTelemetryTypes['CommandMetadata'];
  loadExecution(flags: Flags, ...args: Args): Promise<CliInputTypes['CommandExecution']>;
}>;

type RoutePlanFlags = Readonly<{warnings?: boolean}>;
type RoutePlanArgs = [departureIcao: string, arrivalIcao: string];
type AirportReloadArgs = [icao: string];
type NoFlags = Readonly<Record<never, never>>;
type NoArgs = [];

const airportReloadUsage =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
  'Action: Run "radial data reload airport <ICAO>".\n';

const routePlan = {
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
          parse(this: CliStricliTypes['Context']) {
            return parseRoutePlanInvocation(this.invocation).departureIcao;
          },
          placeholder: 'departure-icao',
        },
        {
          brief: 'Arrival Airport ICAO',
          parse(this: CliStricliTypes['Context']) {
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
    owns(invocation: readonly string[]) {
      return invocation[0] !== 'data';
    },
    format(invocation: readonly string[]) {
      const routeArguments = routeArgumentsFromInvocation(invocation);
      if (routeArguments.length !== 2) {
        return diagnostics.formatArgumentCountDiagnostic(routeArguments.length);
      }

      const validated = validation.validateRoutePlanningRequest({
        arrivalIcao: routeArguments[1] ?? '',
        departureIcao: routeArguments[0] ?? '',
      });
      return validated.ok
        ? diagnostics.formatArgumentCountDiagnostic(routeArguments.length)
        : diagnostics.formatInvalidRequestDiagnostic(validated.failure);
    },
  },
  metadata(_flags: RoutePlanFlags, departureIcao: string, arrivalIcao: string) {
    return {
      id: 'plan-route',
      attributes: {
        'radial.route.arrival_icao': arrivalIcao,
        'radial.route.departure_icao': departureIcao,
      },
    };
  },
  async loadExecution(flags: RoutePlanFlags, departureIcao: string, arrivalIcao: string) {
    const commandModule = await import('#radial/cli/commands/runPlanRoute.js');
    const request = {arrivalIcao, departureIcao};
    return (runtime, telemetry) =>
      commandModule.default(
        {request, warningDetailsRequested: flags.warnings === true},
        runtime,
        telemetry
      );
  },
} satisfies CommandDescription<RoutePlanFlags, RoutePlanArgs>;

const dataStatus = {
  id: 'data-status',
  route: ['data', 'status'] as const,
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
    owns(invocation: readonly string[]) {
      return invocation[0] === 'data' && invocation[1] === 'status';
    },
    format(_invocation: readonly string[]) {
      return (
        'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The data status command accepts no arguments or operational flags.\n' +
        'Action: Run "radial data status".\n'
      );
    },
  },
  metadata() {
    return {id: 'data-status'};
  },
  async loadExecution() {
    const commandModule = await import('#radial/cli/commands/runDataStatus.js');
    return (runtime, telemetry) => commandModule.default({}, runtime, telemetry);
  },
} satisfies CommandDescription<NoFlags, NoArgs>;

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

const reloadAirport = {
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
    owns(invocation: readonly string[]) {
      return (
        invocation[0] === 'data' &&
        invocation[1] === 'reload' &&
        invocation[2] === 'airport'
      );
    },
    format(invocation: readonly string[]) {
      const value = invocation[3];
      if (
        invocation.length !== 4 ||
        value === undefined ||
        value.startsWith('--') ||
        validation.validateAirportIcao(value).ok
      ) {
        return airportReloadUsage;
      }

      return airportReloadOutput.formatFailure({
        code: 'DATA_INVALID_ICAO',
        summary: 'The Airport ICAO is invalid.',
        cause: `The requested Airport ICAO ${JSON.stringify(value)} is not four ASCII letters.`,
        action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
        activeDataPreserved: true,
      });
    },
  },
  metadata(_flags: NoFlags, icao: string) {
    return {
      id: 'reload-airport',
      attributes: {'radial.airport.icao': icao},
    };
  },
  async loadExecution(_flags: NoFlags, icao: string) {
    const commandModule = await import('#radial/cli/commands/runAirportReload.js');
    return runtime => commandModule.default({icao}, runtime);
  },
} satisfies CommandDescription<NoFlags, AirportReloadArgs>;

function parseAirportReloadInvocation(input: string): string {
  const validated = validation.validateAirportIcao(input);
  if (!validated.ok) {
    throw new Error('Radial rejected the Airport ICAO.');
  }

  return validated.value;
}

const reloadNavaids = {
  id: 'reload-navaids',
  route: ['data', 'reload', 'navaids'] as const,
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
    owns(invocation: readonly string[]) {
      return (
        invocation[0] === 'data' &&
        invocation[1] !== 'status' &&
        !(invocation[1] === 'reload' && invocation[2] === 'airport')
      );
    },
    format(_invocation: readonly string[]) {
      return (
        'error [DATA_USAGE]: Invalid data command.\n' +
        'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
        'Action: Run "radial data reload navaids".\n'
      );
    },
  },
  metadata() {
    return {id: 'reload-navaids'};
  },
  async loadExecution() {
    const commandModule = await import('#radial/cli/commands/runReloadNavaids.js');
    return runtime => commandModule.default({}, runtime);
  },
} satisfies CommandDescription<NoFlags, NoArgs>;

export default {dataStatus, reloadAirport, reloadNavaids, routePlan};
