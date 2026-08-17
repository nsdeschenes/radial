import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import runRoutePlannerSmoke from '#radial/acceptance/routePlannerSmoke.js';
import createRoutePlannerAcceptanceBaseline from '#radial/test/acceptance/createRoutePlannerAcceptanceBaseline.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test('refuses a snapshot checksum mismatch before opening the planner', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-smoke-'));
  const snapshotPath = join(temporaryDirectory, 'planner.duckdb');
  const baselinePath = join(temporaryDirectory, 'baseline.json');

  try {
    await writeFile(snapshotPath, 'wrong snapshot');
    await writeFile(
      baselinePath,
      JSON.stringify(
        createRoutePlannerAcceptanceBaseline({snapshotSha256: '0'.repeat(64)})
      )
    );

    await expect(runRoutePlannerSmoke({baselinePath, snapshotPath})).rejects.toThrow(
      `Snapshot checksum mismatch: expected ${'0'.repeat(64)}, received`
    );
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('verifies the pinned Route Plan and byte-identical CLI output', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      syntheticAirport('departure', 'AAAA', 0, 5),
      syntheticAirport('arrival', 'BBBB', 2, -2),
    ],
    navaids: [
      {
        databaseId: 'vor',
        identifier: 'MID',
        name: 'Middle VOR/DME',
        family: 'VOR-DME',
        longitude: 1,
        latitude: 0,
        frequencyValue: 113.7,
        frequencyUnit: 'MHz',
        publishedRangeNm: 61,
        magneticDeclinationDegEast: 3,
        facilityVariationDegEast: 7,
        facilityVariationSource: 'Synthetic chart',
        facilityVariationEffectiveDate: '2025-01-01',
      },
    ],
    metadata: [magneticMetadata()],
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-smoke-baseline-'));
  const baselinePath = join(temporaryDirectory, 'baseline.json');
  const snapshotSha256 = createHash('sha256')
    .update(await readFile(database.databasePath))
    .digest('hex');
  const stdout =
    'Route Points: AAAA → MID → BBBB\n' +
    'Total Distance: 120.1 NM\n' +
    'Route Legs: 2\n' +
    'Route Search Mode: VOR-family only\n' +
    '\n' +
    'Route Legs\n' +
    'Leg  From  To    Distance  Outbound True  Arrival True  Outbound Magnetic  Arrival Magnetic  Departure VOR Guidance  Arrival VOR Guidance\n' +
    '  1  AAAA  MID    60.0 NM           090°          090°               085°              087°  —                       Inbound 083°\n' +
    '  2  MID   BBBB   60.0 NM           090°          090°               087°              092°  Outbound 083°           —\n' +
    '\n' +
    'Navaids\n' +
    'Identifier  Type      Frequency  Published Range\n' +
    'MID         VOR-DME  113.70 MHz          61.0 NM\n';
  const cliOutputSha256 = createHash('sha256')
    .update(JSON.stringify({exitCode: 0, stdout, stderr: ''}))
    .digest('hex');

  try {
    await writeFile(
      baselinePath,
      JSON.stringify(
        createRoutePlannerAcceptanceBaseline({
          snapshotSha256,
          cliOutputSha256,
          magneticReference: {
            model: 'WMM',
            version: '2025',
            epochYear: 2025,
            referenceDate: '2026-01-01',
            source: 'Synthetic test model',
          },
        })
      )
    );

    await expect(
      runRoutePlannerSmoke({baselinePath, snapshotPath: database.databasePath})
    ).resolves.toEqual({
      snapshotSha256,
      cliOutputSha256,
      routeLegCount: 2,
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

function syntheticAirport(
  databaseId: string,
  icao: string,
  longitude: number,
  magneticDeclinationDegEast: number
) {
  return {
    databaseId,
    icao,
    name: `${icao} Airport`,
    longitude,
    latitude: 0,
    magneticDeclinationDegEast,
  };
}

function magneticMetadata() {
  return {
    magneticModel: 'WMM',
    magneticModelVersion: '2025',
    magneticModelEpochYear: 2025,
    magneticReferenceDate: '2026-01-01',
    magneticModelSource: 'Synthetic test model',
  };
}
