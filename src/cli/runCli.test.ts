import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/runCli.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

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

function recordingOperationalTelemetry(
  operationEvents: CliTelemetryTypes['OperationEvent'][]
): CliTelemetryTypes['Session'] {
  return {
    async execute(_metadata, operation) {
      return operation();
    },
    recordOperation(event) {
      operationEvents.push(event);
    },
    async close() {},
  };
}

test('reports malformed command input on stderr and exits 2', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: [' YYZ ', 'cyow'],
    env: {},
    io: capture.io,
  });

  expect(exitCode).toBe(2);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'Departure must be a four-letter ICAO airport code; received " YYZ ".\n' +
      'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
      'Example: radial CYYZ CYOW\n',
  });
});

test('keeps data status help and rejected input outside the lifecycle', async () => {
  const helpCapture = captureOutput();
  const optionCapture = captureOutput();
  const argumentCapture = captureOutput();
  let operationalLifecycleEntries = 0;
  const lifecycleTraps = {
    async loadCommand() {
      operationalLifecycleEntries += 1;
      throw new Error('Data status help and rejections must not load the command.');
    },
    async loadTelemetry() {
      operationalLifecycleEntries += 1;
      throw new Error('Data status help and rejections must not initialize telemetry.');
    },
    async openApplication() {
      operationalLifecycleEntries += 1;
      throw new Error('Data status help and rejections must not open the application.');
    },
  };

  await expect(
    runCli({
      ...lifecycleTraps,
      args: ['data', 'status', '--help'],
      env: {},
      io: helpCapture.io,
    })
  ).resolves.toBe(0);
  await expect(
    runCli({
      ...lifecycleTraps,
      args: ['data', 'status', '--force'],
      env: {},
      io: optionCapture.io,
    })
  ).resolves.toBe(2);
  await expect(
    runCli({
      ...lifecycleTraps,
      args: ['data', 'status', 'extra'],
      env: {},
      io: argumentCapture.io,
    })
  ).resolves.toBe(2);

  expect(helpCapture.output()).toEqual({
    stdout: 'Usage: radial data status\n',
    stderr: '',
  });
  const usageOutput = {
    stdout: '',
    stderr:
      'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The data status command accepts no arguments or operational flags.\n' +
      'Action: Run "radial data status".\n',
  };
  expect(optionCapture.output()).toEqual(usageOutput);
  expect(argumentCapture.output()).toEqual(usageOutput);
  expect(operationalLifecycleEntries).toBe(0);
});

test('reports a nonexistent database as uninitialized without creating it', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-cli-status-'));
  const databasePath = join(temporaryDirectory, 'missing.duckdb');
  const capture = captureOutput();

  try {
    await expect(
      runCli({
        args: ['data', 'status'],
        env: {RADIAL_DATABASE_PATH: databasePath},
        io: capture.io,
      })
    ).resolves.toBe(0);
    expect(capture.output()).toEqual({
      stdout:
        'Radial data status\n' +
        'Database\n' +
        `  Path: ${databasePath}\n` +
        '  State: uninitialized\n' +
        '  Producer Schema version: —\n' +
        '  Planner contract version: —\n' +
        '  Checksum manifest version: —\n' +
        '  Legacy data: —\n' +
        '\nNavaid Snapshot\n' +
        '  State: uninitialized\n' +
        '\nCached Airports\n' +
        '  —\n',
      stderr: '',
    });
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('validates Navaid reload configuration before opening the application', async () => {
  const capture = captureOutput();
  let applicationOpened = false;

  const exitCode = await runCli({
    args: ['data', 'reload', 'navaids'],
    env: {},
    io: capture.io,
    async openApplication() {
      applicationOpened = true;
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  expect(applicationOpened).toBe(false);
  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
      'Active data remains unchanged.\n',
  });
});

test('reports a missing Navaid reload credential before opening the application', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
    async openApplication() {
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for an explicit Navaid reload.\n' +
      'Action: Set OPENAIP_API_KEY and retry the Navaid reload.\n' +
      'Active data remains unchanged.\n',
  });
});

test('provides Navaid reload help and rejects unsupported options', async () => {
  const helpCapture = captureOutput();
  const usageCapture = captureOutput();

  await expect(
    runCli({
      args: ['data', 'reload', 'navaids', '--help'],
      env: {},
      io: helpCapture.io,
    })
  ).resolves.toBe(0);
  await expect(
    runCli({
      args: ['data', 'reload', 'navaids', '--force'],
      env: {},
      io: usageCapture.io,
    })
  ).resolves.toBe(2);
  expect(helpCapture.output()).toEqual({
    stdout: 'Usage: radial data reload navaids\n',
    stderr: '',
  });
  expect(usageCapture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
      'Action: Run "radial data reload navaids".\n',
  });
});

test('validates the Airport reload argument before opening the application', async () => {
  const capture = captureOutput();
  let applicationOpened = false;

  const exitCode = await runCli({
    args: ['data', 'reload', 'airport', ' bad '],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
    async openApplication() {
      applicationOpened = true;
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  expect(applicationOpened).toBe(false);
  expect(exitCode).toBe(2);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_INVALID_ICAO]: The Airport ICAO is invalid.\n' +
      'Cause: The requested Airport ICAO " bad " is not four ASCII letters.\n' +
      'Action: Provide exactly one four-letter ICAO and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  });
});

test('reports a missing Airport reload database path before opening the application', async () => {
  const capture = captureOutput();
  let applicationOpened = false;

  const exitCode = await runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      applicationOpened = true;
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  expect(applicationOpened).toBe(false);
  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  });
});

test('reports missing Airport reload credentials before opening the application', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
    async openApplication() {
      throw new Error('The application must not open for invalid configuration.');
    },
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for an explicit Airport reload.\n' +
      'Action: Set OPENAIP_API_KEY and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  });
});

test('provides Airport reload help and rejects extra arguments', async () => {
  const helpCapture = captureOutput();
  const usageCapture = captureOutput();

  await expect(
    runCli({
      args: ['data', 'reload', 'airport', '--help'],
      env: {},
      io: helpCapture.io,
    })
  ).resolves.toBe(0);
  await expect(
    runCli({
      args: ['data', 'reload', 'airport', 'CAAA', '--force'],
      env: {},
      io: usageCapture.io,
    })
  ).resolves.toBe(2);
  expect(helpCapture.output()).toEqual({
    stdout: 'Usage: radial data reload airport <ICAO>\n',
    stderr: '',
  });
  expect(usageCapture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
      'Action: Run "radial data reload airport <ICAO>".\n',
  });
});

test('streams Navaid reload progress to stderr and writes success only after commit', async () => {
  const capture = captureOutput();
  const reload = Promise.withResolvers<ApplicationTypes['NavaidReloadResult']>();
  const started = Promise.withResolvers<void>();
  const application = syntheticApplication(async request => {
    started.resolve();
    request.onProgress?.({stage: 'openaip', message: 'Acquiring OpenAIP Navaids.'});
    request.onProgress?.({stage: 'publish', message: 'Publishing Navaid Snapshot.'});
    return reload.promise;
  });

  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  await started.promise;

  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'progress: Acquiring OpenAIP Navaids.\n' +
      'progress: Publishing Navaid Snapshot.\n',
  });

  reload.resolve({ok: true, value: syntheticNavaidReloadSuccess()});
  await expect(running).resolves.toBe(0);
  expect(capture.output()).toEqual({
    stdout:
      'Navaid Snapshot replaced\n' +
      '  Snapshot ID: 11111111-1111-4111-8111-111111111111\n' +
      '  Retrieval started: 2026-07-10T00:00:00.000Z\n' +
      '  Retrieval completed: 2026-07-10T00:00:02.000Z\n' +
      '  Source: OpenAIP Core API\n' +
      '  Resource: /navaids\n' +
      '  API contract version: 1.1\n' +
      '  Source identity: openaip:navaids:v1\n' +
      '  Derivation policy: radial:navaid-derivation:v1\n' +
      '  Matching policy: radial:faa-nasr-match:v1\n' +
      '  FAA NASR cycle: 2607\n' +
      '  FAA NASR effective date: 2026-07-09\n' +
      '  FAA NASR published: 2026-06-25T12:00:00.000Z\n' +
      '  FAA NASR archive: 09_Jul_2026_NAV_CSV.zip\n' +
      `  FAA NASR archive checksum: sha256:${'2'.repeat(64)}\n` +
      `  FAA NASR content checksum: sha256:${'3'.repeat(64)}\n` +
      '  FAA NASR retrieved: 2026-07-10T00:00:01.000Z\n' +
      '  FAA NASR source: https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_NAV_CSV.zip\n' +
      '  Magnetic model: WMM WMM2025\n' +
      '  Magnetic model epoch: 2025\n' +
      '  Magnetic reference date: 2026-07-10\n' +
      '  Magnetic model source: NOAA\n' +
      `  Magnetic model checksum: sha256:${'4'.repeat(64)}\n` +
      `  Checksum: sha256:${'1'.repeat(64)}\n` +
      '  Raw records: 3\n' +
      '  VOR-family Navaids: 1\n' +
      '  Fallback Navaids: 1\n' +
      '  Excluded records: 1\n' +
      '    unsupported-navaid-type: 1\n' +
      '  Facility Variation of Record present: 1\n' +
      '  Facility Variation of Record missing: 0\n' +
      '  Facility Variation Epoch Year missing: 0\n',
    stderr:
      'progress: Acquiring OpenAIP Navaids.\n' +
      'progress: Publishing Navaid Snapshot.\n',
  });
});

test('writes a stable Navaid reload failure only to stderr', async () => {
  const capture = captureOutput();
  const application = syntheticApplication(async () => ({
    ok: false,
    failure: {
      code: 'DATA_OPENAIP_UNAVAILABLE',
      summary: 'OpenAIP Navaid acquisition failed.',
      cause: 'OpenAIP Navaid acquisition did not complete.',
      action: 'Check OpenAIP availability and credentials, then retry.',
      activeDataPreserved: true,
    },
  }));

  const exitCode = await runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_OPENAIP_UNAVAILABLE]: OpenAIP Navaid acquisition failed.\n' +
      'Cause: OpenAIP Navaid acquisition did not complete.\n' +
      'Action: Check OpenAIP availability and credentials, then retry.\n' +
      'Active data remains unchanged.\n',
  });
  expect(capture.output().stderr).not.toContain('secret-api-key');
});

test('cancels a pre-publication Navaid reload with exit status 130', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const application = syntheticApplication(
    request =>
      new Promise<ApplicationTypes['NavaidReloadResult']>((_resolve, reject) => {
        started.resolve();
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      })
  );

  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  await started.promise;
  controller.abort();

  await expect(running).resolves.toBe(130);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('waits for a publication result after interruption', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const reload = Promise.withResolvers<ApplicationTypes['NavaidReloadResult']>();
  const started = Promise.withResolvers<void>();
  const application = syntheticApplication(async () => {
    started.resolve();
    return reload.promise;
  });

  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  await started.promise;
  controller.abort();

  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  reload.resolve({ok: true, value: syntheticNavaidReloadSuccess()});
  await expect(running).resolves.toBe(0);
  expect(capture.output().stdout).toContain('Navaid Snapshot replaced\n');
});

test('disposes the Navaid reload application before returning success', async () => {
  const capture = captureOutput();
  const events: string[] = [];
  const application = syntheticApplication(
    async () => ({ok: true, value: syntheticNavaidReloadSuccess()}),
    () => events.push('application disposed')
  );

  const exitCode = await runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  events.push('returned');

  expect(exitCode).toBe(0);
  expect(events).toEqual(['application disposed', 'returned']);
});

test('propagates Navaid reload disposal failure instead of interrupted status 130', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const disposalFailure = new Error('Navaid reload cleanup failed');
  const application = syntheticApplication(
    request =>
      new Promise((_resolve, reject) => {
        started.resolve();
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      }),
    () => {
      throw disposalFailure;
    }
  );
  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();

  await expect(running).rejects.toBe(disposalFailure);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('streams Airport reload progress and writes success only after commit', async () => {
  const capture = captureOutput();
  const reload = Promise.withResolvers<ApplicationTypes['AirportReloadResult']>();
  const started = Promise.withResolvers<void>();
  const application = syntheticAirportApplication(async request => {
    expect(request.icao).toBe('CAAA');
    request.onProgress?.({stage: 'openaip', message: 'Looking up Airport CAAA.'});
    request.onProgress?.({stage: 'publish', message: 'Publishing Cached Airport.'});
    started.resolve();
    return reload.promise;
  });

  const running = runCli({
    args: ['data', 'reload', 'airport', ' caaa '],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  await started.promise;

  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'progress: Looking up Airport CAAA.\n' + 'progress: Publishing Cached Airport.\n',
  });

  reload.resolve({
    ok: true,
    value: {
      status: 'replaced',
      icao: 'CAAA',
      sourceId: 'airport-caaa',
      retrievedAt: '2026-07-10T00:00:00.000Z',
    },
  });
  await expect(running).resolves.toBe(0);
  expect(capture.output()).toEqual({
    stdout:
      'Cached Airport replaced\n' +
      '  ICAO: CAAA\n' +
      '  OpenAIP ID: airport-caaa\n' +
      '  Retrieved: 2026-07-10T00:00:00.000Z\n',
    stderr:
      'progress: Looking up Airport CAAA.\n' + 'progress: Publishing Cached Airport.\n',
  });
});

test('writes a failed Airport reload only to stderr', async () => {
  const capture = captureOutput();
  const application = syntheticAirportApplication(async () => ({
    ok: false,
    failure: {
      code: 'DATA_AIRPORT_NOT_FOUND',
      summary: 'The requested Airport was not found.',
      cause: 'OpenAIP returned no exact usable match for the requested ICAO.',
      action: 'Check the ICAO and retry the Airport reload.',
      activeDataPreserved: true,
    },
  }));

  const exitCode = await runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_AIRPORT_NOT_FOUND]: The requested Airport was not found.\n' +
      'Cause: OpenAIP returned no exact usable match for the requested ICAO.\n' +
      'Action: Check the ICAO and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
  });
  expect(capture.output().stderr).not.toContain('secret-api-key');
});

test('propagates an unrelated Airport reload AbortError after application disposal', async () => {
  const capture = captureOutput();
  const abortError = new Error('unrelated abort');
  abortError.name = 'AbortError';
  const events: string[] = [];
  const application = syntheticAirportApplication(
    async () => {
      throw abortError;
    },
    () => events.push('application disposed')
  );

  await expect(
    runCli({
      args: ['data', 'reload', 'airport', 'CAAA'],
      env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
      io: capture.io,
      async openApplication() {
        return {ok: true, value: application};
      },
    })
  ).rejects.toBe(abortError);
  expect(events).toEqual(['application disposed']);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('returns silent status 130 after interrupted Airport reload disposal', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const events: string[] = [];
  const application = syntheticAirportApplication(
    request => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    },
    () => events.push('application disposed')
  );
  const running = runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();

  await expect(running).resolves.toBe(130);
  expect(events).toEqual(['application disposed']);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('committed Airport replacement wins over late interruption', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const reload = Promise.withResolvers<ApplicationTypes['AirportReloadResult']>();
  const started = Promise.withResolvers<void>();
  const application = syntheticAirportApplication(async () => {
    started.resolve();
    return reload.promise;
  });
  const running = runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();
  reload.resolve({
    ok: true,
    value: {
      status: 'replaced',
      icao: 'CAAA',
      sourceId: 'airport-caaa',
      retrievedAt: '2026-07-10T00:00:00.000Z',
    },
  });

  await expect(running).resolves.toBe(0);
  expect(capture.output().stdout).toContain('Cached Airport replaced\n');
});

test('propagates Airport reload cleanup failure instead of interrupted status 130', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cleanupFailure = new Error('application cleanup failed');
  const application = syntheticAirportApplication(
    request => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    },
    () => {
      throw cleanupFailure;
    }
  );
  const running = runCli({
    args: ['data', 'reload', 'airport', 'CAAA'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();

  await expect(running).rejects.toBe(cleanupFailure);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('reports an incorrect positional argument count on stderr and exits 2', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({args: ['CYYZ'], env: {}, io: capture.io});

  expect(exitCode).toBe(2);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'Expected exactly two ICAO airport codes; received 1.\n' +
      'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
      'Example: radial CYYZ CYOW\n',
  });
});

test('reports identical normalized airports on stderr and exits 2', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: [' cyyz ', 'CYYZ'],
    env: {},
    io: capture.io,
  });

  expect(exitCode).toBe(2);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'Departure and arrival must be different airports; both normalize to "CYYZ".\n' +
      'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
      'Example: radial CYYZ CYOW\n',
  });
});

test('reports missing database configuration on stderr and exits 1', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({args: ['cyyz', ' CYOW '], env: {}, io: capture.io});

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Unable to initialize Route Planner: RADIAL_DATABASE_PATH is required.\n',
  });
});

test('reports invalid route-factor configuration on stderr and exits 1', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['CYYZ', 'CYOW'],
    env: {
      RADIAL_DATABASE_PATH: ':memory:',
      RADIAL_MAX_ROUTE_FACTOR: 'Infinity',
    },
    io: capture.io,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'Unable to initialize Route Planner: RADIAL_MAX_ROUTE_FACTOR must be a finite number greater than or equal to 1; received "Infinity".\n',
  });
});

test('reports an unavailable database on stderr and exits 1', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-cli-'));
  const capture = captureOutput();
  const databasePath = join(temporaryDirectory, 'missing', 'radial.duckdb');

  try {
    const exitCode = await runCli({
      args: ['CYYZ', 'CYOW'],
      env: {RADIAL_DATABASE_PATH: databasePath},
      io: capture.io,
    });

    expect(exitCode).toBe(1);
    expect(capture.output()).toEqual({
      stdout: '',
      stderr: `Unable to initialize Route Planner: database at "${databasePath}" is unavailable.\n`,
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports an invalid planner-ready database contract on stderr', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['cyyz', ' CYOW '],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Unable to initialize Route Planner: the database contract is invalid.\n',
  });
});

test('reports a safe first Navaid Snapshot bootstrap failure on stderr', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['CYYZ', 'CYOW'],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_CREDENTIALS_MISSING]: OpenAIP credentials are missing.\n' +
      'Cause: OPENAIP_API_KEY is required for the first Navaid Snapshot bootstrap.\n' +
      'Action: Set OPENAIP_API_KEY and retry planning.\n' +
      'Active data remains unchanged.\n',
  });
});

test('writes a complete normal Route Plan to stdout and exits 0', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0, 5),
      syntheticAirport('arrival', 'BBBB', 2, -2),
    ],
    navaids: [
      {
        databaseId: 'vor',
        identifier: 'MID',
        name: 'Middle VOR/DME',
        family: 'VOR-DME',
        longitude: 1,
        latitude: 0,
        frequencyValue: 113.7,
        frequencyUnit: 'MHz',
        publishedRangeNm: 61,
        magneticDeclinationDegEast: 3,
        facilityVariationDegEast: 7,
        facilityVariationSource: 'Synthetic chart',
        facilityVariationEffectiveDate: '2025-01-01',
      },
    ],
    metadata: [magneticMetadata()],
  });
  const capture = captureOutput();
  const operationEvents: CliTelemetryTypes['OperationEvent'][] = [];

  const exitCode = await runCli({
    args: [' aaaa ', 'bbbb'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
    async loadTelemetry() {
      return recordingOperationalTelemetry(operationEvents);
    },
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(0);
  expect(capture.output()).toEqual({
    stdout:
      'Route Points: AAAA → MID → BBBB\n' +
      'Total Distance: 120.1 NM\n' +
      'Route Legs: 2\n' +
      'Route Search Mode: VOR-family only\n' +
      '\n' +
      'Route Legs\n' +
      'Leg  From  To    Distance  Outbound True  Arrival True  Outbound Magnetic  Arrival Magnetic  Departure VOR Guidance  Arrival VOR Guidance\n' +
      '  1  AAAA  MID    60.0 NM           090°          090°               085°              087°  —                       Inbound 083°\n' +
      '  2  MID   BBBB   60.0 NM           090°          090°               087°              092°  Outbound 083°           —\n' +
      '\n' +
      'Navaids\n' +
      'Identifier  Type      Frequency  Published Range\n' +
      'MID         VOR-DME  113.70 MHz          61.0 NM\n',
    stderr: '',
  });
  expect(operationEvents).toEqual([
    {
      kind: 'route-plan-completed',
      arrivalIcao: 'BBBB',
      departureIcao: 'AAAA',
      routeDistanceNm: expect.closeTo(120.0809, 4),
      routeLegCount: 2,
      warningCodes: [],
    },
  ]);
});

test('summarizes degraded Route Plan warnings unless details are requested', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    navaids: [
      {
        databaseId: 'ndb',
        identifier: 'NDX',
        name: 'Fallback NDB',
        family: 'NDB',
        longitude: 1,
        latitude: 0,
        frequencyValue: 365.5,
        frequencyUnit: 'kHz',
        publishedRangeNm: 61,
      },
    ],
  });
  const summaryCapture = captureOutput();
  const detailedCapture = captureOutput();
  const summaryOperationEvents: CliTelemetryTypes['OperationEvent'][] = [];
  const detailedOperationEvents: CliTelemetryTypes['OperationEvent'][] = [];

  const summaryExitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: summaryCapture.io,
    async loadTelemetry() {
      return recordingOperationalTelemetry(summaryOperationEvents);
    },
    openApplication: openSyntheticApplication,
  });
  const detailedExitCode = await runCli({
    args: ['AAAA', 'BBBB', '--warnings'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: detailedCapture.io,
    async loadTelemetry() {
      return recordingOperationalTelemetry(detailedOperationEvents);
    },
    openApplication: openSyntheticApplication,
  });

  expect(summaryExitCode).toBe(0);
  expect(detailedExitCode).toBe(0);
  expect(summaryCapture.output()).toEqual({
    stdout:
      'Route Points: AAAA → NDX → BBBB\n' +
      'Total Distance: 120.1 NM\n' +
      'Route Legs: 2\n' +
      'Route Search Mode: NDB fallback\n' +
      '\n' +
      'Route Legs\n' +
      'Leg  From  To    Distance  Outbound True  Arrival True  Outbound Magnetic  Arrival Magnetic  Departure VOR Guidance  Arrival VOR Guidance\n' +
      '  1  AAAA  NDX    60.0 NM           090°          090°                  —                 —  —                       —\n' +
      '  2  NDX   BBBB   60.0 NM           090°          090°                  —                 —  —                       —\n' +
      '\n' +
      'Navaids\n' +
      'Identifier  Type  Frequency  Published Range\n' +
      'NDX         NDB   365.5 kHz          61.0 NM\n',
    stderr: 'Route completed with 5 warnings. Re-run with --warnings to view details.\n',
  });
  expect(detailedCapture.output()).toEqual({
    stdout: summaryCapture.output().stdout,
    stderr:
      'Warnings (5)\n' +
      '\n' +
      'NDB fallback\n' +
      '  The VOR-family search was exhausted. The route uses NDBs instead.\n' +
      '  Applies to the whole route.\n' +
      '\n' +
      'Magnetic course unavailable ×4\n' +
      '  Local Magnetic Declination is missing, so magnetic courses could not be calculated.\n' +
      '  Leg 1: AAAA departure, NDX arrival\n' +
      '  Leg 2: NDX departure, BBBB arrival\n',
  });
  const expectedOperationEvent = {
    kind: 'route-plan-completed',
    arrivalIcao: 'BBBB',
    departureIcao: 'AAAA',
    routeDistanceNm: expect.closeTo(120.0809, 4),
    routeLegCount: 2,
    warningCodes: [
      'ndb-fallback-used',
      'magnetic-course-unavailable',
      'magnetic-course-unavailable',
      'magnetic-course-unavailable',
      'magnetic-course-unavailable',
    ],
  };
  expect(summaryOperationEvents).toEqual([expectedOperationEvent]);
  expect(detailedOperationEvents).toEqual([expectedOperationEvent]);
});

test('writes no partial Route Plan for a missing airport failure and exits 1', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [syntheticAirport('arrival', 'BBBB', 2)],
  });
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Departure airport "AAAA" was not found in the local database.\n',
  });
});

test('writes no partial Route Plan when exhaustive search finds no route and exits 1', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
  });
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'No route found from AAAA to BBBB.\n',
  });
});

test('reports the failed query operation without writing a partial Route Plan and exits 1', async () => {
  const capture = captureOutput();
  const planner: ApplicationTypes['Planner'] = {
    async planRoute() {
      return {
        ok: false,
        failure: {code: 'database-query-failed', operation: 'find-ndb-fallback-route'},
      };
    },
    async [Symbol.asyncDispose]() {},
  };
  const application: ApplicationTypes['Application'] = {
    databasePath: ':synthetic:',
    planning: {
      async open() {
        return {ok: true, value: planner};
      },
    },
    dataManagement: {
      async status() {
        throw new Error('Data status is not used by this test.');
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used by this test.');
      },
      async reloadAirport() {
        throw new Error('Airport reload is not used by this test.');
      },
    },
    async [Symbol.asyncDispose]() {},
  };

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Unable to plan route: the NDB fallback route search query failed.\n',
  });
});

test('returns silent status 130 without loading the application after a pre-open interruption', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  let applicationLoaded = false;
  controller.abort();

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      applicationLoaded = true;
      throw new Error('The application must not open.');
    },
  });

  expect(exitCode).toBe(130);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  expect(applicationLoaded).toBe(false);
});

test('disposes an application opened after interruption without opening its planner', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const openingStarted = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<ApplicationTypes['ApplicationOpenResult']>();
  let plannerOpened = false;
  let applicationDisposeCount = 0;
  const application = syntheticRouteApplication({
    async openPlanner() {
      plannerOpened = true;
      throw new Error('The planner callback must be suppressed.');
    },
    onApplicationDispose() {
      applicationDisposeCount += 1;
    },
  });
  const running = runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      openingStarted.resolve();
      return opened.promise;
    },
  });

  await openingStarted.promise;
  controller.abort();
  opened.resolve({ok: true, value: application});

  await expect(running).resolves.toBe(130);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  expect(plannerOpened).toBe(false);
  expect(applicationDisposeCount).toBe(1);
});

test('propagates an unrelated AbortError and disposes the planner and application first', async () => {
  const capture = captureOutput();
  const abortError = new Error('unrelated abort');
  abortError.name = 'AbortError';
  const events: string[] = [];
  const application = syntheticRouteApplication({
    async planRoute() {
      throw abortError;
    },
    onPlannerDispose() {
      events.push('planner disposed');
    },
    onApplicationDispose() {
      events.push('application disposed');
    },
  });

  const running = runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await expect(running).rejects.toBe(abortError);
  expect(events).toEqual(['planner disposed', 'application disposed']);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('propagates application cleanup failure instead of interrupted status 130', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cleanupFailure = new Error('application cleanup failed');
  const application = syntheticRouteApplication({
    async planRoute(request) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    },
    onApplicationDispose() {
      throw cleanupFailure;
    },
  });
  const running = runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();

  await expect(running).rejects.toBe(cleanupFailure);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('propagates planner cleanup failure instead of interrupted status 130', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cleanupFailure = new Error('planner cleanup failed');
  const application = syntheticRouteApplication({
    async planRoute(request) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    },
    onPlannerDispose() {
      throw cleanupFailure;
    },
  });
  const running = runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });

  await started.promise;
  controller.abort();

  await expect(running).rejects.toBe(cleanupFailure);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
});

test('completes planner and application disposal before returning success', async () => {
  const capture = captureOutput();
  const events: string[] = [];
  const application = syntheticRouteApplication({
    async planRoute() {
      return {
        ok: true,
        value: {
          plan: {
            totalDistanceNm: 0,
            searchMode: 'vor-family',
            routePoints: [],
            routeLegs: [],
            magneticReference: null,
          },
          warnings: [],
        },
      };
    },
    onPlannerDispose() {
      events.push('planner disposed');
    },
    onApplicationDispose() {
      events.push('application disposed');
    },
  });

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  events.push('returned');

  expect(exitCode).toBe(0);
  expect(events).toEqual(['planner disposed', 'application disposed', 'returned']);
});

test('completes planner and application disposal before returning an expected failure', async () => {
  const capture = captureOutput();
  const events: string[] = [];
  const application = syntheticRouteApplication({
    async planRoute() {
      return {
        ok: false,
        failure: {
          code: 'no-route',
          departureIcao: 'AAAA',
          arrivalIcao: 'BBBB',
          maxRouteFactor: 1.5,
          completedSearchLimits: [],
        },
      };
    },
    onPlannerDispose() {
      events.push('planner disposed');
    },
    onApplicationDispose() {
      events.push('application disposed');
    },
  });

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: ':synthetic:'},
    io: capture.io,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  events.push('returned');

  expect(exitCode).toBe(1);
  expect(events).toEqual(['planner disposed', 'application disposed', 'returned']);
});

function syntheticRouteApplication({
  openPlanner,
  planRoute,
  onPlannerDispose = () => {},
  onApplicationDispose = () => {},
}: {
  openPlanner?: ApplicationTypes['PlanningCapability']['open'];
  planRoute?: ApplicationTypes['Planner']['planRoute'];
  onPlannerDispose?: () => void;
  onApplicationDispose?: () => void;
}): ApplicationTypes['Application'] {
  const planner: ApplicationTypes['Planner'] = {
    planRoute:
      planRoute ??
      (async () => {
        throw new Error('Route planning is not used by this test.');
      }),
    async [Symbol.asyncDispose]() {
      onPlannerDispose();
    },
  };

  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async status() {
        throw new Error('Data status is not used by this test.');
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used by this test.');
      },
      async reloadAirport() {
        throw new Error('Airport reload is not used by this test.');
      },
    },
    planning: {
      open: openPlanner ?? (async () => ({ok: true, value: planner})),
    },
    async [Symbol.asyncDispose]() {
      onApplicationDispose();
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

function syntheticAirportApplication(
  reloadAirport: ApplicationTypes['DataManagementCapability']['reloadAirport'],
  onApplicationDispose: () => void = () => {}
): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async status() {
        throw new Error('Data status is not used by this test.');
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used by this test.');
      },
      reloadAirport,
    },
    planning: {
      async open() {
        throw new Error('Route planning is not used by this test.');
      },
    },
    async [Symbol.asyncDispose]() {
      onApplicationDispose();
    },
  };
}

async function openSyntheticApplication(
  config: ApplicationTypes['ApplicationConfig']
): Promise<ApplicationTypes['ApplicationOpenResult']> {
  return {
    ok: true,
    value: {
      databasePath: config.databasePath,
      planning: {
        open: () => openRoutePlanner(config),
      },
      dataManagement: {
        async status() {
          throw new Error('Data status is not used by this test.');
        },
        async reloadNavaids() {
          throw new Error('Navaid reload is not used by this test.');
        },
        async reloadAirport() {
          throw new Error('Airport reload is not used by this test.');
        },
      },
      async [Symbol.asyncDispose]() {},
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

function syntheticAirport(
  databaseId: string,
  icao: string,
  longitude: number,
  magneticDeclinationDegEast: number | null = null
) {
  return {
    databaseId,
    icao,
    name: `${icao} Airport`,
    longitude,
    latitude: 0,
    magneticDeclinationDegEast,
  };
}

function magneticMetadata() {
  return {
    magneticModel: 'WMM',
    magneticModelVersion: 'WMM2025',
    magneticModelEpochYear: 2025,
    magneticReferenceDate: '2025-01-01',
    magneticModelSource: 'https://example.test/wmm2025',
  };
}
