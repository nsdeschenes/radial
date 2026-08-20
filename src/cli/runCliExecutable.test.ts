import {spawn} from 'node:child_process';
import {join} from 'node:path';

import {expect, test} from 'vitest';

const WORKER_PATH = join(process.cwd(), 'src/test/cli/runCliExecutableWorker.ts');

test('assigns the Public CLI result as the final process exit code', async () => {
  const result = await runWorker('exit-2');

  expect(result).toEqual({code: 2, signal: null, stderr: '', stdout: ''});
});

test('runs the real Public CLI composition for a cold root-help invocation', async () => {
  const result = await runExecutable(['--help']);

  expect(result).toEqual({
    code: 0,
    signal: null,
    stderr: '',
    stdout:
      'Usage:\n' +
      '  radial <departure-icao> <arrival-icao> [--warnings]\n' +
      '  radial data status\n' +
      '  radial data reload navaids\n' +
      '  radial data reload airport <ICAO>\n',
  });
});

test('propagates an unexpected Public CLI exception after removing listeners', async () => {
  const result = await runWorker('throw');

  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe('listeners:0:0\n');
  expect(result.stderr).toContain('Error: synthetic executable defect');
});

test.each(['SIGINT', 'SIGTERM'] as const)(
  'bridges the first %s into a silent status 130',
  async signal => {
    const running = startWorker('interrupt');
    await running.waitForStdout('ready\n');
    running.child.kill(signal);

    await expect(running.result).resolves.toEqual({
      code: 130,
      signal: null,
      stderr: '',
      stdout: 'ready\n',
    });
  }
);

test('removes both listeners after the first signal and restores default second-signal behavior', async () => {
  const running = startWorker('second-signal');
  await running.waitForStdout('ready\n');
  running.child.kill('SIGINT');
  await running.waitForStdout('listeners:0:0\n');
  running.child.kill('SIGTERM');

  await expect(running.result).resolves.toEqual({
    code: 143,
    signal: null,
    stderr: '',
    stdout: 'ready\nlisteners:0:0\n',
  });
});

test('preserves committed success after a late interruption', async () => {
  const running = startWorker('late-success');
  await running.waitForStdout('ready\n');
  running.child.kill('SIGINT');

  await expect(running.result).resolves.toEqual({
    code: 0,
    signal: null,
    stderr: '',
    stdout: 'ready\ncommitted\n',
  });
});

type WorkerResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}>;

function runWorker(scenario: string): Promise<WorkerResult> {
  return startWorker(scenario).result;
}

function runExecutable(args: readonly string[]): Promise<WorkerResult> {
  const child = spawn('nub', ['src/radial.ts', ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return collectWorkerResult(child);
}

function startWorker(scenario: string) {
  const child = spawn('nub', [WORKER_PATH, scenario], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputWaiters = new Map<string, () => void>();
  let stdout = '';

  if (child.stdout === null) {
    throw new Error('Expected piped worker stdout.');
  }

  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    for (const [expected, resolve] of outputWaiters) {
      if (stdout.includes(expected)) {
        outputWaiters.delete(expected);
        resolve();
      }
    }
  });

  return {
    child,
    result: collectWorkerResult(child),
    waitForStdout(expected: string) {
      if (stdout.includes(expected)) {
        return Promise.resolve();
      }

      return new Promise<void>(resolve => outputWaiters.set(expected, resolve));
    },
  };
}

function collectWorkerResult(child: ReturnType<typeof spawn>): Promise<WorkerResult> {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('Expected piped worker output.');
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += String(chunk)));
  child.stderr.on('data', chunk => (stderr += String(chunk)));

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stderr, stdout}));
  });
}
