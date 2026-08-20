import runCli from '#radial/cli/runCli.js';
import createCliSignalBridge from '#radial/cli/runtime/createCliSignalBridge.js';

const args = process.argv.slice(2);
const signalBridge = createCliSignalBridge();

try {
  process.exitCode = await runCli({
    args,
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
