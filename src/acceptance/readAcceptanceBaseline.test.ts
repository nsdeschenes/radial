import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import readAcceptanceBaseline from '#radial/acceptance/readAcceptanceBaseline.js';
import createRoutePlannerAcceptanceBaseline from '#radial/test/acceptance/createRoutePlannerAcceptanceBaseline.js';

test('reads every reproducibility fact required by a real-data baseline', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-baseline-'));
  const baselinePath = join(temporaryDirectory, 'baseline.json');
  const baseline = {
    ...createRoutePlannerAcceptanceBaseline({snapshotSha256: '0'.repeat(64)}),
    snapshot: {
      sha256: '0'.repeat(64),
      schemaVersion: 1,
      provenance: {
        source: 'Immutable OpenAIP-derived snapshot',
        retrievedAt: '2026-08-17T00:00:00.000Z',
      },
      recordCounts: {
        airports: 2,
        vorFamilyNavaids: 1,
        fallbackNavaids: 0,
      },
      magneticReference: null,
    },
    benchmark: {
      ...createRoutePlannerAcceptanceBaseline({snapshotSha256: '0'.repeat(64)}).benchmark,
      radialRevision: '0123456789abcdef0123456789abcdef01234567',
      warmupMs: 1,
    },
  };

  try {
    await writeFile(baselinePath, JSON.stringify(baseline));

    await expect(readAcceptanceBaseline(baselinePath)).resolves.toEqual(baseline);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});
