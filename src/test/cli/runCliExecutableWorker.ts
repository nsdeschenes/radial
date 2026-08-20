import runCliExecutable from '#radial/cli/runCliExecutable.js';

const scenario = process.argv[2];

if (scenario === 'exit-2') {
  await runCliExecutable(async () => 2);
} else if (scenario === 'throw') {
  try {
    await runCliExecutable(async () => {
      throw new Error('synthetic executable defect');
    });
  } catch (error) {
    writeListenerCounts();
    throw error;
  }
} else if (scenario === 'interrupt') {
  await runCliExecutable(async input => {
    process.stdout.write('ready\n');
    await waitForAbort(requiredSignal(input.signal));
    return 130;
  });
} else if (scenario === 'second-signal') {
  await runCliExecutable(async input => {
    setInterval(() => {}, 1_000);
    process.stdout.write('ready\n');
    await waitForAbort(requiredSignal(input.signal));
    writeListenerCounts();
    await new Promise<void>(() => {});
    return 130;
  });
} else if (scenario === 'late-success') {
  await runCliExecutable(async input => {
    process.stdout.write('ready\n');
    await waitForAbort(requiredSignal(input.signal));
    process.stdout.write('committed\n');
    return 0;
  });
} else {
  throw new Error(`Unknown executable test scenario ${JSON.stringify(scenario)}.`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  const keepAlive = setInterval(() => {}, 1_000);
  return new Promise(resolve =>
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(keepAlive);
        resolve();
      },
      {once: true}
    )
  );
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) {
    throw new Error('The executable bootstrap must provide a cancellation signal.');
  }

  return signal;
}

function writeListenerCounts(): void {
  process.stdout.write(
    `listeners:${process.listenerCount('SIGINT')}:${process.listenerCount('SIGTERM')}\n`
  );
}
