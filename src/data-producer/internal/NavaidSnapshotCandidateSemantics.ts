import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025, wmm2025Provenance} = Wmm2025;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_FACILITY_MATCH_DISTANCE_NM = 1 + 0.001 / 1852;

function validateNavaidSnapshotCandidateSemantics(
  candidate: NavaidSnapshotCandidate
): void {
  validateTimestamp(candidate.retrievedAt, 'retrievedAt');
  validateTimestamp(candidate.retrievalCompletedAt, 'retrievalCompletedAt');
  if (candidate.retrievalCompletedAt < candidate.retrievedAt) {
    throw new Error('candidate retrieval timestamps do not reconcile');
  }

  if (
    candidate.provenance.faaNasr.retrievedAt < candidate.retrievedAt ||
    candidate.provenance.faaNasr.retrievedAt > candidate.retrievalCompletedAt
  ) {
    throw new Error('candidate FAA NASR retrieval timestamp does not reconcile');
  }

  validateProvenance(candidate);

  const rawIdentities = new Set<string>();
  for (const raw of candidate.rawNavaids) {
    if (raw.sourceRecordId === '' || rawIdentities.has(raw.sourceRecordId)) {
      throw new Error('candidate raw Navaid identities do not reconcile');
    }

    rawIdentities.add(raw.sourceRecordId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.canonicalRecord) as unknown;
    } catch {
      throw new Error('candidate raw Navaid canonical JSON is invalid');
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      canonicalizeJson(parsed) !== raw.canonicalRecord ||
      checksum(raw.canonicalRecord) !== raw.recordChecksum
    ) {
      throw new Error('candidate raw Navaid canonical JSON does not reconcile');
    }
  }

  const partitionIdentities = new Set<string>();
  const databaseIdentities = new Set<string>();
  for (const navaid of candidate.plannerNavaids) {
    const expectedMagneticDeclination = localMagneticDeclinationFromWmm2025({
      referenceDate: candidate.provenance.magneticModel.referenceDate,
      longitude: navaid.longitude,
      latitude: navaid.latitude,
    });
    if (
      partitionIdentities.has(navaid.sourceRecordId) ||
      databaseIdentities.has(navaid.databaseId) ||
      !validPlannerNavaid(navaid) ||
      navaid.magneticDeclinationDegEast !== expectedMagneticDeclination
    ) {
      throw new Error('candidate planner-ready Navaids do not reconcile');
    }

    partitionIdentities.add(navaid.sourceRecordId);
    databaseIdentities.add(navaid.databaseId);
  }

  for (const exclusion of candidate.exclusions) {
    if (
      partitionIdentities.has(exclusion.sourceRecordId) ||
      !validExclusionReason(exclusion.reason)
    ) {
      throw new Error('candidate exclusions do not reconcile');
    }

    partitionIdentities.add(exclusion.sourceRecordId);
  }

  if (!sameSet(rawIdentities, partitionIdentities)) {
    throw new Error('candidate source partition does not reconcile');
  }

  const auditIdentities = new Set(
    candidate.facilityVariationAudits.map(audit => audit.sourceRecordId)
  );
  const plannerIdentities = new Set(
    candidate.plannerNavaids
      .filter(navaid => navaid.family !== 'NDB')
      .map(navaid => navaid.sourceRecordId)
  );
  const plannerNavaidsBySourceRecordId = new Map(
    candidate.plannerNavaids.map(navaid => [navaid.sourceRecordId, navaid])
  );
  if (
    auditIdentities.size !== candidate.facilityVariationAudits.length ||
    !sameSet(auditIdentities, plannerIdentities) ||
    candidate.facilityVariationAudits.some(audit => {
      const navaid = plannerNavaidsBySourceRecordId.get(audit.sourceRecordId);
      return (
        navaid === undefined || !validFacilityVariationAudit(audit, navaid, candidate)
      );
    })
  ) {
    throw new Error('candidate Facility Variation audit partition does not reconcile');
  }

  const expectedComponentChecksums = {
    rawNavaids: checksum(canonicalizeJson(candidate.rawNavaids)),
    plannerNavaids: checksum(canonicalizeJson(candidate.plannerNavaids)),
    exclusions: checksum(canonicalizeJson(candidate.exclusions)),
    facilityVariationAudits: checksum(
      canonicalizeJson(
        candidate.facilityVariationAudits.map(audit => {
          const {nasrRetrievedAt: _, ...checksumAudit} = audit;
          return checksumAudit;
        })
      )
    ),
  };
  if (candidate.componentChecksums.rawNavaids !== expectedComponentChecksums.rawNavaids) {
    throw new Error('candidate raw Navaid checksum does not reconcile');
  }

  if (
    candidate.componentChecksums.plannerNavaids !==
      expectedComponentChecksums.plannerNavaids ||
    candidate.componentChecksums.exclusions !== expectedComponentChecksums.exclusions ||
    candidate.componentChecksums.facilityVariationAudits !==
      expectedComponentChecksums.facilityVariationAudits
  ) {
    throw new Error('candidate component checksums do not reconcile');
  }

  const expectedSnapshotChecksum = checksum(
    canonicalizeJson({
      manifestVersion: 1,
      provenance: checksumProvenance(candidate.provenance),
      componentChecksums: expectedComponentChecksums,
      counts: {
        rawNavaids: candidate.rawNavaids.length,
        plannerNavaids: candidate.plannerNavaids.length,
        exclusions: candidate.exclusions.length,
      },
    })
  );
  if (candidate.snapshotChecksum !== expectedSnapshotChecksum) {
    throw new Error('candidate snapshot checksum does not reconcile');
  }
}

function checksumProvenance(provenance: NavaidSnapshotCandidate['provenance']) {
  const {retrievedAt: _, ...faaNasr} = provenance.faaNasr;
  return {...provenance, faaNasr};
}

function validateProvenance(candidate: NavaidSnapshotCandidate): void {
  const provenance = candidate.provenance;
  const expectedMagneticModel = wmm2025Provenance(candidate.retrievedAt.slice(0, 10));
  const requiredStrings = [
    provenance.sourceIdentity,
    provenance.derivationPolicyIdentity,
    provenance.matchingPolicyIdentity,
    provenance.magneticModel.model,
    provenance.magneticModel.version,
    provenance.magneticModel.source,
    provenance.faaNasr.sourceUrl,
    provenance.faaNasr.archiveIdentity,
    provenance.faaNasr.cycleId,
  ];
  if (requiredStrings.some(value => value.trim() === '')) {
    throw new Error('candidate provenance bundle is incomplete');
  }

  if (
    !Number.isFinite(provenance.magneticModel.epochYear) ||
    provenance.magneticModel.epochYear <= 0 ||
    !ISO_DATE_PATTERN.test(provenance.magneticModel.referenceDate) ||
    !validChecksum(provenance.magneticModel.coefficientChecksum) ||
    !validChecksum(provenance.faaNasr.archiveChecksum) ||
    !validChecksum(provenance.faaNasr.contentChecksum) ||
    !ISO_DATE_PATTERN.test(provenance.faaNasr.effectiveDate)
  ) {
    throw new Error('candidate magnetic provenance bundle is invalid');
  }

  if (
    provenance.magneticModel.model !== expectedMagneticModel.model ||
    provenance.magneticModel.version !== expectedMagneticModel.version ||
    provenance.magneticModel.epochYear !== expectedMagneticModel.epochYear ||
    provenance.magneticModel.referenceDate !== expectedMagneticModel.referenceDate ||
    provenance.magneticModel.source !== expectedMagneticModel.source ||
    provenance.magneticModel.coefficientChecksum !==
      expectedMagneticModel.coefficientChecksum
  ) {
    throw new Error('candidate magnetic provenance does not match pinned WMM2025 inputs');
  }
}

function validPlannerNavaid(
  navaid: NavaidSnapshotCandidate['plannerNavaids'][number]
): boolean {
  const variationAbsent =
    navaid.facilityVariationDegEast === null &&
    navaid.facilityVariationSource === null &&
    navaid.facilityVariationEffectiveDate === null;
  const variationPresent =
    navaid.facilityVariationDegEast !== null &&
    navaid.facilityVariationSource !== null &&
    navaid.facilityVariationSource.trim() !== '' &&
    (navaid.facilityVariationEffectiveDate === null ||
      ISO_DATE_PATTERN.test(navaid.facilityVariationEffectiveDate));
  return (
    navaid.sourceRecordId !== '' &&
    navaid.databaseId !== '' &&
    navaid.identifier !== '' &&
    navaid.name !== '' &&
    ['NDB', 'VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC'].includes(
      navaid.family
    ) &&
    finiteInRange(navaid.longitude, -180, 180, true) &&
    finiteInRange(navaid.latitude, -90, 90, true) &&
    Number.isFinite(navaid.frequencyValue) &&
    navaid.frequencyValue > 0 &&
    (navaid.frequencyUnit === 'kHz' || navaid.frequencyUnit === 'MHz') &&
    Number.isFinite(navaid.publishedRangeNm) &&
    navaid.publishedRangeNm > 0 &&
    (navaid.magneticDeclinationDegEast === null ||
      finiteInRange(navaid.magneticDeclinationDegEast, -180, 180, false)) &&
    (variationAbsent ||
      (navaid.family !== 'NDB' &&
        variationPresent &&
        finiteInRange(navaid.facilityVariationDegEast!, -180, 180, false)))
  );
}

function validFacilityVariationAudit(
  audit: NavaidSnapshotCandidate['facilityVariationAudits'][number],
  navaid: NavaidSnapshotCandidate['plannerNavaids'][number],
  candidate: NavaidSnapshotCandidate
): boolean {
  const nasr = candidate.provenance.faaNasr;
  if (
    ![
      'matched',
      'outside-source-coverage',
      'no-unique-match',
      'unusable-source-value',
    ].includes(audit.outcome) ||
    audit.sourceRecordId === '' ||
    audit.matchingPolicyIdentity.trim() === '' ||
    !validChecksum(audit.nasrArchiveChecksum) ||
    !validChecksum(audit.nasrContentChecksum) ||
    audit.matchingPolicyIdentity !== candidate.provenance.matchingPolicyIdentity ||
    audit.nasrSourceUrl !== nasr.sourceUrl ||
    audit.nasrRetrievedAt !== nasr.retrievedAt ||
    audit.nasrArchiveIdentity !== nasr.archiveIdentity ||
    audit.nasrArchiveChecksum !== nasr.archiveChecksum ||
    audit.nasrContentChecksum !== nasr.contentChecksum ||
    audit.nasrCycleId !== nasr.cycleId ||
    audit.nasrEffectiveDate !== nasr.effectiveDate ||
    audit.openAipIdentifier !== navaid.identifier.trim().toUpperCase() ||
    audit.openAipLongitude !== navaid.longitude ||
    audit.openAipLatitude !== navaid.latitude ||
    audit.openAipFrequencyHz !== Math.round(navaid.frequencyValue * 1_000_000)
  ) {
    return false;
  }

  if (audit.outcome !== 'matched') {
    return (
      audit.facilityVariationDegEast === null &&
      audit.sourceIdentity === null &&
      navaid.facilityVariationDegEast === null &&
      navaid.facilityVariationSource === null &&
      navaid.facilityVariationEffectiveDate === null
    );
  }

  return (
    audit.sourceIdentity !== null &&
    audit.sourceIdentity.trim() !== '' &&
    audit.facilityVariationDegEast !== null &&
    finiteInRange(audit.facilityVariationDegEast, -180, 180, false) &&
    audit.facilityVariationEpochYear !== null &&
    Number.isSafeInteger(audit.facilityVariationEpochYear) &&
    audit.facilityVariationEpochYear > 0 &&
    audit.faaRecordIdentity !== null &&
    audit.faaFacilityIdentifier !== null &&
    audit.faaFacilityType !== null &&
    audit.faaLongitude !== null &&
    audit.faaLatitude !== null &&
    audit.faaFrequencyHz !== null &&
    audit.rawMagneticVariation !== null &&
    audit.rawMagneticVariationHemisphere !== null &&
    audit.rawMagneticVariationEpochYear !== null &&
    audit.separationNm !== null &&
    audit.separationNm <= MAXIMUM_FACILITY_MATCH_DISTANCE_NM &&
    navaid.facilityVariationDegEast === audit.facilityVariationDegEast &&
    navaid.facilityVariationSource === audit.sourceIdentity &&
    navaid.facilityVariationEffectiveDate === null
  );
}

function validExclusionReason(reason: string): boolean {
  return [
    'missing-stable-identity',
    'unsupported-navaid-type',
    'invalid-coordinates',
    'missing-identifier',
    'invalid-frequency',
    'invalid-published-range',
  ].includes(reason);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function finiteInRange(
  value: number,
  minimum: number,
  maximum: number,
  inclusiveMaximum: boolean
): boolean {
  return (
    Number.isFinite(value) &&
    value >= minimum &&
    (inclusiveMaximum ? value <= maximum : value < maximum)
  );
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp.`);
  }
}

function validChecksum(value: string): boolean {
  return SHA256_CHECKSUM_PATTERN.test(value);
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export default validateNavaidSnapshotCandidateSemantics;
