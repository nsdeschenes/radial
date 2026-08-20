import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import runDataStatus from '#radial/cli/commands/runDataStatus.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';

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

test('reports a missing database without creating it through the handler', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-handler-'));
  const databasePath = join(temporaryDirectory, 'missing.duckdb');
  const capture = captureOutput();
  const runtime = createCliRuntimeContext({
    env: {RADIAL_DATABASE_PATH: databasePath},
    io: capture.io,
    signal: new AbortController().signal,
  });

  try {
    await expect(runDataStatus({}, runtime.context)).resolves.toMatchObject({
      kind: 'success',
      status: 0,
      success: {databasePath, status: 'uninitialized'},
    });
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
    await runtime[Symbol.asyncDispose]();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('returns an expected failure and writes its diagnostic to stderr', async () => {
  const capture = captureOutput();
  const runtime = createCliRuntimeContext({
    env: {},
    io: capture.io,
    signal: new AbortController().signal,
  });

  try {
    await expect(runDataStatus({}, runtime.context)).resolves.toMatchObject({
      kind: 'expected-failure',
      status: 1,
      failure: {code: 'DATA_DATABASE_PATH_MISSING'},
    });
    expect(capture.output()).toEqual({
      stdout: '',
      stderr:
        'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
        'Cause: RADIAL_DATABASE_PATH is required for data status.\n' +
        'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
        'Active data remains unchanged.\n',
    });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test('returns a silent recognized interruption before reading status', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  controller.abort(new Error('Data status interrupted.'));
  const runtime = createCliRuntimeContext({
    env: {RADIAL_DATABASE_PATH: ':memory:'},
    io: capture.io,
    signal: controller.signal,
  });

  try {
    await expect(runDataStatus({}, runtime.context)).resolves.toEqual({
      kind: 'interrupted',
      status: 130,
    });
    expect(capture.output()).toEqual({stdout: '', stderr: ''});
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});
