import runRoutePlannerBenchmark from '#radial/acceptance/routePlannerBenchmark.js';

const [baselinePath, snapshotPath, ...extraArguments] = process.argv.slice(2);
const machineId = process.env['RADIAL_BENCHMARK_MACHINE_ID'];

if (
  baselinePath === undefined ||
  snapshotPath === undefined ||
  extraArguments.length > 0 ||
  machineId === undefined ||
  machineId.trim() === ''
) {
  process.stderr.write(
    'Usage: RADIAL_BENCHMARK_MACHINE_ID=<id> nub run acceptance:benchmark -- <baseline.json> <planner.duckdb>\n'
  );
  process.exitCode = 2;
} else {
  try {
    const report = await runRoutePlannerBenchmark({
      baselinePath,
      snapshotPath,
      machineId,
    });
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    if (report.medianGatePassed === false) {
      process.stderr.write(
        `Representative-machine median ${report.medianMs.toFixed(3)} ms did not satisfy the under-${report.medianGateMs} ms gate.\n`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
