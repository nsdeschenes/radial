import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import runCli from '#radial/cli/main.js';

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

test('delegates a valid request to the planner and reports query failures on stderr', async () => {
  const capture = captureOutput();

  const exitCode = await runCli({
    args: ['cyyz', ' CYOW '],
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
  });

  expect(exitCode).toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr: 'Unable to plan route: the airport lookup query failed.\n',
  });
});
