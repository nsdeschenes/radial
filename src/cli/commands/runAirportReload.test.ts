import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import runAirportReload from '#radial/cli/commands/runAirportReload.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test('rejects missing configuration before opening the application with database precedence', async () => {
  const stderr: string[] = [];
  let applicationOpenCount = 0;
  const controller = new AbortController();
  controller.abort();

  await expect(
    runAirportReload(
      admittedInput({
        env: {},
        signal: controller.signal,
        writeStderr: text => stderr.push(text),
        async openApplication() {
          applicationOpenCount += 1;
          throw new Error('Invalid configuration must not open the application.');
        },
      }),
      {icao: 'CYYZ'}
    )
  ).resolves.toBe(1);
  expect(applicationOpenCount).toBe(0);
  expect(stderr).toEqual([
    'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('rejects missing OpenAIP credentials before opening the application', async () => {
  const stderr: string[] = [];
  let applicationOpenCount = 0;

  await expect(
    runAirportReload(
      admittedInput({
        env: {RADIAL_DATABASE_PATH: ':synthetic:'},
        writeStderr: text => stderr.push(text),
        async openApplication() {
          applicationOpenCount += 1;
          throw new Error('Missing credentials must not open the application.');
        },
      }),
      {icao: 'CYYZ'}
    )
  ).resolves.toBe(1);
  expect(applicationOpenCount).toBe(0);
  expect(stderr).toEqual([
    'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for an explicit Airport reload.\n' +
      'Action: Set OPENAIP_API_KEY and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('uses one normalized ICAO for metadata, request, progress, and reported success', async () => {
  const writes: Array<Readonly<{channel: 'stderr' | 'stdout'; text: string}>> = [];
  const metadata: CliTelemetryTypes['CommandMetadata'][] = [];

  const status = await runAirportReload(
    admittedInput({
      env: configuredEnvironment(),
      async loadTelemetry() {
        return recordingTelemetry(metadata);
      },
      writeStderr: text => writes.push({channel: 'stderr', text}),
      writeStdout: text => writes.push({channel: 'stdout', text}),
      async openApplication(config) {
        expect(config).toEqual({databasePath: ':synthetic:'});
        return {
          ok: true,
          value: syntheticApplication(async request => {
            expect(request.icao).toBe('CYYZ');
            expect(request.openAipApiKey).toBe('secret-api-key');
            request.onProgress?.({
              stage: 'openaip',
              message: `Looking up Airport ${request.icao}.`,
            });
            return {ok: true, value: airportReloadSuccess('CYYZ')};
          }),
        };
      },
    }),
    {icao: 'CYYZ'}
  );

  expect(status).toBe(0);
  expect(metadata).toEqual([
    {
      id: 'reload-airport',
      attributes: {'radial.airport.icao': 'CYYZ'},
    },
  ]);
  expect(writes).toEqual([
    {channel: 'stderr', text: 'progress: Looking up Airport CYYZ.\n'},
    {
      channel: 'stdout',
      text:
        'Cached Airport replaced\n' +
        '  ICAO: CYYZ\n' +
        '  OpenAIP ID: airport-cyyz\n' +
        '  Retrieved: 2026-07-10T00:00:00.000Z\n',
    },
  ]);
});

test('maps invalid operational results to status 2 after streaming progress', async () => {
  const writes: string[] = [];

  const status = await runAirportReload(
    admittedInput({
      env: configuredEnvironment(),
      writeStderr: text => writes.push(text),
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(async request => {
            request.onProgress?.({stage: 'openaip', message: 'Looking up Airport.'});
            return {
              ok: false,
              failure: {
                code: 'DATA_INVALID_ICAO',
                summary: 'The Airport ICAO is invalid.',
                cause: 'The application rejected the admitted ICAO.',
                action: 'Provide a valid ICAO and retry the Airport reload.',
                activeDataPreserved: true,
              },
            };
          }),
        };
      },
    }),
    {icao: 'CYYZ'}
  );

  expect(status).toBe(2);
  expect(writes).toEqual([
    'progress: Looking up Airport.\n',
    'error [DATA_INVALID_ICAO]: The Airport ICAO is invalid.\n' +
      'Cause: The application rejected the admitted ICAO.\n' +
      'Action: Provide a valid ICAO and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('returns silent status 130 for cancellation before publication', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const writes: string[] = [];
  const result = runAirportReload(
    admittedInput({
      env: configuredEnvironment(),
      signal: controller.signal,
      writeStderr: text => writes.push(text),
      writeStdout: text => writes.push(text),
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(
            request =>
              new Promise((_resolve, reject) => {
                started.resolve();
                request.signal?.addEventListener(
                  'abort',
                  () => reject(request.signal?.reason),
                  {once: true}
                );
              })
          ),
        };
      },
    }),
    {icao: 'CYYZ'}
  );

  await started.promise;
  controller.abort();

  await expect(result).resolves.toBe(130);
  expect(writes).toEqual([]);
});

test('reports committed Cached Airport success despite late cancellation', async () => {
  const controller = new AbortController();
  const reload = Promise.withResolvers<ApplicationTypes['AirportReloadResult']>();
  const started = Promise.withResolvers<void>();
  const stdout: string[] = [];
  const result = runAirportReload(
    admittedInput({
      env: configuredEnvironment(),
      signal: controller.signal,
      writeStdout: text => stdout.push(text),
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(async () => {
            started.resolve();
            return reload.promise;
          }),
        };
      },
    }),
    {icao: 'CYYZ'}
  );

  await started.promise;
  controller.abort();
  reload.resolve({ok: true, value: airportReloadSuccess('CYYZ')});

  await expect(result).resolves.toBe(0);
  expect(stdout[0]).toContain('Cached Airport replaced\n  ICAO: CYYZ\n');
});

test('disposes exactly once inside the admitted span', async () => {
  const events: string[] = [];

  await expect(
    runAirportReload(
      admittedInput({
        env: configuredEnvironment(),
        async loadTelemetry() {
          return lifecycleTelemetry(events);
        },
        async openApplication() {
          events.push('application opened');
          return {
            ok: true,
            value: syntheticApplication(
              async () => ({ok: true, value: airportReloadSuccess('CYYZ')}),
              () => events.push('application disposed')
            ),
          };
        },
      }),
      {icao: 'CYYZ'}
    )
  ).resolves.toBe(0);

  expect(events).toEqual([
    'span started reload-airport CYYZ',
    'application opened',
    'application disposed',
    'result recorded 0',
    'span ended',
    'telemetry closed',
  ]);
});

test('lets cleanup defects replace an interrupted outcome', async () => {
  const cleanupDefect = new Error('cleanup defect');
  const controller = new AbortController();

  await expect(
    runAirportReload(
      admittedInput({
        env: configuredEnvironment(),
        signal: controller.signal,
        async openApplication() {
          return {
            ok: true,
            value: syntheticApplication(
              async request => {
                controller.abort();
                throw request.signal?.reason;
              },
              () => {
                throw cleanupDefect;
              }
            ),
          };
        },
      }),
      {icao: 'CYYZ'}
    )
  ).rejects.toBe(cleanupDefect);
});

function admittedInput(
  overrides: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    loadTelemetry?: CliTelemetryTypes['Loader'];
    openApplication?: NonNullable<CliInputTypes['Admitted']['openApplication']>;
    signal?: AbortSignal;
    writeStderr?: (text: string) => void;
    writeStdout?: (text: string) => void;
  }>
): CliInputTypes['Admitted'] {
  return {
    env: overrides.env ?? {},
    io: {
      writeStderr: overrides.writeStderr ?? (() => {}),
      writeStdout: overrides.writeStdout ?? (() => {}),
    },
    loadTelemetry: overrides.loadTelemetry ?? inertTelemetry,
    ...(overrides.openApplication === undefined
      ? {}
      : {openApplication: overrides.openApplication}),
    ...(overrides.signal === undefined ? {} : {signal: overrides.signal}),
  };
}

function configuredEnvironment() {
  return {
    OPENAIP_API_KEY: 'secret-api-key',
    RADIAL_DATABASE_PATH: ':synthetic:',
  };
}

async function inertTelemetry(): Promise<CliTelemetryTypes['Session']> {
  return {
    async execute(_metadata, operation) {
      return operation();
    },
    recordOperation() {},
    async close() {},
  };
}

function recordingTelemetry(
  metadata: CliTelemetryTypes['CommandMetadata'][]
): CliTelemetryTypes['Session'] {
  return {
    async execute(actualMetadata, operation) {
      metadata.push(actualMetadata);
      return operation();
    },
    recordOperation() {},
    async close() {},
  };
}

function lifecycleTelemetry(events: string[]): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      const icao =
        metadata.id === 'reload-airport'
          ? metadata.attributes['radial.airport.icao']
          : '';
      events.push(`span started ${metadata.id} ${icao}`);
      try {
        const result = await operation();
        events.push(`result recorded ${result.status}`);
        return result;
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

function syntheticApplication(
  reloadAirport: ApplicationTypes['DataManagementCapability']['reloadAirport'],
  onDispose: () => void = () => {}
): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      reloadAirport,
      async reloadNavaids() {
        throw new Error('Navaid reload is not used by this test.');
      },
      async status() {
        throw new Error('Data status is not used by this test.');
      },
    },
    planning: {
      async open() {
        throw new Error('Route planning is not used by this test.');
      },
    },
    async [Symbol.asyncDispose]() {
      onDispose();
    },
  };
}

function airportReloadSuccess(icao: string): ApplicationTypes['AirportReloadSuccess'] {
  return {
    status: 'replaced',
    icao,
    sourceId: `airport-${icao.toLowerCase()}`,
    retrievedAt: '2026-07-10T00:00:00.000Z',
  };
}
