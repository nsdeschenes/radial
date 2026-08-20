import {expect, test} from 'vitest';

import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import createCliSignalBridge from '#radial/cli/runtime/createCliSignalBridge.js';

test('removes both operating-system listeners immediately after the first signal', () => {
  const sigintListenersBefore = process.listeners('SIGINT');
  const sigtermListenersBefore = process.listeners('SIGTERM');
  const bridge = createCliSignalBridge();

  try {
    const installedSigintListeners = process
      .listeners('SIGINT')
      .filter(listener => !sigintListenersBefore.includes(listener));
    expect(installedSigintListeners).toHaveLength(1);
    expect(process.listeners('SIGTERM')).toHaveLength(sigtermListenersBefore.length + 1);

    installedSigintListeners[0]?.('SIGINT');

    expect(process.listeners('SIGINT')).toEqual(sigintListenersBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermListenersBefore);
    expect(bridge.signal.aborted).toBe(true);
    expect(cliInterruption.is(bridge.signal.reason)).toBe(true);
  } finally {
    bridge.dispose();
  }
});

test('removes every remaining listener when a cold invocation completes', () => {
  const sigintListenersBefore = process.listeners('SIGINT');
  const sigtermListenersBefore = process.listeners('SIGTERM');
  const bridge = createCliSignalBridge();

  bridge.dispose();

  expect(process.listeners('SIGINT')).toEqual(sigintListenersBefore);
  expect(process.listeners('SIGTERM')).toEqual(sigtermListenersBefore);
  expect(bridge.signal.aborted).toBe(false);
});
