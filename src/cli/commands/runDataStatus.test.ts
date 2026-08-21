import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test, vi} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import runDataStatus from '#radial/cli/commands/runDataStatus.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

const DATABASE_PATH = '/synthetic.duckdb';

test('dispatches status once, preserves output and telemetry, and disposes before resolving', async () => {
  const capture = captureOutput();
  const events: CliTelemetryTypes['OperationEvent'][] = [];
  const metadata: CliTelemetryTypes['CommandMetadata'][] = [];
  const status = vi.fn(async () => ({ok: true, value: uninitializedStatus()}) as const);
  let disposed = false;

  await expect(
    runDataStatus(
      admittedInput({
        capture,
        env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
        loadTelemetry: async () => telemetry(events, metadata),
        async openApplication(config) {
          expect(config).toEqual({databasePath: DATABASE_PATH});
          return {
            ok: true,
            value: syntheticApplication(status, () => (disposed = true)),
          };
        },
      }),
      {}
    )
  ).resolves.toBe(0);
  expect(status).toHaveBeenCalledTimes(1);
  expect(disposed).toBe(true);
  expect(capture.output()).toEqual({stdout: formattedSuccess(), stderr: ''});
  expect(metadata).toEqual([{id: 'data-status'}]);
  expect(events).toEqual([
    {
      kind: 'data-status-completed',
      cachedAirportCount: 0,
      snapshotPresent: false,
      status: 'uninitialized',
    },
  ]);
});

test('preserves an injected expected failure and disposes the application', async () => {
  const capture = captureOutput();
  const events: CliTelemetryTypes['OperationEvent'][] = [];
  const failure = dataFailure('DATA_DATABASE_INVALID');
  let disposed = false;

  await expect(
    runDataStatus(
      admittedInput({
        capture,
        env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
        loadTelemetry: async () => telemetry(events),
        async openApplication() {
          return {
            ok: true,
            value: syntheticApplication(
              async () => ({ok: false, failure}),
              () => (disposed = true)
            ),
          };
        },
      }),
      {}
    )
  ).resolves.toBe(1);
  expect(disposed).toBe(true);
  expect(capture.output()).toEqual({stdout: '', stderr: formattedFailure(failure)});
  expect(events).toEqual([
    {
      kind: 'data-status-failed',
      activeDataPreserved: true,
      failureCode: 'DATA_DATABASE_INVALID',
    },
  ]);
});

test('rejects a blank path before opening the application', async () => {
  const capture = captureOutput();
  const events: CliTelemetryTypes['OperationEvent'][] = [];
  let opened = false;

  await expect(
    runDataStatus(
      admittedInput({
        capture,
        env: {RADIAL_DATABASE_PATH: '  '},
        loadTelemetry: async () => telemetry(events),
        async openApplication() {
          opened = true;
          throw new Error('Application must not open for a blank path.');
        },
      }),
      {}
    )
  ).resolves.toBe(1);
  expect(opened).toBe(false);
  expect(capture.output()).toEqual({stdout: '', stderr: formattedMissingPath()});
  expect(events).toEqual([
    {
      kind: 'data-status-failed',
      activeDataPreserved: true,
      failureCode: 'DATA_DATABASE_PATH_MISSING',
    },
  ]);
});

test('returns a silent interruption before inspection without opening the application', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  controller.abort(new Error('Interrupted.'));
  const events: CliTelemetryTypes['OperationEvent'][] = [];
  let opened = false;

  await expect(
    runDataStatus(
      admittedInput({
        capture,
        env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
        loadTelemetry: async () => telemetry(events),
        signal: controller.signal,
        async openApplication() {
          opened = true;
          throw new Error('Application must not open after interruption.');
        },
      }),
      {}
    )
  ).resolves.toBe(130);
  expect(opened).toBe(false);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  expect(events).toEqual([]);
});

test('returns a silent interruption after inspection and disposes before resolving', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const status = Promise.withResolvers<ApplicationTypes['DataStatusResult']>();
  const started = Promise.withResolvers<void>();
  const events: CliTelemetryTypes['OperationEvent'][] = [];
  let disposed = false;
  const running = runDataStatus(
    admittedInput({
      capture,
      env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
      loadTelemetry: async () => telemetry(events),
      signal: controller.signal,
      async openApplication() {
        return {
          ok: true,
          value: syntheticApplication(
            () => {
              started.resolve();
              return status.promise;
            },
            () => (disposed = true)
          ),
        };
      },
    }),
    {}
  );

  await started.promise;
  controller.abort();
  status.resolve({ok: true, value: uninitializedStatus()});

  await expect(running).resolves.toBe(130);
  expect(disposed).toBe(true);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  expect(events).toEqual([]);
});

test('disposes and rethrows a status defect unchanged', async () => {
  const defect = new Error('Synthetic status defect.');
  let disposed = false;

  await expect(
    runDataStatus(
      admittedInput({
        env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
        async openApplication() {
          return {
            ok: true,
            value: syntheticApplication(
              async () => {
                throw defect;
              },
              () => (disposed = true)
            ),
          };
        },
      }),
      {}
    )
  ).rejects.toBe(defect);
  expect(disposed).toBe(true);
});

test.each(['success', 'expected-failure', 'interruption', 'thrown-failure'] as const)(
  'gives cleanup failure precedence over %s',
  async outcome => {
    const cleanupFailure = new Error('Synthetic cleanup defect.');
    const operationFailure = new Error('Synthetic operation defect.');
    const controller = new AbortController();

    await expect(
      runDataStatus(
        admittedInput({
          env: {RADIAL_DATABASE_PATH: DATABASE_PATH},
          signal: controller.signal,
          async openApplication() {
            return {
              ok: true,
              value: syntheticApplication(
                async () => {
                  if (outcome === 'interruption') controller.abort();
                  if (outcome === 'thrown-failure') throw operationFailure;
                  if (outcome === 'expected-failure') {
                    return {
                      ok: false,
                      failure: dataFailure('DATA_DATABASE_INVALID'),
                    };
                  }

                  return {ok: true, value: uninitializedStatus()};
                },
                () => {
                  throw cleanupFailure;
                }
              ),
            };
          },
        }),
        {}
      )
    ).rejects.toBe(cleanupFailure);
  }
);

test('preserves the path inspection diagnostic when application acquisition fails', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-path-'));
  const invalidParentPath = join(temporaryDirectory, 'not-a-directory');
  const databasePath = join(invalidParentPath, 'database.duckdb');
  await writeFile(invalidParentPath, 'not a directory');
  const capture = captureOutput();
  const events: CliTelemetryTypes['OperationEvent'][] = [];

  try {
    await expect(
      runDataStatus(
        admittedInput({
          capture,
          env: {RADIAL_DATABASE_PATH: databasePath},
          loadTelemetry: async () => telemetry(events),
        }),
        {}
      )
    ).resolves.toBe(1);
    expect(capture.output()).toEqual({
      stdout: '',
      stderr: formattedUninspectablePath(),
    });
    expect(events).toEqual([
      {
        kind: 'data-status-failed',
        activeDataPreserved: true,
        failureCode: 'DATA_DATABASE_UNAVAILABLE',
      },
    ]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

function admittedInput(
  overrides: Readonly<{
    capture?: ReturnType<typeof captureOutput>;
    env?: Readonly<Record<string, string | undefined>>;
    loadTelemetry?: CliTelemetryTypes['Loader'];
    openApplication?: NonNullable<CliInputTypes['Admitted']['openApplication']>;
    signal?: AbortSignal;
  }>
): CliInputTypes['Admitted'] {
  const capture = overrides.capture ?? captureOutput();
  return {
    env: overrides.env ?? {},
    io: capture.io,
    loadTelemetry: overrides.loadTelemetry ?? inertTelemetry,
    ...(overrides.openApplication === undefined
      ? {}
      : {openApplication: overrides.openApplication}),
    ...(overrides.signal === undefined ? {} : {signal: overrides.signal}),
  };
}

function captureOutput() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      writeStdout(text: string) {
        stdout += text;
      },
      writeStderr(text: string) {
        stderr += text;
      },
    },
    output() {
      return {stdout, stderr};
    },
  };
}

function syntheticApplication(
  status: ApplicationTypes['DataManagementCapability']['status'],
  onDispose: () => void = () => {}
): ApplicationTypes['Application'] {
  return {
    databasePath: DATABASE_PATH,
    dataManagement: {
      status,
      async reloadNavaids() {
        throw new Error('Navaid reload is not used by this test.');
      },
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

function uninitializedStatus(): ApplicationTypes['DataStatusSuccess'] {
  return {
    databasePath: DATABASE_PATH,
    status: 'uninitialized',
    legacyObjects: [],
    producerSchema: null,
    snapshot: null,
    cachedAirports: [],
  };
}

function dataFailure(
  code: ApplicationTypes['DataFailure']['code']
): ApplicationTypes['DataFailure'] {
  return {
    code,
    summary: 'Synthetic status failed.',
    cause: 'Synthetic cause.',
    action: 'Synthetic action.',
    activeDataPreserved: true,
  };
}

function formattedSuccess(): string {
  return (
    'Radial data status\n' +
    'Database\n' +
    `  Path: ${DATABASE_PATH}\n` +
    '  State: uninitialized\n' +
    '  Producer Schema version: —\n' +
    '  Planner contract version: —\n' +
    '  Checksum manifest version: —\n' +
    '  Legacy data: —\n' +
    '\nNavaid Snapshot\n' +
    '  State: uninitialized\n' +
    '\nCached Airports\n' +
    '  —\n'
  );
}

function formattedFailure(failure: ApplicationTypes['DataFailure']): string {
  return (
    `error [${failure.code}]: ${failure.summary}\n` +
    `Cause: ${failure.cause}\n` +
    `Action: ${failure.action}\n` +
    'Active data remains unchanged.\n'
  );
}

function formattedMissingPath(): string {
  return (
    'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
    'Cause: RADIAL_DATABASE_PATH is required for data status.\n' +
    'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
    'Active data remains unchanged.\n'
  );
}

function formattedUninspectablePath(): string {
  return (
    'error [DATA_DATABASE_UNAVAILABLE]: The configured database is unavailable.\n' +
    'Cause: The configured database path could not be inspected.\n' +
    'Action: Check RADIAL_DATABASE_PATH and retry.\n' +
    'Active data remains unchanged.\n'
  );
}

async function inertTelemetry(): Promise<CliTelemetryTypes['Session']> {
  return telemetry([]);
}

function telemetry(
  events: CliTelemetryTypes['OperationEvent'][],
  metadata: CliTelemetryTypes['CommandMetadata'][] = []
): CliTelemetryTypes['Session'] {
  return {
    async execute(commandMetadata, operation) {
      metadata.push(commandMetadata);
      return operation();
    },
    recordOperation(event) {
      events.push(event);
    },
    async close() {},
  };
}
