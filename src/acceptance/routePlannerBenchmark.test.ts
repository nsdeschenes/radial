import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {arch, cpus, platform, tmpdir, totalmem} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import runRoutePlannerBenchmark from '#radial/acceptance/routePlannerBenchmark.js';
import createRoutePlannerAcceptanceBaseline from '#radial/test/acceptance/createRoutePlannerAcceptanceBaseline.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test('warms one open planner and records five fresh-session planning calls', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0),
      syntheticAirport('arrival', 'BBBB', 2),
    ],
    navaids: [
      {
        databaseId: 'vor',
        identifier: 'MID',
        name: 'Middle VOR',
        family: 'VOR',
        longitude: 1,
        latitude: 0,
        frequencyValue: 113.7,
        frequencyUnit: 'MHz',
        publishedRangeNm: 61,
      },
    ],
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-benchmark-'));
  const baselinePath = join(temporaryDirectory, 'baseline.json');
  const snapshotSha256 = createHash('sha256')
    .update(await readFile(database.databasePath))
    .digest('hex');
  const cpuList = cpus();

  try {
    await writeFile(
      baselinePath,
      JSON.stringify(
        createRoutePlannerAcceptanceBaseline({
          snapshotSha256,
          machine: {
            platform: platform(),
            architecture: arch(),
            cpuModel: cpuList[0]?.model ?? 'unknown',
            logicalCpuCount: cpuList.length,
            totalMemoryBytes: totalmem(),
          },
        })
      )
    );

    const report = await runRoutePlannerBenchmark({
      baselinePath,
      snapshotPath: database.databasePath,
      machineId: 'acceptance-test',
    });

    expect(report.snapshotSha256).toBe(snapshotSha256);
    expect(report.warmupMs).toBeGreaterThanOrEqual(0);
    expect(report.samplesMs).toHaveLength(5);
    expect(report.medianMs).toBe(
      report.samplesMs.toSorted((left, right) => left - right)[2]
    );
    expect(report.worstMs).toBe(Math.max(...report.samplesMs));
    expect(report.representativeMachine).toBe(true);
    expect(report.medianGatePassed).toBe(true);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

function syntheticAirport(databaseId: string, icao: string, longitude: number) {
  return {
    databaseId,
    icao,
    name: `${icao} Airport`,
    longitude,
    latitude: 0,
  };
}
