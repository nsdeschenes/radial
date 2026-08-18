import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import faaNasrFacilityVariation from '#radial/data-producer/internal/FAANasrFacilityVariation.js';

type FAANasrCycleArtifact = Parameters<
  typeof faaNasrFacilityVariation.selectApplicableCycle
>[0][number];

function createSyntheticFAANasrCycle(
  records: readonly Readonly<Record<string, unknown>>[],
  overrides: Partial<FAANasrCycleArtifact> = {}
): FAANasrCycleArtifact {
  const cycleId = overrides.cycleId ?? '2607';
  const archiveBytes =
    overrides.archiveBytes ?? new TextEncoder().encode(`official FAA fixture ${cycleId}`);
  return {
    archiveBytes,
    archiveChecksum: bytesChecksum(archiveBytes),
    archiveIdentity: `28-day-nasr-${cycleId}.zip`,
    contentChecksum: textChecksum(canonicalizeJson(canonicalRecordSet(records))),
    cycleId,
    effectiveDate: '2026-07-09',
    publishedAt: '2026-06-25T12:00:00.000Z',
    records,
    retrievedAt: '2026-07-10T00:00:01.000Z',
    sourceUrl: `https://nfdc.faa.gov/webContent/28DaySub/28-day-nasr-${cycleId}.zip`,
    ...overrides,
  };
}

function canonicalRecordSet(records: readonly Readonly<Record<string, unknown>>[]) {
  return records
    .map(record => canonicalizeJson(record))
    .toSorted()
    .map(record => JSON.parse(record) as Readonly<Record<string, unknown>>);
}

function bytesChecksum(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function textChecksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export default createSyntheticFAANasrCycle;
