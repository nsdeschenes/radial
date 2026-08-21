import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import runReloadNavaids from '#radial/cli/commands/runReloadNavaids.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test('rejects missing configuration before opening the application with database precedence', async () => {
  const stderr: string[] = [];
  let applicationOpenCount = 0;
  const controller = new AbortController();
  controller.abort();

  await expect(
    runReloadNavaids(
      admittedInput({
        env: {},
        signal: controller.signal,
        writeStderr: text => stderr.push(text),
        async openApplication() {
          applicationOpenCount += 1;
          throw new Error('Invalid configuration must not open the application.');
        },
      }),
      {}
    )
  ).resolves.toBe(1);
  expect(applicationOpenCount).toBe(0);
  expect(stderr).toEqual([
    'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('rejects missing OpenAIP credentials before opening the application', async () => {
  const stderr: string[] = [];
  let applicationOpenCount = 0;

  await expect(
    runReloadNavaids(
      admittedInput({
        env: {RADIAL_DATABASE_PATH: ':synthetic:'},
        writeStderr: text => stderr.push(text),
        async openApplication() {
          applicationOpenCount += 1;
          throw new Error('Missing credentials must not open the application.');
        },
      }),
      {}
    )
  ).resolves.toBe(1);
  expect(applicationOpenCount).toBe(0);
  expect(stderr).toEqual([
    'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for an explicit Navaid reload.\n' +
      'Action: Set OPENAIP_API_KEY and retry the Navaid reload.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('streams progress before reporting an operational failure', async () => {
  const writes: Array<Readonly<{channel: 'stderr' | 'stdout'; text: string}>> = [];

  const status = await runReloadNavaids(
    admittedInput({
      env: configuredEnvironment(),
      writeStderr: text => writes.push({channel: 'stderr', text}),
      writeStdout: text => writes.push({channel: 'stdout', text}),
      async openApplication(config) {
        expect(config).toEqual({databasePath: ':synthetic:'});
        return {
          ok: true,
          value: syntheticApplication(async request => {
            expect(request.openAipApiKey).toBe('secret-api-key');
            request.onProgress?.({
              stage: 'openaip',
              message: 'Acquiring OpenAIP Navaids.',
            });
            return {
              ok: false,
              failure: {
                code: 'DATA_OPENAIP_UNAVAILABLE',
                summary: 'OpenAIP Navaid acquisition failed.',
                cause: 'OpenAIP Navaid acquisition did not complete.',
                action: 'Check OpenAIP availability and credentials, then retry.',
                activeDataPreserved: true,
              },
            };
          }),
        };
      },
    }),
    {}
  );

  expect(status).toBe(1);
  expect(writes).toEqual([
    {channel: 'stderr', text: 'progress: Acquiring OpenAIP Navaids.\n'},
    {
      channel: 'stderr',
      text:
        'error [DATA_OPENAIP_UNAVAILABLE]: OpenAIP Navaid acquisition failed.\n' +
        'Cause: OpenAIP Navaid acquisition did not complete.\n' +
        'Action: Check OpenAIP availability and credentials, then retry.\n' +
        'Active data remains unchanged.\n',
    },
  ]);
});

test('returns silent status 130 for cancellation before publication', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const writes: string[] = [];
  const result = runReloadNavaids(
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
    {}
  );

  await started.promise;
  controller.abort();

  await expect(result).resolves.toBe(130);
  expect(writes).toEqual([]);
});

test('reports committed publication success despite late cancellation', async () => {
  const controller = new AbortController();
  const reload = Promise.withResolvers<ApplicationTypes['NavaidReloadResult']>();
  const started = Promise.withResolvers<void>();
  const writes: Array<Readonly<{channel: 'stderr' | 'stdout'; text: string}>> = [];
  const result = runReloadNavaids(
    admittedInput({
      env: configuredEnvironment(),
      signal: controller.signal,
      writeStderr: text => writes.push({channel: 'stderr', text}),
      writeStdout: text => writes.push({channel: 'stdout', text}),
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(async request => {
            started.resolve();
            request.onProgress?.({
              stage: 'publish',
              message: 'Publishing Navaid Snapshot.',
            });
            return reload.promise;
          }),
        };
      },
    }),
    {}
  );

  await started.promise;
  controller.abort();
  reload.resolve({ok: true, value: syntheticNavaidReloadSuccess()});

  await expect(result).resolves.toBe(0);
  expect(writes[0]).toEqual({
    channel: 'stderr',
    text: 'progress: Publishing Navaid Snapshot.\n',
  });
  expect(writes[1]).toMatchObject({
    channel: 'stdout',
    text: expect.stringContaining('Navaid Snapshot replaced\n'),
  });
});

test('owns metadata and disposes exactly once inside its admitted span', async () => {
  const events: string[] = [];

  await expect(
    runReloadNavaids(
      admittedInput({
        env: configuredEnvironment(),
        async loadTelemetry() {
          return recordingTelemetry(events);
        },
        async openApplication() {
          events.push('application opened');
          return {
            ok: true,
            value: syntheticApplication(
              async () => ({ok: true, value: syntheticNavaidReloadSuccess()}),
              () => events.push('application disposed')
            ),
          };
        },
      }),
      {}
    )
  ).resolves.toBe(0);

  expect(events).toEqual([
    'span started reload-navaids',
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
    runReloadNavaids(
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
      {}
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

function recordingTelemetry(events: string[]): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      events.push(`span started ${metadata.id}`);
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
  reloadNavaids: ApplicationTypes['DataManagementCapability']['reloadNavaids'],
  onDispose: () => void = () => {}
): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async status() {
        throw new Error('Data status is not used by this test.');
      },
      reloadNavaids,
      async reloadAirport() {
        throw new Error('Airport reload is not used by this test.');
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

function syntheticNavaidReloadSuccess(): ApplicationTypes['NavaidReloadSuccess'] {
  return {
    snapshotId: '11111111-1111-4111-8111-111111111111',
    snapshotChecksum: `sha256:${'1'.repeat(64)}`,
    rawNavaidCount: 3,
    plannerNavaidCount: 2,
    vorFamilyNavaidCount: 1,
    fallbackNavaidCount: 1,
    exclusionCount: 1,
    exclusionCounts: [{reason: 'unsupported-navaid-type', count: 1}],
    facilityVariationPresentCount: 1,
    facilityVariationMissingCount: 0,
    facilityVariationEpochYearMissingCount: 0,
    retrievedAt: '2026-07-10T00:00:00.000Z',
    retrievalCompletedAt: '2026-07-10T00:00:02.000Z',
    provenance: {
      sourceIdentity: 'openaip:navaids:v1',
      derivationPolicyIdentity: 'radial:navaid-derivation:v1',
      matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
      magneticModel: {
        model: 'WMM',
        version: 'WMM2025',
        epochYear: 2025,
        referenceDate: '2026-07-10',
        source: 'NOAA',
        coefficientChecksum: `sha256:${'4'.repeat(64)}`,
      },
      faaNasr: {
        archiveChecksum: `sha256:${'2'.repeat(64)}`,
        archiveIdentity: '09_Jul_2026_NAV_CSV.zip',
        contentChecksum: `sha256:${'3'.repeat(64)}`,
        cycleId: '2607',
        effectiveDate: '2026-07-09',
        publishedAt: '2026-06-25T12:00:00.000Z',
        retrievedAt: '2026-07-10T00:00:01.000Z',
        sourceUrl:
          'https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_NAV_CSV.zip',
      },
    },
  };
}
