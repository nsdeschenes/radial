import type {StricliProcess} from '@stricli/core';
import {afterEach, expect, test, vi} from 'vitest';

type FrameworkContext = Readonly<{process: StricliProcess}>;

afterEach(() => {
  vi.doUnmock('@stricli/core');
  vi.resetModules();
});

test('fails when Stricli rejects an invocation without a compatibility diagnostic', async () => {
  await mockFrameworkExitCode(-4);
  const {default: runCli} = await import('#radial/cli/runCli.js');

  await expect(
    runCli({
      args: ['data', 'status'],
      env: {},
      io: {writeStderr() {}, writeStdout() {}},
    })
  ).rejects.toThrow(
    'Stricli rejected an invocation that has no Radial compatibility diagnostic: ["data","status"].'
  );
});

test('fails when Stricli returns an unexpected framework status', async () => {
  await mockFrameworkExitCode(17);
  const {default: runCli} = await import('#radial/cli/runCli.js');

  await expect(
    runCli({
      args: ['--help'],
      env: {},
      io: {writeStderr() {}, writeStdout() {}},
    })
  ).rejects.toThrow('Unexpected Stricli framework exit code 17.');
});

async function mockFrameworkExitCode(exitCode: number): Promise<void> {
  vi.resetModules();
  vi.doMock('@stricli/core', async importOriginal => {
    const actual = await importOriginal<typeof import('@stricli/core')>();
    return {
      ...actual,
      async run(
        _application: unknown,
        _args: readonly string[],
        context: FrameworkContext
      ) {
        context.process.exitCode = exitCode;
      },
    };
  });
}
