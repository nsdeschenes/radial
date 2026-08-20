import cliInterruption from '#radial/cli/runtime/CliInterruption.js';

type SignalBridge = Readonly<{
  signal: AbortSignal;
  dispose(): void;
}>;

function createCliSignalBridge(): SignalBridge {
  const controller = new AbortController();
  let listening = true;
  const removeListeners = () => {
    if (!listening) {
      return;
    }

    listening = false;
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  };

  const onInterrupt = (signal: NodeJS.Signals) => {
    removeListeners();
    controller.abort(cliInterruption.create(signal));
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  return {
    signal: controller.signal,
    dispose: removeListeners,
  };
}

export default createCliSignalBridge;
