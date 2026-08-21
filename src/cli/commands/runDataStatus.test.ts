import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import runDataStatus from '#radial/cli/commands/runDataStatus.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';

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

test('reports a missing database without creating it through the admitted entry', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-handler-'));
  const databasePath = join(temporaryDirectory, 'missing.duckdb');
  const capture = captureOutput();
  const admittedMetadata: CliTelemetryTypes['CommandMetadata'][] = [];
  const operationEvents: CliTelemetryTypes['OperationEvent'][] = [];

  try {
    await expect(
      runDataStatus(
        {
          env: {RADIAL_DATABASE_PATH: databasePath},
          io: capture.io,
          async loadTelemetry() {
            return recordingTelemetry(operationEvents, admittedMetadata);
          },
        },
        {}
      )
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
    expect(operationEvents).toEqual([
      {
        kind: 'data-status-completed',
        cachedAirportCount: 0,
        snapshotPresent: false,
        status: 'uninitialized',
      },
    ]);
    expect(admittedMetadata).toEqual([{id: 'data-status'}]);
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports initialized local data through the admitted entry', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-status-command-'));
  const databasePath = join(temporaryDirectory, 'initialized.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  try {
    await initializeProducerSchema(instance);
  } finally {
    instance.closeSync();
  }

  const capture = captureOutput();
  const operationEvents: CliTelemetryTypes['OperationEvent'][] = [];
  try {
    await expect(
      runDataStatus(
        {
          env: {RADIAL_DATABASE_PATH: databasePath},
          io: capture.io,
          async loadTelemetry() {
            return recordingTelemetry(operationEvents);
          },
        },
        {}
      )
    ).resolves.toBe(0);
    expect(capture.output().stdout).toContain(
      `  Path: ${databasePath}\n` +
        '  State: uninitialized\n' +
        '  Producer Schema version: 1/1/1\n'
    );
    expect(capture.output().stderr).toBe('');
    expect(operationEvents).toEqual([
      {
        kind: 'data-status-completed',
        cachedAirportCount: 0,
        snapshotPresent: false,
        status: 'uninitialized',
      },
    ]);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('returns an expected failure and writes its diagnostic to stderr', async () => {
  const capture = captureOutput();
  const operationEvents: CliTelemetryTypes['OperationEvent'][] = [];
  await expect(
    runDataStatus(
      {
        env: {},
        io: capture.io,
        async loadTelemetry() {
          return recordingTelemetry(operationEvents);
        },
      },
      {}
    )
  ).resolves.toBe(1);
  expect(capture.output()).toEqual({
    stdout: '',
    stderr:
      'error [DATA_DATABASE_PATH_MISSING]: Database path is missing.\n' +
      'Cause: RADIAL_DATABASE_PATH is required for data status.\n' +
      'Action: Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.\n' +
      'Active data remains unchanged.\n',
  });
  expect(operationEvents).toEqual([
    {
      kind: 'data-status-failed',
      activeDataPreserved: true,
      failureCode: 'DATA_DATABASE_PATH_MISSING',
    },
  ]);
});

test('returns a silent recognized interruption before reading status', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  controller.abort(new Error('Data status interrupted.'));
  const operationEvents: CliTelemetryTypes['OperationEvent'][] = [];

  await expect(
    runDataStatus(
      {
        env: {RADIAL_DATABASE_PATH: ':memory:'},
        io: capture.io,
        async loadTelemetry() {
          return recordingTelemetry(operationEvents);
        },
        signal: controller.signal,
      },
      {}
    )
  ).resolves.toBe(130);
  expect(capture.output()).toEqual({stdout: '', stderr: ''});
  expect(operationEvents).toEqual([]);
});

function recordingTelemetry(
  operationEvents: CliTelemetryTypes['OperationEvent'][],
  admittedMetadata: CliTelemetryTypes['CommandMetadata'][] = []
): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      admittedMetadata.push(metadata);
      return operation();
    },
    recordOperation(event) {
      operationEvents.push(event);
    },
    async close() {},
  };
}
