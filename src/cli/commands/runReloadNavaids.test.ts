import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runReloadNavaids from '#radial/cli/commands/runReloadNavaids.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';

test('rejects missing Navaid reload configuration before opening the application', async () => {
  const stderr: string[] = [];
  let applicationOpened = false;
  const runtime = runtimeContext({
    env: {},
    writeStderr(text) {
      stderr.push(text);
    },
    async withApplication() {
      applicationOpened = true;
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  await expect(runReloadNavaids({}, runtime)).resolves.toEqual({
    kind: 'expected-failure',
    status: 1,
  });
  expect(applicationOpened).toBe(false);
  expect(stderr).toEqual([
    'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('rejects missing OpenAIP credentials before opening the application', async () => {
  const stderr: string[] = [];
  let applicationOpened = false;
  const runtime = runtimeContext({
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    writeStderr(text) {
      stderr.push(text);
    },
    async withApplication() {
      applicationOpened = true;
      throw new Error('The application must not open without credentials.');
    },
  });

  await expect(runReloadNavaids({}, runtime)).resolves.toEqual({
    kind: 'expected-failure',
    status: 1,
  });
  expect(applicationOpened).toBe(false);
  expect(stderr).toEqual([
    'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for an explicit Navaid reload.\n' +
      'Action: Set OPENAIP_API_KEY and retry the Navaid reload.\n' +
      'Active data remains unchanged.\n',
  ]);
});

test('streams progress and reports an operational failure through runtime capabilities', async () => {
  const writes: Array<Readonly<{channel: 'stderr' | 'stdout'; text: string}>> = [];
  const scope = createCliRuntimeContext({
    env: {
      OPENAIP_API_KEY: 'secret-api-key',
      RADIAL_DATABASE_PATH: ':synthetic:',
    },
    io: {
      writeStderr(text) {
        writes.push({channel: 'stderr', text});
      },
      writeStdout(text) {
        writes.push({channel: 'stdout', text});
      },
    },
    signal: new AbortController().signal,
    async loadApplication() {
      return async config => {
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
      };
    },
  });

  try {
    await expect(runReloadNavaids({}, scope.context)).resolves.toEqual({
      kind: 'expected-failure',
      status: 1,
    });
  } finally {
    await scope[Symbol.asyncDispose]();
  }

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

test('returns silent status 130 when shared cancellation prevents completion', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const writes: string[] = [];
  const scope = createCliRuntimeContext({
    env: {
      OPENAIP_API_KEY: 'secret-api-key',
      RADIAL_DATABASE_PATH: ':synthetic:',
    },
    io: {
      writeStderr(text) {
        writes.push(text);
      },
      writeStdout(text) {
        writes.push(text);
      },
    },
    signal: controller.signal,
    async loadApplication() {
      return async () => ({
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
      });
    },
  });

  const result = runReloadNavaids({}, scope.context);
  await started.promise;
  controller.abort();

  try {
    await expect(result).resolves.toEqual({kind: 'interrupted', status: 130});
  } finally {
    await scope[Symbol.asyncDispose]();
  }

  expect(writes).toEqual([]);
});

test('writes success only after committed publication wins over late cancellation', async () => {
  const controller = new AbortController();
  const reload = Promise.withResolvers<ApplicationTypes['NavaidReloadResult']>();
  const started = Promise.withResolvers<void>();
  const writes: Array<Readonly<{channel: 'stderr' | 'stdout'; text: string}>> = [];
  const scope = createCliRuntimeContext({
    env: {
      OPENAIP_API_KEY: 'secret-api-key',
      RADIAL_DATABASE_PATH: ':synthetic:',
    },
    io: {
      writeStderr(text) {
        writes.push({channel: 'stderr', text});
      },
      writeStdout(text) {
        writes.push({channel: 'stdout', text});
      },
    },
    signal: controller.signal,
    async loadApplication() {
      return async () => ({
        ok: true,
        value: syntheticApplication(async request => {
          started.resolve();
          request.onProgress?.({
            stage: 'publish',
            message: 'Publishing Navaid Snapshot.',
          });
          return reload.promise;
        }),
      });
    },
  });

  const result = runReloadNavaids({}, scope.context);
  await started.promise;
  expect(writes).toEqual([
    {channel: 'stderr', text: 'progress: Publishing Navaid Snapshot.\n'},
  ]);

  controller.abort();
  reload.resolve({ok: true, value: syntheticNavaidReloadSuccess()});
  try {
    await expect(result).resolves.toEqual({kind: 'success', status: 0});
  } finally {
    await scope[Symbol.asyncDispose]();
  }

  expect(writes[1]).toMatchObject({
    channel: 'stdout',
    text: expect.stringContaining('Navaid Snapshot replaced\n'),
  });
});

test('disposes the application before the handler result leaves its runtime scope', async () => {
  let disposed = false;
  const scope = createCliRuntimeContext({
    env: {
      OPENAIP_API_KEY: 'secret-api-key',
      RADIAL_DATABASE_PATH: ':synthetic:',
    },
    io: {writeStderr() {}, writeStdout() {}},
    signal: new AbortController().signal,
    async loadApplication() {
      return async () => ({
        ok: true,
        value: syntheticApplication(
          async () => ({ok: true, value: syntheticNavaidReloadSuccess()}),
          () => {
            disposed = true;
          }
        ),
      });
    },
  });

  try {
    await expect(runReloadNavaids({}, scope.context)).resolves.toEqual({
      kind: 'success',
      status: 0,
    });
    expect(disposed).toBe(true);
  } finally {
    await scope[Symbol.asyncDispose]();
  }
});

function runtimeContext({
  env,
  writeStderr,
  withApplication,
}: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  writeStderr(text: string): void;
  withApplication: CliRuntimeTypes['Context']['withApplication'];
}>): CliRuntimeTypes['Context'] {
  return {
    command: {id: 'reload-navaids'},
    async disposeApplication() {},
    env,
    io: {writeStdout() {}, writeStderr},
    signal: new AbortController().signal,
    withApplication,
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
