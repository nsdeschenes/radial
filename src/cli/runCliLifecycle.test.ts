import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/runCli.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test('keeps help and rejected invocations outside the operational lifecycle', async () => {
  const events: string[] = [];
  const input = recordingInput(events);

  await expect(runCli({...input, args: ['--help']})).resolves.toBe(0);
  await expect(runCli({...input, args: ['data', 'status', '--help']})).resolves.toBe(0);
  await expect(runCli({...input, args: ['data', '--help']})).resolves.toBe(2);
  await expect(runCli({...input, args: ['invalid']})).resolves.toBe(2);
  await expect(
    runCli({
      ...input,
      args: ['__radial_internal_plan_route__', 'CYYZ', 'CYOW'],
    })
  ).resolves.toBe(2);
  await expect(
    runCli({...input, args: ['data', 'reload', 'airport', 'bad']})
  ).resolves.toBe(2);

  expect(events).toEqual([]);
});

test('captures application cleanup defects before they leave the active span', async () => {
  const events: string[] = [];
  const cleanupDefect = new Error('application cleanup defect');
  const application = syntheticApplication(() => {
    events.push('application disposed');
    throw cleanupDefect;
  });

  const result = runCli({
    ...recordingInput(events),
    args: ['data', 'reload', 'airport', 'CYYZ'],
    env: {OPENAIP_API_KEY: 'secret', RADIAL_DATABASE_PATH: ':memory:'},
    async openApplication() {
      events.push('application opened');
      return {ok: true, value: application};
    },
  });

  await expect(result).rejects.toBe(cleanupDefect);
  expect(events).toEqual([
    'telemetry initialized',
    'span started reload-airport',
    'application opened',
    'application disposed',
    'defect captured',
    'span ended',
    'telemetry closed',
  ]);
});

test('runs every admitted command through one ordered lifecycle', async () => {
  const events: string[] = [];

  await expect(
    runCli({...recordingInput(events), args: ['data', 'status']})
  ).resolves.toBe(1);

  expect(events).toEqual([
    'telemetry initialized',
    'span started data-status',
    'operation recorded data-status-failed',
    'result recorded 1',
    'span ended',
    'telemetry closed',
  ]);
});

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
  'admits $metadata.id with stable normalized metadata',
  async ({args, metadata, status}) => {
    const admittedMetadata: CliTelemetryTypes['CommandMetadata'][] = [];

    await expect(
      runCli({
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
      })
    ).resolves.toBe(status);
    expect(admittedMetadata).toEqual([metadata]);
  }
);

test('captures an escaping defect once while the span is active and rethrows it unchanged', async () => {
  const events: string[] = [];
  const defect = new Error('application loader defect');

  const result = runCli({
    ...recordingInput(events),
    args: ['CYYZ', 'CYOW'],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    async openApplication() {
      events.push('application opened');
      throw defect;
    },
  });

  await expect(result).rejects.toBe(defect);
  expect(events).toEqual([
    'telemetry initialized',
    'span started plan-route',
    'application opened',
    'defect captured',
    'span ended',
    'telemetry closed',
  ]);
});

test('does not let telemetry close failure replace a command result or exception', async () => {
  const closeDefect = new Error('telemetry close defect');
  const commandDefect = new Error('command defect');
  const loadTelemetry = async (): Promise<CliTelemetryTypes['Session']> => ({
    async execute(_metadata, operation) {
      return operation();
    },
    recordOperation() {},
    async close() {
      throw closeDefect;
    },
  });

  await expect(
    runCli({
      args: ['data', 'status'],
      env: {},
      io: {writeStderr() {}, writeStdout() {}},
      loadTelemetry,
    })
  ).resolves.toBe(1);

  await expect(
    runCli({
      args: ['CYYZ', 'CYOW'],
      env: {RADIAL_DATABASE_PATH: ':memory:'},
      io: {writeStderr() {}, writeStdout() {}},
      async openApplication() {
        throw commandDefect;
      },
      loadTelemetry,
    })
  ).rejects.toBe(commandDefect);
});

function recordingInput(events: string[]) {
  return {
    args: [] as readonly string[],
    env: {},
    io: {writeStderr() {}, writeStdout() {}},
    async loadTelemetry() {
      events.push('telemetry initialized');
      return recordingTelemetry(events);
    },
  };
}

function recordingTelemetry(events: string[]): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      events.push(`span started ${metadata.id}`);
      try {
        const result = await operation();
        events.push(`result recorded ${result.status}`);
        return result;
      } catch (error) {
        events.push('defect captured');
        throw error;
      } finally {
        events.push('span ended');
      }
    },
    recordOperation(event) {
      events.push(`operation recorded ${event.kind}`);
    },
    async close() {
      events.push('telemetry closed');
    },
  };
}

function syntheticApplication(dispose: () => void): ApplicationTypes['Application'] {
  return {
    databasePath: ':memory:',
    dataManagement: {
      async reloadAirport() {
        return {
          ok: false,
          failure: {
            action: 'Retry.',
            activeDataPreserved: true,
            cause: 'Synthetic failure.',
            code: 'DATA_AIRPORT_NOT_FOUND',
            summary: 'Airport not found.',
          },
        };
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used.');
      },
      async status() {
        throw new Error('Data status is not used.');
      },
    },
    planning: {
      async open() {
        throw new Error('Route Search is not used.');
      },
    },
    async [Symbol.asyncDispose]() {
      dispose();
    },
  };
}
