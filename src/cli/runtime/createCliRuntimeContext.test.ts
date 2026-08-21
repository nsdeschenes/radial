import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import createCliRuntimeContext from '#radial/cli/runtime/createCliRuntimeContext.js';

function syntheticApplication(
  onDispose: () => void = () => {}
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

test('exposes an immutable environment snapshot and capability-only context', async () => {
  const env: Record<string, string | undefined> = {RADIAL_DATABASE_PATH: 'before'};
  const controller = new AbortController();
  const io = {
    writeStdout() {},
    writeStderr() {},
  };
  const scope = createCliRuntimeContext({
    env,
    io,
    signal: controller.signal,
    async loadApplication() {
      throw new Error('The application must remain lazy.');
    },
  });

  env['RADIAL_DATABASE_PATH'] = 'after';
  expect(scope.context.env['RADIAL_DATABASE_PATH']).toBe('before');
  expect(scope.context.io).toBe(io);
  expect(scope.context.signal).toBe(controller.signal);
  expect(Object.isFrozen(scope.context)).toBe(true);
  expect(Object.isFrozen(scope.context.env)).toBe(true);
  expect(Object.keys(scope.context).sort()).toEqual([
    'env',
    'io',
    'signal',
    'withApplication',
  ]);

  await scope[Symbol.asyncDispose]();
});

test('opens lazily once, reuses one configuration, and disposes after every callback settles', async () => {
  const opened = Promise.withResolvers<ApplicationTypes['ApplicationOpenResult']>();
  let loadCount = 0;
  let disposeCount = 0;
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: new AbortController().signal,
    async loadApplication() {
      loadCount += 1;
      return async () => opened.promise;
    },
  });
  const config = {databasePath: ':synthetic:', maxRouteFactor: 1.5};
  const first = scope.context.withApplication(config, async () => 'first');
  const second = scope.context.withApplication(
    {databasePath: ':synthetic:', maxRouteFactor: 1.5},
    async () => 'second'
  );

  expect(loadCount).toBe(1);
  opened.resolve({ok: true, value: syntheticApplication(() => (disposeCount += 1))});

  await expect(first).resolves.toEqual({ok: true, value: 'first'});
  await expect(second).resolves.toEqual({ok: true, value: 'second'});
  expect(disposeCount).toBe(0);

  await scope[Symbol.asyncDispose]();
  await scope[Symbol.asyncDispose]();
  expect(disposeCount).toBe(1);
});

test('rejects a competing application configuration', async () => {
  const application = syntheticApplication();
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: new AbortController().signal,
    async loadApplication() {
      return async () => ({ok: true, value: application});
    },
  });

  await scope.context.withApplication({databasePath: 'first'}, async () => undefined);

  await expect(
    scope.context.withApplication({databasePath: 'second'}, async () => undefined)
  ).rejects.toThrow(
    'Cannot open a competing Radial application configuration in one CLI invocation.'
  );
  await scope[Symbol.asyncDispose]();
});

test('pre-open interruption prevents application loading', async () => {
  const controller = new AbortController();
  controller.abort();
  let loaded = false;
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: controller.signal,
    async loadApplication() {
      loaded = true;
      throw new Error('The application must not load.');
    },
  });

  await expect(
    scope.context.withApplication({databasePath: ':synthetic:'}, async () => undefined)
  ).rejects.toMatchObject({name: 'CliInterruptionError'});
  expect(loaded).toBe(false);
  await scope[Symbol.asyncDispose]();
});

test('interruption while loading the opener still prevents application opening', async () => {
  const controller = new AbortController();
  const loaded = Promise.withResolvers<CliRuntimeTypes['ApplicationOpener']>();
  let opened = false;
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: controller.signal,
    async loadApplication() {
      return loaded.promise;
    },
  });
  const result = scope.context.withApplication(
    {databasePath: ':synthetic:'},
    async () => undefined
  );

  controller.abort();
  loaded.resolve(async () => {
    opened = true;
    return {ok: true, value: syntheticApplication()};
  });

  await expect(result).rejects.toMatchObject({name: 'CliInterruptionError'});
  expect(opened).toBe(false);
  await scope[Symbol.asyncDispose]();
});

test('interruption during opening suppresses the callback and disposes the opened application', async () => {
  const controller = new AbortController();
  const openingStarted = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<ApplicationTypes['ApplicationOpenResult']>();
  let callbackCalled = false;
  let disposeCount = 0;
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: controller.signal,
    async loadApplication() {
      return async () => {
        openingStarted.resolve();
        return opened.promise;
      };
    },
  });
  const result = scope.context.withApplication(
    {databasePath: ':synthetic:'},
    async () => {
      callbackCalled = true;
    }
  );

  await openingStarted.promise;
  controller.abort();
  opened.resolve({ok: true, value: syntheticApplication(() => (disposeCount += 1))});

  await expect(result).rejects.toMatchObject({name: 'CliInterruptionError'});
  expect(callbackCalled).toBe(false);
  expect(disposeCount).toBe(1);
  await scope[Symbol.asyncDispose]();
  expect(disposeCount).toBe(1);
});

test('propagates application disposal failure unchanged after interruption', async () => {
  const controller = new AbortController();
  const openingStarted = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<ApplicationTypes['ApplicationOpenResult']>();
  const disposalFailure = new Error('application cleanup failed');
  const application = syntheticApplication(() => {
    throw disposalFailure;
  });
  const scope = createCliRuntimeContext({
    env: {},
    io: {writeStdout() {}, writeStderr() {}},
    signal: controller.signal,
    async loadApplication() {
      return async () => {
        openingStarted.resolve();
        return opened.promise;
      };
    },
  });
  const result = scope.context.withApplication(
    {databasePath: ':synthetic:'},
    async () => undefined
  );

  await openingStarted.promise;
  controller.abort();
  opened.resolve({ok: true, value: application});

  await expect(result).rejects.toBe(disposalFailure);
  await expect(scope[Symbol.asyncDispose]()).rejects.toBe(disposalFailure);
});
