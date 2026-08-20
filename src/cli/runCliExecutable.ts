import type CliInputTypes from '#radial/cli/CliInput.js';
import runCli from '#radial/cli/runCli.js';
import createCliSignalBridge from '#radial/cli/runtime/createCliSignalBridge.js';

type ExecuteCli = (input: CliInputTypes['Input']) => Promise<number>;

async function runCliExecutable(executeCli: ExecuteCli = runCli): Promise<void> {
  const signalBridge = createCliSignalBridge();

  try {
    process.exitCode = await executeCli({
      args: process.argv.slice(2),
      env: process.env,
      io: {
        writeStdout(text) {
          process.stdout.write(text);
        },
        writeStderr(text) {
          process.stderr.write(text);
        },
      },
      signal: signalBridge.signal,
    });
  } finally {
    signalBridge.dispose();
  }
}

export default runCliExecutable;
