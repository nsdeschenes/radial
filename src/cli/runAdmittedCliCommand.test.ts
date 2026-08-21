import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test.each([0, 1, 2, 130] as const)(
  'returns deep command status %s through the admitted lifecycle',
  async status => {
    await expect(
      runAdmittedCliCommand(
        {
          env: {},
          io: {writeStderr() {}, writeStdout() {}},
          loadTelemetry: inertTelemetry,
        },
        {
          applicationAccess: false,
          metadata: {id: 'data-status'},
          async execute(runtime) {
            expect(runtime).not.toHaveProperty('withApplication');
            return status;
          },
        }
      )
    ).resolves.toBe(status);
  }
);

test('shares one frozen environment snapshot with telemetry and runtime', async () => {
  const env: Record<string, string | undefined> = {
    RADIAL_DATABASE_PATH: 'before',
  };
  let telemetryEnvironment: Readonly<Record<string, string | undefined>> | undefined;

  await runAdmittedCliCommand(
    {
      env,
      io: {writeStderr() {}, writeStdout() {}},
      async loadTelemetry(environment) {
        telemetryEnvironment = environment;
        env['RADIAL_DATABASE_PATH'] = 'after';
        return inertTelemetry();
      },
    },
    {
      metadata: {id: 'data-status'},
      async execute(runtime) {
        expect(runtime.env).toBe(telemetryEnvironment);
        expect(runtime.env['RADIAL_DATABASE_PATH']).toBe('before');
        expect(Object.isFrozen(runtime.env)).toBe(true);
        return 0;
      },
    }
  );
});

test('disposes an opened application inside the admitted span before recording the result', async () => {
  const events: string[] = [];

  await expect(
    runAdmittedCliCommand(
      {
        env: {},
        io: {writeStderr() {}, writeStdout() {}},
        async loadTelemetry() {
          return recordingTelemetry(events);
        },
        async openApplication() {
          events.push('application opened');
          return {
            ok: true,
            value: syntheticApplication(() => events.push('application disposed')),
          };
        },
      },
      {
        metadata: {id: 'data-status'},
        async execute(runtime) {
          const result = await runtime.withApplication(
            {databasePath: ':synthetic:'},
            async () => {
              events.push('command executed');
            }
          );
          expect(result.ok).toBe(true);
          return 0;
        },
      }
    )
  ).resolves.toBe(0);

  expect(events).toEqual([
    'span started',
    'application opened',
    'command executed',
    'application disposed',
    'result recorded 0',
    'span ended',
    'telemetry closed',
  ]);
});

test('gives cleanup defects precedence and still attempts telemetry closure', async () => {
  const events: string[] = [];
  const cleanupDefect = new Error('cleanup defect');

  const result = runAdmittedCliCommand(
    {
      env: {},
      io: {writeStderr() {}, writeStdout() {}},
      async loadTelemetry() {
        return recordingTelemetry(events);
      },
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(() => {
            events.push('application disposed');
            throw cleanupDefect;
          }),
        };
      },
    },
    {
      metadata: {id: 'data-status'},
      async execute(runtime) {
        await runtime.withApplication({databasePath: ':synthetic:'}, async () => {});
        return 130;
      },
    }
  );

  await expect(result).rejects.toBe(cleanupDefect);
  expect(events).toEqual([
    'span started',
    'application disposed',
    'defect captured',
    'span ended',
    'telemetry closed',
  ]);
});

test('suppresses telemetry-close failure after a status or escaping defect', async () => {
  const commandDefect = new Error('command defect');
  const loadTelemetry = async (): Promise<CliTelemetryTypes['Session']> => ({
    async execute(_metadata, operation) {
      return operation();
    },
    recordOperation() {},
    async close() {
      throw new Error('telemetry close defect');
    },
  });
  const input = {
    env: {},
    io: {writeStderr() {}, writeStdout() {}},
    loadTelemetry,
  };

  await expect(
    runAdmittedCliCommand(input, {
      metadata: {id: 'data-status'},
      async execute() {
        return 1;
      },
    })
  ).resolves.toBe(1);
  await expect(
    runAdmittedCliCommand(input, {
      metadata: {id: 'data-status'},
      async execute() {
        throw commandDefect;
      },
    })
  ).rejects.toBe(commandDefect);
});

async function inertTelemetry(): Promise<CliTelemetryTypes['Session']> {
  return {
    async execute(_metadata, operation) {
      return operation();
    },
    recordOperation() {},
    async close() {},
  };
}

function recordingTelemetry(events: string[]): CliTelemetryTypes['Session'] {
  return {
    async execute(_metadata, operation) {
      events.push('span started');
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
    recordOperation() {},
    async close() {
      events.push('telemetry closed');
    },
  };
}

function syntheticApplication(dispose: () => void): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async reloadAirport() {
        throw new Error('Airport reload is not used.');
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
        throw new Error('Route planning is not used.');
      },
    },
    async [Symbol.asyncDispose]() {
      dispose();
    },
  };
}
