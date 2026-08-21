import {expect, test} from 'vitest';

import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import producerSchemaNavaidSnapshotCodec from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCodec.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const PUBLISHED_AT = '2026-08-17T12:00:02.000Z';
const VERSION_ONE_CHECKSUMS = {
  rawNavaids: 'sha256:24ef99bfc6fe04ce8366c8b30a3b173ebe71e61beb6040311ff1ff9ce82b808f',
  plannerNavaids:
    'sha256:fa225269d333440ecaf92c90d419a991e7da79635396e05298075dc2abbcc61f',
  exclusions: 'sha256:40573ad4e5aefdebf521fd3d934ab203a17717ccef0596827dbd622c1b55e745',
  facilityVariationAudits:
    'sha256:6a86745190a51f069655976a033180ffc0e68a6760947d8b75ce46ae84a4ad42',
} as const;
const VERSION_ONE_SNAPSHOT_CHECKSUM =
  'sha256:8701c658ce0c0070a9c88f5118a05d5a8b3de7db90ced468b845972df6d731b3';

test('preserves the fixed version 1 checksum identity and canonical storage order', () => {
  const candidate = createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z');
  const reorderedCandidate: NavaidSnapshotCandidate = {
    ...candidate,
    rawNavaids: candidate.rawNavaids.toReversed(),
    plannerNavaids: candidate.plannerNavaids.toReversed(),
    exclusions: candidate.exclusions.toReversed(),
    facilityVariationAudits: candidate.facilityVariationAudits.toReversed(),
  };

  const storage = producerSchemaNavaidSnapshotCodec.encode(
    reorderedCandidate,
    SNAPSHOT_ID,
    PUBLISHED_AT
  );

  expect(storage.metadata).toMatchObject({
    snapshotId: SNAPSHOT_ID,
    snapshotChecksum: VERSION_ONE_SNAPSHOT_CHECKSUM,
    rawNavaidsChecksum: VERSION_ONE_CHECKSUMS.rawNavaids,
    plannerNavaidsChecksum: VERSION_ONE_CHECKSUMS.plannerNavaids,
    exclusionsChecksum: VERSION_ONE_CHECKSUMS.exclusions,
    facilityVariationAuditsChecksum: VERSION_ONE_CHECKSUMS.facilityVariationAudits,
    publishedAt: PUBLISHED_AT,
    rawNavaidCount: 2,
    plannerNavaidCount: 1,
    exclusionCount: 1,
  });
  expect(storage.rawNavaids.map(row => row.sourceRecordId)).toEqual([
    'unsupported',
    'vor-1',
  ]);
  expect(storage.plannerNavaids.map(row => row.sourceRecordId)).toEqual(['vor-1']);
  expect(storage.exclusions.map(row => row.sourceRecordId)).toEqual(['unsupported']);
  expect(storage.facilityVariationAudits.map(row => row.sourceRecordId)).toEqual([
    'vor-1',
  ]);
});

test('decodes version 1 child storage rows without changing their candidate values', () => {
  const candidate = createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z');
  const storage = producerSchemaNavaidSnapshotCodec.encode(
    candidate,
    SNAPSHOT_ID,
    PUBLISHED_AT
  );
  const decoded = producerSchemaNavaidSnapshotCodec.decode(storage);

  expect(decoded.metadata).toMatchObject({
    snapshotId: SNAPSHOT_ID,
    snapshotChecksum: VERSION_ONE_SNAPSHOT_CHECKSUM,
    componentChecksums: VERSION_ONE_CHECKSUMS,
    publishedAt: PUBLISHED_AT,
    counts: {rawNavaids: 2, plannerNavaids: 1, exclusions: 1},
  });
  expect(decoded.rawNavaids).toEqual(candidate.rawNavaids);
  expect(decoded.plannerNavaids).toEqual(candidate.plannerNavaids);
  expect(decoded.exclusions).toEqual(candidate.exclusions);
  expect(decoded.facilityVariationAudits).toEqual(candidate.facilityVariationAudits);
});
