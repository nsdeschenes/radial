import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/main.js';
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
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Unable to initialize Route Planner: the database contract is invalid.\n',
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
    dataManagement: {},
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
