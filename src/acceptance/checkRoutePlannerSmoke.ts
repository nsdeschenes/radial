import runRoutePlannerSmoke from '#radial/acceptance/routePlannerSmoke.js';

const [baselinePath, snapshotPath, ...extraArguments] = process.argv.slice(2);

if (
  baselinePath === undefined ||
  snapshotPath === undefined ||
  extraArguments.length > 0
) {
  process.stderr.write(
    'Usage: nub run acceptance:smoke -- <baseline.json> <planner.duckdb>\n'
  );
  process.exitCode = 2;
} else {
  try {
    const report = await runRoutePlannerSmoke({baselinePath, snapshotPath});
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
