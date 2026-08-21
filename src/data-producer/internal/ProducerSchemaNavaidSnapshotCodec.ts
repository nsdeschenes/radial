import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';

type CandidateContent = Omit<
  NavaidSnapshotCandidate,
  'componentChecksums' | 'snapshotChecksum'
>;
type ComponentChecksums = NavaidSnapshotCandidate['componentChecksums'];

type SnapshotMetadataStorageRow = Readonly<{
  snapshotId: string;
  snapshotChecksum: string;
  rawNavaidsChecksum: string;
  plannerNavaidsChecksum: string;
  exclusionsChecksum: string;
  facilityVariationAuditsChecksum: string;
  retrievedAt: string;
  retrievalCompletedAt: string;
  publishedAt: string;
  sourceIdentity: string;
  derivationPolicyIdentity: string;
  matchingPolicyIdentity: string;
  nasrSourceUrl: string;
  nasrRetrievedAt: string;
  nasrArchiveIdentity: string;
  nasrArchiveChecksum: string;
  nasrContentChecksum: string;
  nasrCycleId: string;
  nasrEffectiveDate: string;
  rawNavaidCount: number;
  plannerNavaidCount: number;
  exclusionCount: number;
  magneticModel: string;
  magneticModelVersion: string;
  magneticModelEpochYear: number;
  magneticReferenceDate: string;
  magneticModelSource: string;
  magneticModelChecksum: string;
}>;

type RawNavaidStorageRow = Readonly<{
  snapshotId: string;
  sourceRecordId: string;
  canonicalRecord: string;
  recordChecksum: string;
}>;

type PlannerNavaidStorageRow = Readonly<{
  snapshotId: string;
  databaseId: string;
  sourceRecordId: string;
  identifier: string;
  name: string;
  family: NavaidSnapshotCandidate['plannerNavaids'][number]['family'];
  longitude: number;
  latitude: number;
  frequencyValue: number;
  frequencyUnit: NavaidSnapshotCandidate['plannerNavaids'][number]['frequencyUnit'];
  publishedRangeNm: number;
  magneticDeclinationDegEast: number | null;
  facilityVariationDegEast: number | null;
  facilityVariationSource: string | null;
  facilityVariationEffectiveDate: string | null;
}>;

type ExclusionStorageRow = Readonly<{
  snapshotId: string;
  sourceRecordId: string;
  reason: NavaidSnapshotCandidate['exclusions'][number]['reason'];
}>;

type FacilityVariationAuditStorageRow = Readonly<{
  snapshotId: string;
  sourceRecordId: string;
  outcome: NavaidSnapshotCandidate['facilityVariationAudits'][number]['outcome'];
  sourceIdentity: string | null;
  auditRecord: string;
}>;

type NavaidSnapshotStorage = Readonly<{
  metadata: SnapshotMetadataStorageRow;
  rawNavaids: readonly RawNavaidStorageRow[];
  plannerNavaids: readonly PlannerNavaidStorageRow[];
  exclusions: readonly ExclusionStorageRow[];
  facilityVariationAudits: readonly FacilityVariationAuditStorageRow[];
}>;

type DecodedNavaidSnapshotStorage = Readonly<{
  metadata: Readonly<{
    snapshotId: string;
    snapshotChecksum: string;
    componentChecksums: ComponentChecksums;
    retrievedAt: string;
    retrievalCompletedAt: string;
    publishedAt: string;
    sourceIdentity: string;
    derivationPolicyIdentity: string;
    matchingPolicyIdentity: string;
    faaNasr: Readonly<{
      sourceUrl: string;
      retrievedAt: string;
      archiveIdentity: string;
      archiveChecksum: string;
      contentChecksum: string;
      cycleId: string;
      effectiveDate: string;
    }>;
    magneticModel: NavaidSnapshotCandidate['provenance']['magneticModel'];
    counts: Readonly<{
      rawNavaids: number;
      plannerNavaids: number;
      exclusions: number;
    }>;
  }>;
  rawNavaids: NavaidSnapshotCandidate['rawNavaids'];
  plannerNavaids: NavaidSnapshotCandidate['plannerNavaids'];
  exclusions: NavaidSnapshotCandidate['exclusions'];
  facilityVariationAudits: NavaidSnapshotCandidate['facilityVariationAudits'];
}>;

function completeCandidate(content: CandidateContent): NavaidSnapshotCandidate {
  const orderedContent = orderContent(content);
  const componentChecksums = constructComponentChecksums(orderedContent);
  return Object.freeze({
    ...orderedContent,
    componentChecksums: Object.freeze(componentChecksums),
    snapshotChecksum: constructSnapshotChecksum(orderedContent, componentChecksums),
  });
}

function encode(
  candidate: NavaidSnapshotCandidate,
  snapshotId: string,
  publishedAt: string
): NavaidSnapshotStorage {
  return {
    metadata: encodeMetadata(candidate, snapshotId, publishedAt),
    ...encodeRows(candidate, snapshotId),
  };
}

function encodeMetadata(
  candidate: NavaidSnapshotCandidate,
  snapshotId: string,
  publishedAt: string
): SnapshotMetadataStorageRow {
  const complete = completeCandidate(candidate);
  assertChecksumsMatch(candidate, complete);
  const magneticModel = complete.provenance.magneticModel;
  const faaNasr = complete.provenance.faaNasr;
  return {
    snapshotId,
    snapshotChecksum: complete.snapshotChecksum,
    rawNavaidsChecksum: complete.componentChecksums.rawNavaids,
    plannerNavaidsChecksum: complete.componentChecksums.plannerNavaids,
    exclusionsChecksum: complete.componentChecksums.exclusions,
    facilityVariationAuditsChecksum: complete.componentChecksums.facilityVariationAudits,
    retrievedAt: complete.retrievedAt,
    retrievalCompletedAt: complete.retrievalCompletedAt,
    publishedAt,
    sourceIdentity: complete.provenance.sourceIdentity,
    derivationPolicyIdentity: complete.provenance.derivationPolicyIdentity,
    matchingPolicyIdentity: complete.provenance.matchingPolicyIdentity,
    nasrSourceUrl: faaNasr.sourceUrl,
    nasrRetrievedAt: faaNasr.retrievedAt,
    nasrArchiveIdentity: faaNasr.archiveIdentity,
    nasrArchiveChecksum: faaNasr.archiveChecksum,
    nasrContentChecksum: faaNasr.contentChecksum,
    nasrCycleId: faaNasr.cycleId,
    nasrEffectiveDate: faaNasr.effectiveDate,
    rawNavaidCount: complete.rawNavaids.length,
    plannerNavaidCount: complete.plannerNavaids.length,
    exclusionCount: complete.exclusions.length,
    magneticModel: magneticModel.model,
    magneticModelVersion: magneticModel.version,
    magneticModelEpochYear: magneticModel.epochYear,
    magneticReferenceDate: magneticModel.referenceDate,
    magneticModelSource: magneticModel.source,
    magneticModelChecksum: magneticModel.coefficientChecksum,
  };
}

function encodeRows(
  candidate: NavaidSnapshotCandidate,
  snapshotId: string
): Omit<NavaidSnapshotStorage, 'metadata'> {
  const complete = completeCandidate(candidate);
  assertChecksumsMatch(candidate, complete);
  return {
    rawNavaids: complete.rawNavaids.map(row => ({snapshotId, ...row})),
    plannerNavaids: complete.plannerNavaids.map(row => ({snapshotId, ...row})),
    exclusions: complete.exclusions.map(row => ({snapshotId, ...row})),
    facilityVariationAudits: complete.facilityVariationAudits.map(row => ({
      snapshotId,
      sourceRecordId: row.sourceRecordId,
      outcome: row.outcome,
      sourceIdentity: row.sourceIdentity,
      auditRecord: canonicalizeJson(row),
    })),
  };
}

function decode(storage: NavaidSnapshotStorage): DecodedNavaidSnapshotStorage {
  assertOneSnapshotIdentity(storage);
  return {
    metadata: decodeMetadata(storage.metadata),
    rawNavaids: storage.rawNavaids.toSorted(compareSourceRecordIds).map(decodeRawNavaid),
    plannerNavaids: storage.plannerNavaids
      .toSorted(compareSourceRecordIds)
      .map(decodePlannerNavaid),
    exclusions: storage.exclusions.toSorted(compareSourceRecordIds).map(decodeExclusion),
    facilityVariationAudits: storage.facilityVariationAudits
      .toSorted(compareSourceRecordIds)
      .map(decodeFacilityVariationAudit),
  };
}

function decodeMetadata(row: SnapshotMetadataStorageRow) {
  return {
    snapshotId: row.snapshotId,
    snapshotChecksum: row.snapshotChecksum,
    componentChecksums: {
      rawNavaids: row.rawNavaidsChecksum,
      plannerNavaids: row.plannerNavaidsChecksum,
      exclusions: row.exclusionsChecksum,
      facilityVariationAudits: row.facilityVariationAuditsChecksum,
    },
    retrievedAt: row.retrievedAt,
    retrievalCompletedAt: row.retrievalCompletedAt,
    publishedAt: row.publishedAt,
    sourceIdentity: row.sourceIdentity,
    derivationPolicyIdentity: row.derivationPolicyIdentity,
    matchingPolicyIdentity: row.matchingPolicyIdentity,
    faaNasr: {
      sourceUrl: row.nasrSourceUrl,
      retrievedAt: row.nasrRetrievedAt,
      archiveIdentity: row.nasrArchiveIdentity,
      archiveChecksum: row.nasrArchiveChecksum,
      contentChecksum: row.nasrContentChecksum,
      cycleId: row.nasrCycleId,
      effectiveDate: row.nasrEffectiveDate,
    },
    magneticModel: {
      model: row.magneticModel,
      version: row.magneticModelVersion,
      epochYear: row.magneticModelEpochYear,
      referenceDate: row.magneticReferenceDate,
      source: row.magneticModelSource,
      coefficientChecksum: row.magneticModelChecksum,
    },
    counts: {
      rawNavaids: row.rawNavaidCount,
      plannerNavaids: row.plannerNavaidCount,
      exclusions: row.exclusionCount,
    },
  } satisfies DecodedNavaidSnapshotStorage['metadata'];
}

function decodeRawNavaid(row: RawNavaidStorageRow) {
  return {
    sourceRecordId: row.sourceRecordId,
    canonicalRecord: row.canonicalRecord,
    recordChecksum: row.recordChecksum,
  } satisfies NavaidSnapshotCandidate['rawNavaids'][number];
}

function decodePlannerNavaid(row: PlannerNavaidStorageRow) {
  const {snapshotId: _, ...decoded} = row;
  return decoded satisfies NavaidSnapshotCandidate['plannerNavaids'][number];
}

function decodeExclusion(row: ExclusionStorageRow) {
  return {
    sourceRecordId: row.sourceRecordId,
    reason: row.reason,
  } satisfies NavaidSnapshotCandidate['exclusions'][number];
}

function decodeFacilityVariationAudit(
  row: FacilityVariationAuditStorageRow
): NavaidSnapshotCandidate['facilityVariationAudits'][number] {
  const decoded = JSON.parse(row.auditRecord) as unknown;
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('stored Facility Variation audit is not a JSON object');
  }

  return decoded as NavaidSnapshotCandidate['facilityVariationAudits'][number];
}

function orderContent(content: CandidateContent): CandidateContent {
  return {
    ...content,
    rawNavaids: Object.freeze(content.rawNavaids.toSorted(compareSourceRecordIds)),
    plannerNavaids: Object.freeze(
      content.plannerNavaids.toSorted(compareSourceRecordIds)
    ),
    exclusions: Object.freeze(content.exclusions.toSorted(compareSourceRecordIds)),
    facilityVariationAudits: Object.freeze(
      content.facilityVariationAudits.toSorted(compareSourceRecordIds)
    ),
  };
}

function constructComponentChecksums(content: CandidateContent): ComponentChecksums {
  return {
    rawNavaids: checksum(canonicalizeJson(content.rawNavaids)),
    plannerNavaids: checksum(canonicalizeJson(content.plannerNavaids)),
    exclusions: checksum(canonicalizeJson(content.exclusions)),
    facilityVariationAudits: checksum(
      canonicalizeJson(
        content.facilityVariationAudits.map(audit => {
          const {nasrRetrievedAt: _, ...checksumAudit} = audit;
          return checksumAudit;
        })
      )
    ),
  };
}

function constructSnapshotChecksum(
  content: CandidateContent,
  componentChecksums: ComponentChecksums
): string {
  const {retrievedAt: _, ...faaNasr} = content.provenance.faaNasr;
  return checksum(
    canonicalizeJson({
      manifestVersion: 1,
      provenance: {...content.provenance, faaNasr},
      componentChecksums,
      counts: {
        rawNavaids: content.rawNavaids.length,
        plannerNavaids: content.plannerNavaids.length,
        exclusions: content.exclusions.length,
      },
    })
  );
}

function assertChecksumsMatch(
  candidate: NavaidSnapshotCandidate,
  complete: NavaidSnapshotCandidate
): void {
  if (
    candidate.snapshotChecksum !== complete.snapshotChecksum ||
    candidate.componentChecksums.rawNavaids !== complete.componentChecksums.rawNavaids ||
    candidate.componentChecksums.plannerNavaids !==
      complete.componentChecksums.plannerNavaids ||
    candidate.componentChecksums.exclusions !== complete.componentChecksums.exclusions ||
    candidate.componentChecksums.facilityVariationAudits !==
      complete.componentChecksums.facilityVariationAudits
  ) {
    throw new Error('Navaid Snapshot storage checksums do not reconcile');
  }
}

function assertOneSnapshotIdentity(storage: NavaidSnapshotStorage): void {
  const snapshotId = storage.metadata.snapshotId;
  if (
    [
      ...storage.rawNavaids,
      ...storage.plannerNavaids,
      ...storage.exclusions,
      ...storage.facilityVariationAudits,
    ].some(row => row.snapshotId !== snapshotId)
  ) {
    throw new Error('Navaid Snapshot storage rows have conflicting identities');
  }
}

function compareSourceRecordIds(
  left: Readonly<{sourceRecordId: string}>,
  right: Readonly<{sourceRecordId: string}>
): number {
  return left.sourceRecordId < right.sourceRecordId
    ? -1
    : left.sourceRecordId > right.sourceRecordId
      ? 1
      : 0;
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

const producerSchemaNavaidSnapshotCodec = {
  decode,
  encode,
  encodeMetadata,
  encodeRows,
};

export default producerSchemaNavaidSnapshotCodec;
