import {
  ExitCode,
  buildApplication,
  buildCommand,
  buildRouteMap,
  run,
} from '@stricli/core';
import type {CommandContext, StricliIntegration, StricliProcess} from '@stricli/core';

import diagnostics from '#radial/cli/formatDiagnostics.js';
import validation from '#radial/route-planner/internal/validation.js';

type CommandIdentity = 'data-status' | 'plan-route' | 'reload-airport' | 'reload-navaids';
type PreservedExitCode = 0 | 1 | 2 | 130;

type PrototypeEvidence = {
  commandLoads: CommandIdentity[];
  commandRuns: CommandIdentity[];
  contextLoads: CommandIdentity[];
};

type PrototypeIo = {
  writeStderr(text: string): void;
  writeStdout(text: string): void;
};

type PrototypeInput = {
  args: readonly string[];
  evidence: PrototypeEvidence;
  io: PrototypeIo;
  requestedExitCode?: PreservedExitCode;
  signal?: AbortSignal;
};

type StricliCompatibilityPrototypeContext = CommandContext & {
  commandIdentity: CommandIdentity;
  evidence: PrototypeEvidence;
  invocation: readonly string[];
  process: StricliProcess;
  requestedExitCode: PreservedExitCode;
  signal: AbortSignal;
};

const INTERNAL_PLAN_ROUTE = '__radial_internal_plan_route__';
const ROOT_HELP =
  'Usage:\n' +
  '  radial <departure-icao> <arrival-icao> [--warnings]\n' +
  '  radial data status\n' +
  '  radial data reload navaids\n' +
  '  radial data reload airport <ICAO>\n';
const DATA_STATUS_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The data status command accepts no arguments or operational flags.\n' +
  'Action: Run "radial data status".\n';
const NAVAID_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
  'Action: Run "radial data reload navaids".\n';
const AIRPORT_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
  'Action: Run "radial data reload airport <ICAO>".\n';

async function runStricliCompatibilityPrototype(input: PrototypeInput): Promise<number> {
  const interrupt = createInterruptSignal(input.signal);
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
  const application = buildPrototypeApplication(input.args, input.evidence);

  try {
    await run(application, input.args, {
      process: processFacade,
      forCommand: () => {
        const commandIdentity = commandIdentityForInvocation(input.args);
        input.evidence.contextLoads.push(commandIdentity);
        return {
          commandIdentity,
          evidence: input.evidence,
          invocation: input.args,
          process: processFacade,
          requestedExitCode: input.requestedExitCode ?? 0,
          signal: interrupt.signal,
        };
      },
    });

    const exitCode = processFacade.exitCode;
    if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
      input.io.writeStderr(formatMalformedInvocation(input.args));
    } else {
      input.io.writeStderr(frameworkStderr);
    }

    return translateExitCode(exitCode);
  } finally {
    interrupt.dispose();
  }
}

function buildPrototypeApplication(
  invocation: readonly string[],
  evidence: PrototypeEvidence
) {
  const loadCommand = (commandIdentity: CommandIdentity) => async () => {
    evidence.commandLoads.push(commandIdentity);
    return import('#radial/cli/stricliCompatibilityPrototypeCommand.js');
  };

  const noFlags = {};
  const noPositionals = {kind: 'tuple' as const, parameters: [] as const};
  const dataStatus = buildCommand<
    Readonly<Record<never, never>>,
    [],
    StricliCompatibilityPrototypeContext
  >({
    docs: {brief: 'Read local data status'},
    loader: loadCommand('data-status'),
    parameters: {flags: noFlags, positional: noPositionals},
  });
  const reloadNavaids = buildCommand<
    Readonly<Record<never, never>>,
    [],
    StricliCompatibilityPrototypeContext
  >({
    docs: {brief: 'Reload the Navaid Snapshot'},
    loader: loadCommand('reload-navaids'),
    parameters: {flags: noFlags, positional: noPositionals},
  });
  const reloadAirport = buildCommand<
    Readonly<Record<never, never>>,
    [icao: string],
    StricliCompatibilityPrototypeContext
  >({
    docs: {brief: 'Reload one Cached Airport'},
    loader: loadCommand('reload-airport'),
    parameters: {
      flags: noFlags,
      positional: {
        kind: 'tuple',
        parameters: [
          {brief: 'Airport ICAO', parse: parseAirportIcao, placeholder: 'ICAO'},
        ],
      },
    },
  });
  const planRoute = buildCommand<
    Readonly<{warnings?: boolean}>,
    [departureIcao: string, arrivalIcao: string],
    StricliCompatibilityPrototypeContext
  >({
    docs: {brief: 'Plan a Route'},
    loader: loadCommand('plan-route'),
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
  });
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
    },
    {
      help: helpIntegration(invocation),
      missingSubcommand: missingSubcommandIntegration(invocation),
    }
  );
}

function helpIntegration(
  invocation: readonly string[]
): StricliIntegration<StricliCompatibilityPrototypeContext> {
  return {
    flag: {
      aliases: ['h'],
      brief: 'Print help information and exit',
      global: true,
      run(_application, {result}) {
        if (result.prefix.includes(INTERNAL_PLAN_ROUTE)) {
          this.process.stderr.write(formatMalformedInvocation(invocation));
          this.process.exitCode = 2;
          return;
        }

        this.process.stdout.write(helpForPrefix(result.prefix));
      },
    },
  };
}

function missingSubcommandIntegration(
  invocation: readonly string[]
): StricliIntegration<StricliCompatibilityPrototypeContext> {
  return {
    flag: {
      aliases: [],
      brief: 'Render Radial compatibility diagnostics for an incomplete route',
      defaultForRouteMap: true,
      global: true,
      hidden: true,
      run() {
        this.process.stderr.write(formatMalformedInvocation(invocation));
        this.process.exitCode = 2;
      },
    },
  };
}

function helpForPrefix(prefix: readonly string[]): string {
  switch (prefix.slice(1).join(' ')) {
    case 'data status':
      return 'Usage: radial data status\n';
    case 'data reload navaids':
      return 'Usage: radial data reload navaids\n';
    case 'data reload airport':
      return 'Usage: radial data reload airport <ICAO>\n';
    default:
      return ROOT_HELP;
  }
}

function formatMalformedInvocation(invocation: readonly string[]): string {
  if (invocation[0] === 'data') {
    if (invocation[1] === 'status') {
      return DATA_STATUS_USAGE;
    }

    if (invocation[1] === 'reload' && invocation[2] === 'airport') {
      if (
        invocation.length === 4 &&
        invocation[3]?.startsWith('--') === false &&
        !validation.validateAirportIcao(invocation[3]).ok
      ) {
        return formatInvalidAirportIcao(invocation[3]);
      }

      return AIRPORT_RELOAD_USAGE;
    }

    return NAVAID_RELOAD_USAGE;
  }

  const routeArguments =
    invocation.at(-1) === '--warnings' ? invocation.slice(0, -1) : invocation;
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
}

function formatInvalidAirportIcao(value: string): string {
  return (
    'error [DATA_INVALID_ICAO]: The Airport ICAO is invalid.\n' +
    `Cause: The requested Airport ICAO ${JSON.stringify(value)} is not four ASCII letters.\n` +
    'Action: Provide exactly one four-letter ICAO and retry the Airport reload.\n' +
    'Active data remains unchanged.\n'
  );
}

function parseRouteIcao(
  this: StricliCompatibilityPrototypeContext,
  input: string
): string {
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

function parseAirportIcao(
  this: StricliCompatibilityPrototypeContext,
  input: string
): string {
  const validated = validation.validateAirportIcao(input);
  if (!validated.ok) {
    throw new Error('Radial rejected the Airport ICAO.');
  }

  return validated.value;
}

function commandIdentityForInvocation(invocation: readonly string[]): CommandIdentity {
  if (invocation[0] !== 'data') {
    return 'plan-route';
  }

  if (invocation[1] === 'status') {
    return 'data-status';
  }

  return invocation[2] === 'airport' ? 'reload-airport' : 'reload-navaids';
}

function translateExitCode(exitCode: number | string | null | undefined): number {
  if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
    return 2;
  }

  if (exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 130) {
    return exitCode;
  }

  throw new Error(`Unexpected Stricli framework exit code ${JSON.stringify(exitCode)}.`);
}

function createInterruptSignal(parentSignal: AbortSignal | undefined): {
  dispose(): void;
  signal: AbortSignal;
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
    dispose() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
    signal: controller.signal,
  };
}

function createPrototypeEvidence(): PrototypeEvidence {
  return {commandLoads: [], commandRuns: [], contextLoads: []};
}

export default {
  createEvidence: createPrototypeEvidence,
  internalPlanRoute: INTERNAL_PLAN_ROUTE,
  run: runStricliCompatibilityPrototype,
};
