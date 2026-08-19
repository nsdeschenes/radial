import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {createInterface} from 'node:readline';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import readDataStatus from '#radial/data-producer/internal/DataStatus.js';

const OLD_SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_PATH = join(process.cwd(), 'src/acceptance/walCrashRecoveryWorker.ts');

const CRASH_PHASES = [
  'before-mutation',
  'during-writes',
  'after-candidate-verification',
  'after-active-marker',
  'before-commit',
  'after-commit',
] as const;

test.each(CRASH_PHASES)(
  'recovers a valid old-or-new committed state after a hard kill %s',
  async phase => {
    const temporaryDirectory = await makeTemporaryDirectory();
    const databasePath = join(temporaryDirectory, 'radial.duckdb');

    try {
      await runWorker(['seed', databasePath]);
      const expectedSnapshotId =
        phase === 'after-commit' ? NEW_SNAPSHOT_ID : OLD_SNAPSHOT_ID;
      const killed = await runCrashWorker(databasePath, phase);

      if (phase === 'after-commit') {
        expect(killed.code).toBe(137);
        expect(killed.signal).toBeNull();
      } else {
        expect(killed.signal).toBe('SIGKILL');
      }

      if (phase !== 'after-commit') {
        expect(killed.stdout).toContain(`reached:${phase}\n`);
      }

      await expectOnlyDatabaseArtifacts(temporaryDirectory, databasePath);
      const status = await readDataStatus(databasePath);
      expect(status).toMatchObject({
        ok: true,
        value: {
          status: 'ready',
          snapshot: {snapshotId: expectedSnapshotId},
        },
      });
      await expectCommittedState(databasePath, expectedSnapshotId);
      await expectOnlyDatabaseArtifacts(temporaryDirectory, databasePath);
    } finally {
      await removeTemporaryDirectory(temporaryDirectory);
    }
  },
  30_000
);

async function makeTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'radial-wal-recovery-'));
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, {recursive: true});
}

async function runWorker(args: readonly string[]): Promise<void> {
  const result = await spawnWorker(args);
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
}

async function runCrashWorker(
  databasePath: string,
  phase: (typeof CRASH_PHASES)[number]
): Promise<WorkerResult> {
  const child = spawn('nub', [WORKER_PATH, 'crash', databasePath, phase], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectWorkerOutput(child);
  if (phase === 'after-commit') {
    void output.reached.catch(() => {});
    return output.result;
  }

  await output.reached;
  child.kill('SIGKILL');
  return output.result;
}

type WorkerResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

function spawnWorker(args: readonly string[]) {
  const child = spawn('nub', [WORKER_PATH, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectWorkerOutput(child).result;
}

function collectWorkerOutput(child: ReturnType<typeof spawn>): {
  reached: Promise<void>;
  result: Promise<WorkerResult>;
} {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('Expected piped worker output.');
  }

  let stdout = '';
  let stderr = '';
  let reachedResolve: (() => void) | undefined;
  let reachedReject: ((error: Error) => void) | undefined;
  const reached = new Promise<void>((resolve, reject) => {
    reachedResolve = resolve;
    reachedReject = reject;
  });
  const stdoutLines = createInterface({input: child.stdout});
  stdoutLines.on('line', line => {
    stdout += `${line}\n`;
    if (line.startsWith('reached:')) {
      reachedResolve?.();
    }
  });
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.once('error', error => {
      reachedReject?.(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      stdoutLines.close();
      if (code !== 0 && signal === null) {
        reachedReject?.(new Error(`Worker failed: ${stderr}`));
      }

      resolve({code, signal, stdout, stderr});
    });
  });
  return {reached, result};
}

async function expectCommittedState(
  databasePath: string,
  expectedSnapshotId: string
): Promise<void> {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const state = await connection.runAndReadAll(`
      SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS snapshot_id
      FROM radial_producer.producer_state
    `);
    const snapshots = await connection.runAndReadAll(`
      SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id
      FROM radial_producer.navaid_snapshots ORDER BY snapshot_id
    `);
    const orphaned = await connection.runAndReadAll(`
      SELECT count(*) AS orphan_count FROM (
        SELECT snapshot_id FROM radial_producer.raw_navaids
        UNION ALL SELECT snapshot_id FROM radial_producer.planner_navaids
        UNION ALL SELECT snapshot_id FROM radial_producer.navaid_exclusions
        UNION ALL SELECT snapshot_id FROM radial_producer.facility_variation_audits
        UNION ALL SELECT snapshot_id FROM radial_producer.planner_airports
      ) AS children
      ANTI JOIN radial_producer.navaid_snapshots AS snapshots USING (snapshot_id)
    `);
    const visible = await connection.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM planner_navaids) AS planner_navaid_count,
        (SELECT count(*) FROM planner_metadata) AS metadata_count,
        (SELECT count(*) FROM planner_airports) AS airport_count
    `);

    expect(state.getRowObjectsJS()).toEqual([{snapshot_id: expectedSnapshotId}]);
    expect(snapshots.getRowObjectsJS()).toEqual([{snapshot_id: expectedSnapshotId}]);
    expect(orphaned.getRowObjectsJS()).toEqual([{orphan_count: 0n}]);
    expect(visible.getRowObjectsJS()).toEqual([
      {planner_navaid_count: 1n, metadata_count: 1n, airport_count: 1n},
    ]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function expectOnlyDatabaseArtifacts(
  temporaryDirectory: string,
  databasePath: string
): Promise<void> {
  const entries = await readdir(temporaryDirectory);
  const databaseName = basename(databasePath);
  expect(entries.toSorted()).toEqual(expect.arrayContaining([databaseName]));
  expect(
    entries.filter(entry => entry !== databaseName && entry !== `${databaseName}.wal`)
  ).toEqual([]);
}
