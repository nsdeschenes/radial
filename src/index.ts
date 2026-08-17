import runCli from '#radial/cli/main.js';

process.exitCode = await runCli({
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
});
