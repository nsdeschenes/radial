import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/main.js';
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
      'Usage: radial <departure-icao> <arrival-icao>\n' +
      'Example: radial CYYZ CYOW\n',
  });
});

test('provides data status help and rejects unsupported options', async () => {
  const helpCapture = captureOutput();
  const usageCapture = captureOutput();

  await expect(
    runCli({args: ['data', 'status', '--help'], env: {}, io: helpCapture.io})
  ).resolves.toBe(0);
  await expect(
    runCli({args: ['data', 'status', '--force'], env: {}, io: usageCapture.io})
  ).resolves.toBe(2);

  expect(helpCapture.output()).toEqual({
    stdout: 'Usage: radial data status\n',
    stderr: '',
  });
  expect(usageCapture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_USAGE]: Invalid data command.\n' +
      'Cause: The data status command accepts no arguments or operational flags.\n' +
      'Action: Run "radial data status".\n',
  });
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
  const application = syntheticApplication(async request => {
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
  await Promise.resolve();
  await Promise.resolve();

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
        request.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('The reload was interrupted.');
            error.name = 'AbortError';
            reject(error);
          },
          {once: true}
        );
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
  const application = syntheticApplication(async () => reload.promise);

  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: {RADIAL_DATABASE_PATH: ':memory:', OPENAIP_API_KEY: 'secret-api-key'},
    io: capture.io,
    signal: controller.signal,
    async openApplication() {
      return {ok: true, value: application};
    },
  });
  await Promise.resolve();
  controller.abort();
  await Promise.resolve();

  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  reload.resolve({ok: true, value: syntheticNavaidReloadSuccess()});
  await expect(running).resolves.toBe(0);
  expect(capture.output().stdout).toContain('Navaid Snapshot replaced\n');
});

test('streams Airport reload progress and writes success only after commit', async () => {
  const capture = captureOutput();
  const reload = Promise.withResolvers<ApplicationTypes['AirportReloadResult']>();
  const application = syntheticAirportApplication(async request => {
    expect(request.icao).toBe('CAAA');
    request.onProgress?.({stage: 'openaip', message: 'Looking up Airport CAAA.'});
    request.onProgress?.({stage: 'publish', message: 'Publishing Cached Airport.'});
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
  await Promise.resolve();
  await Promise.resolve();

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

test('reports an incorrect positional argument count on stderr and exits 2', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({args: ['CYYZ'], env: {}, io: capture.io});

  expect(exitCode).toBe(2);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'Expected exactly two ICAO airport codes; received 1.\n' +
      'Usage: radial <departure-icao> <arrival-icao>\n' +
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
      'Usage: radial <departure-icao> <arrival-icao>\n' +
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

  const exitCode = await runCli({
    args: [' aaaa ', 'bbbb'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
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
});

test('writes a degraded NDB Route Plan to stdout, ordered warnings to stderr, and exits 0', async () => {
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
        frequencyValue: 365,
        frequencyUnit: 'kHz',
        publishedRangeNm: 61,
      },
    ],
  });
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(0);
  expect(capture.output()).toEqual({
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
      'NDX         NDB     365 kHz          61.0 NM\n',
    stderr:
      'Warning: NDB fallback was used after the VOR-family search was exhausted.\n' +
      'Warning: Route Leg 1 departure magnetic course is unavailable at AAAA because Local Magnetic Declination is unavailable.\n' +
      'Warning: Route Leg 1 arrival magnetic course is unavailable at NDX because Local Magnetic Declination is unavailable.\n' +
      'Warning: Route Leg 2 departure magnetic course is unavailable at NDX because Local Magnetic Declination is unavailable.\n' +
      'Warning: Route Leg 2 arrival magnetic course is unavailable at BBBB because Local Magnetic Declination is unavailable.\n',
  });
});

test.each([
  {
    name: 'missing airport lookup',
    airports: [syntheticAirport('arrival', 'BBBB', 2)],
    stderr: 'Departure airport "AAAA" was not found in the local database.\n',
  },
  {
    name: 'ambiguous airport lookup',
    airports: [
      syntheticAirport('departure-1', 'AAAA', 0),
      syntheticAirport('departure-2', ' aaaa ', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    stderr:
      'Departure airport "AAAA" matched multiple usable records in the local database.\n',
  },
])('writes no partial Route Plan for a $name failure and exits 1', async scenario => {
  await using database = await syntheticPlannerDatabase.create({
    airports: scenario.airports,
  });
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['AAAA', 'BBBB'],
    env: {RADIAL_DATABASE_PATH: database.databasePath},
    io: capture.io,
    openApplication: openSyntheticApplication,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({stdout: '', stderr: scenario.stderr});
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

function syntheticApplication(
  reloadNavaids: ApplicationTypes['DataManagementCapability']['reloadNavaids']
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
    async [Symbol.asyncDispose]() {},
  };
}

function syntheticAirportApplication(
  reloadAirport: ApplicationTypes['DataManagementCapability']['reloadAirport']
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
    async [Symbol.asyncDispose]() {},
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
