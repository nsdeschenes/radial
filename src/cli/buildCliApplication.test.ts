import {run} from '@stricli/core';
import type {StricliProcess} from '@stricli/core';
import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import buildCliApplication from '#radial/cli/buildCliApplication.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test.each([
  {args: ['data', 'status'], metadata: {id: 'data-status'}, status: 1},
  {
    args: ['data', 'reload', 'navaids'],
    metadata: {id: 'reload-navaids'},
    status: 1,
  },
  {
    args: ['data', 'reload', 'airport', ' cyyz '],
    status: 1,
    metadata: {
      id: 'reload-airport',
      attributes: {'radial.airport.icao': 'CYYZ'},
    },
  },
] as const)(
  'normalizes and dispatches $metadata.id through the generated catalog',
  async ({args, metadata, status}) => {
    const admittedMetadata: CliTelemetryTypes['CommandMetadata'][] = [];
    const input: CliInputTypes['Input'] = {
      args,
      env: {},
      io: {writeStderr() {}, writeStdout() {}},
      async loadTelemetry() {
        return {
          async execute(actualMetadata, operation) {
            admittedMetadata.push(actualMetadata);
            return operation();
          },
          recordOperation() {},
          async close() {},
        };
      },
    };

    const process = await runBuiltApplication(input);

    expect(process.exitCode).toBe(status);
    expect(admittedMetadata).toEqual([metadata]);
  }
);

test('dispatches normalized Route Plan values through the deep command entry', async () => {
  const admittedMetadata: CliTelemetryTypes['CommandMetadata'][] = [];
  let plannedRequest: ApplicationTypes['RoutePlanningRequest'] | undefined;
  const input: CliInputTypes['Input'] = {
    args: [' cyyz ', 'cyow'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: {writeStderr() {}, writeStdout() {}},
    async loadTelemetry() {
      return {
        async execute(metadata, operation) {
          admittedMetadata.push(metadata);
          return operation();
        },
        recordOperation() {},
        async close() {},
      };
    },
    async openApplication() {
      return {ok: true, value: routeApplication(request => (plannedRequest = request))};
    },
  };

  const process = await runBuiltApplication(input);

  expect(process.exitCode).toBe(0);
  expect(admittedMetadata).toEqual([
    {
      id: 'plan-route',
      attributes: {
        'radial.route.arrival_icao': 'CYOW',
        'radial.route.departure_icao': 'CYYZ',
      },
    },
  ]);
  expect(plannedRequest).toMatchObject({
    arrivalIcao: 'CYOW',
    departureIcao: 'CYYZ',
  });
});

test('renders help without entering the temporary command dispatcher', async () => {
  let operationalLifecycleEntries = 0;
  const stdout: string[] = [];
  const input: CliInputTypes['Input'] = {
    args: ['data', 'status', '--help'],
    env: {},
    io: {writeStderr() {}, writeStdout() {}},
    async loadTelemetry() {
      operationalLifecycleEntries += 1;
      throw new Error('Help must not initialize telemetry.');
    },
    async openApplication() {
      operationalLifecycleEntries += 1;
      throw new Error('Help must not open an application.');
    },
  };

  const process = await runBuiltApplication(input, text => stdout.push(text));

  expect(process.exitCode).toBe(0);
  expect(stdout.join('')).toBe('Usage: radial data status\n');
  expect(operationalLifecycleEntries).toBe(0);
});

test('keeps compatibility classification rejection-only', () => {
  const cliApplication = buildCliApplication();

  expect(cliApplication.rejectedInvocationDiagnostic(['data', 'status', '--force'])).toBe(
    'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The data status command accepts no arguments or operational flags.\n' +
      'Action: Run "radial data status".\n'
  );
  expect(() => cliApplication.rejectedInvocationDiagnostic(['data', 'status'])).toThrow(
    'Stricli rejected an invocation that has no Radial compatibility diagnostic'
  );
});

async function runBuiltApplication(
  input: CliInputTypes['Input'],
  writeStdout: (text: string) => void = () => {}
): Promise<StricliProcess> {
  const cliApplication = buildCliApplication();
  const process: StricliProcess = {
    env: {STRICLI_NO_COLOR: '1'},
    stderr: {write() {}},
    stdout: {write: writeStdout},
  };
  const context = cliApplication.contextFor(input, process);

  await run(cliApplication.application, input.args, context);
  return process;
}

function routeApplication(
  onPlan: (request: ApplicationTypes['RoutePlanningRequest']) => void
): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async status() {
        throw new Error('Data status is not used.');
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used.');
      },
      async reloadAirport() {
        throw new Error('Airport reload is not used.');
      },
    },
    planning: {
      async open() {
        return {
          ok: true,
          value: {
            async planRoute(request) {
              onPlan(request);
              return {
                ok: true,
                value: {
                  plan: {
                    magneticReference: null,
                    routeLegs: [],
                    routePoints: [],
                    searchMode: 'vor-family',
                    totalDistanceNm: 0,
                  },
                  warnings: [],
                },
              };
            },
            async [Symbol.asyncDispose]() {},
          },
        };
      },
    },
    async [Symbol.asyncDispose]() {},
  };
}
