import {createHash} from 'node:crypto';

import type {DuckDBConnection} from '@duckdb/node-api';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import type producerSchemaNavaidSnapshotCodec from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCodec.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NAVAID_FAMILIES = new Set([
  'NDB',
  'VOR',
  'VOR-DME',
  'VORTAC',
  'DVOR',
  'DVOR-DME',
  'DVORTAC',
]);
const EXCLUSION_REASONS = new Set([
  'missing-stable-identity',
  'unsupported-navaid-type',
  'invalid-coordinates',
  'missing-identifier',
  'invalid-frequency',
  'invalid-published-range',
]);
const AUDIT_OUTCOMES = new Set([
  'matched',
  'outside-source-coverage',
  'no-unique-match',
  'unusable-source-value',
]);

type ProducerSchemaNavaidSnapshotCodec = typeof producerSchemaNavaidSnapshotCodec;
type CachedAirport = Readonly<{
  icao: string;
  sourceId: string;
  name: string;
  longitude: number;
  latitude: number;
  recordChecksum: string;
  sourceIdentity: string;
  retrievedAt: string;
  publishedAt: string;
}>;

type SnapshotSummary = Readonly<{
  snapshotId: string;
  snapshotChecksum: string;
  componentChecksums: Readonly<{
    rawNavaids: string;
    plannerNavaids: string;
    exclusions: string;
    facilityVariationAudits: string;
  }>;
  retrievedAt: string;
  retrievalCompletedAt: string;
  publishedAt: string;
  sourceIdentity: string;
  derivationPolicyIdentity: string;
  matchingPolicyIdentity: string;
  nasr: Readonly<{
    sourceUrl: string;
    retrievedAt: string;
    archiveIdentity: string;
    archiveChecksum: string;
    contentChecksum: string;
    cycleId: string;
    effectiveDate: string;
  }>;
  magneticModel: NavaidSnapshotCandidate['provenance']['magneticModel'];
  rawNavaidCount: number;
  plannerNavaidCount: number;
  vorFamilyNavaidCount: number;
  fallbackNavaidCount: number;
  exclusionCount: number;
  exclusionCounts: readonly Readonly<{reason: string; count: number}>[];
  facilityVariationPresentCount: number;
  facilityVariationMissingCount: number;
  facilityVariationMissingReasons: readonly Readonly<{reason: string; count: number}>[];
  facilityVariationEpochYearMissingCount: number;
}>;

type CommittedInspection = Readonly<{
  cachedAirports: readonly CachedAirport[];
  snapshot: SnapshotSummary | null;
}>;

async function inspectCommittedNavaidSnapshot(
  connection: DuckDBConnection,
  activeSnapshotId: string | null,
  codec: ProducerSchemaNavaidSnapshotCodec
): Promise<CommittedInspection> {
  const cachedStorage = await readCachedAirports(connection);
  validateCachedAirports(cachedStorage);
  const cachedAirports = cachedStorage.map(({canonicalRecord: _, ...airport}) => airport);
  if (activeSnapshotId === null) {
    return {cachedAirports, snapshot: null};
  }

  const storage = await readSnapshotStorage(connection, activeSnapshotId);
  let decoded: ReturnType<ProducerSchemaNavaidSnapshotCodec['decode']>;
  try {
    decoded = codec.decode(storage);
  } catch (error) {
    throw invalid(
      error instanceof Error
        ? error.message
        : 'Committed Navaid Snapshot rows are invalid.'
    );
  }

  validateDecodedSnapshot(decoded, codec);
  await validatePlannerAirports(connection, activeSnapshotId, cachedStorage, decoded);
  return {cachedAirports, snapshot: summarize(decoded)};
}

async function readSnapshotStorage(connection: DuckDBConnection, snapshotId: string) {
  const metadata = await oneRow(
    connection,
    `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, snapshot_checksum,
       raw_navaids_checksum, planner_navaids_checksum, exclusions_checksum,
       facility_variation_audits_checksum, CAST(retrieved_at AS VARCHAR) AS retrieved_at,
       CAST(retrieval_completed_at AS VARCHAR) AS retrieval_completed_at,
       CAST(published_at AS VARCHAR) AS published_at, source_identity,
       derivation_policy_identity, matching_policy_identity, nasr_source_url,
       CAST(nasr_retrieved_at AS VARCHAR) AS nasr_retrieved_at,
       nasr_archive_identity, nasr_archive_checksum, nasr_content_checksum,
       nasr_cycle_id, CAST(nasr_effective_date AS VARCHAR) AS nasr_effective_date,
       raw_navaid_count, planner_navaid_count, exclusion_count, magnetic_model,
       magnetic_model_version, magnetic_model_epoch_year,
       CAST(magnetic_reference_date AS VARCHAR) AS magnetic_reference_date,
       magnetic_model_source, magnetic_model_checksum
     FROM radial_producer.navaid_snapshots
     WHERE snapshot_id = CAST(? AS UUID)`,
    snapshotId,
    'The active Navaid Snapshot metadata is unavailable.'
  );
  const rawRows = await rows(
    connection,
    `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, source_record_id,
       CAST(canonical_record AS VARCHAR) AS canonical_record, record_checksum
     FROM radial_producer.raw_navaids WHERE snapshot_id = CAST(? AS UUID)`,
    snapshotId
  );
  const plannerRows = await rows(
    connection,
    `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, database_id, source_record_id,
       identifier, name, family, longitude, latitude, frequency_value, frequency_unit,
       published_range_nm, magnetic_declination_deg_east, facility_variation_deg_east,
       facility_variation_source, CAST(facility_variation_effective_date AS VARCHAR)
         AS facility_variation_effective_date
     FROM radial_producer.planner_navaids WHERE snapshot_id = CAST(? AS UUID)`,
    snapshotId
  );
  const exclusionRows = await rows(
    connection,
    `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, source_record_id, reason
     FROM radial_producer.navaid_exclusions WHERE snapshot_id = CAST(? AS UUID)`,
    snapshotId
  );
  const auditRows = await rows(
    connection,
    `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, source_record_id, outcome,
       source_identity, CAST(audit_record AS VARCHAR) AS audit_record
     FROM radial_producer.facility_variation_audits
     WHERE snapshot_id = CAST(? AS UUID)`,
    snapshotId
  );

  return {
    metadata: {
      snapshotId: requiredString(metadata, 'snapshot_id'),
      snapshotChecksum: requiredString(metadata, 'snapshot_checksum'),
      rawNavaidsChecksum: requiredString(metadata, 'raw_navaids_checksum'),
      plannerNavaidsChecksum: requiredString(metadata, 'planner_navaids_checksum'),
      exclusionsChecksum: requiredString(metadata, 'exclusions_checksum'),
      facilityVariationAuditsChecksum: requiredString(
        metadata,
        'facility_variation_audits_checksum'
      ),
      retrievedAt: timestamp(metadata, 'retrieved_at'),
      retrievalCompletedAt: timestamp(metadata, 'retrieval_completed_at'),
      publishedAt: timestamp(metadata, 'published_at'),
      sourceIdentity: requiredString(metadata, 'source_identity'),
      derivationPolicyIdentity: requiredString(metadata, 'derivation_policy_identity'),
      matchingPolicyIdentity: requiredString(metadata, 'matching_policy_identity'),
      nasrSourceUrl: requiredString(metadata, 'nasr_source_url'),
      nasrRetrievedAt: timestamp(metadata, 'nasr_retrieved_at'),
      nasrArchiveIdentity: requiredString(metadata, 'nasr_archive_identity'),
      nasrArchiveChecksum: requiredString(metadata, 'nasr_archive_checksum'),
      nasrContentChecksum: requiredString(metadata, 'nasr_content_checksum'),
      nasrCycleId: requiredString(metadata, 'nasr_cycle_id'),
      nasrEffectiveDate: date(metadata, 'nasr_effective_date'),
      rawNavaidCount: nonNegativeInteger(metadata, 'raw_navaid_count'),
      plannerNavaidCount: nonNegativeInteger(metadata, 'planner_navaid_count'),
      exclusionCount: nonNegativeInteger(metadata, 'exclusion_count'),
      magneticModel: requiredString(metadata, 'magnetic_model'),
      magneticModelVersion: requiredString(metadata, 'magnetic_model_version'),
      magneticModelEpochYear: positiveNumber(metadata, 'magnetic_model_epoch_year'),
      magneticReferenceDate: date(metadata, 'magnetic_reference_date'),
      magneticModelSource: requiredString(metadata, 'magnetic_model_source'),
      magneticModelChecksum: requiredString(metadata, 'magnetic_model_checksum'),
    },
    rawNavaids: rawRows.map(row => ({
      snapshotId: requiredString(row, 'snapshot_id'),
      sourceRecordId: requiredString(row, 'source_record_id'),
      canonicalRecord: requiredString(row, 'canonical_record'),
      recordChecksum: requiredString(row, 'record_checksum'),
    })),
    plannerNavaids: plannerRows.map(row => ({
      snapshotId: requiredString(row, 'snapshot_id'),
      databaseId: requiredString(row, 'database_id'),
      sourceRecordId: requiredString(row, 'source_record_id'),
      identifier: requiredString(row, 'identifier'),
      name: requiredString(row, 'name'),
      family: requiredString(
        row,
        'family'
      ) as NavaidSnapshotCandidate['plannerNavaids'][number]['family'],
      longitude: number(row, 'longitude'),
      latitude: number(row, 'latitude'),
      frequencyValue: number(row, 'frequency_value'),
      frequencyUnit: requiredString(row, 'frequency_unit') as 'kHz' | 'MHz',
      publishedRangeNm: number(row, 'published_range_nm'),
      magneticDeclinationDegEast: nullableNumber(row, 'magnetic_declination_deg_east'),
      facilityVariationDegEast: nullableNumber(row, 'facility_variation_deg_east'),
      facilityVariationSource: nullableString(row, 'facility_variation_source'),
      facilityVariationEffectiveDate: nullableDate(
        row,
        'facility_variation_effective_date'
      ),
    })),
    exclusions: exclusionRows.map(row => ({
      snapshotId: requiredString(row, 'snapshot_id'),
      sourceRecordId: requiredString(row, 'source_record_id'),
      reason: requiredString(
        row,
        'reason'
      ) as NavaidSnapshotCandidate['exclusions'][number]['reason'],
    })),
    facilityVariationAudits: auditRows.map(row => ({
      snapshotId: requiredString(row, 'snapshot_id'),
      sourceRecordId: requiredString(row, 'source_record_id'),
      outcome: requiredString(
        row,
        'outcome'
      ) as NavaidSnapshotCandidate['facilityVariationAudits'][number]['outcome'],
      sourceIdentity: nullableString(row, 'source_identity'),
      auditRecord: requiredString(row, 'audit_record'),
    })),
  };
}

function validateDecodedSnapshot(
  snapshot: ReturnType<ProducerSchemaNavaidSnapshotCodec['decode']>,
  codec: ProducerSchemaNavaidSnapshotCodec
): void {
  const {metadata} = snapshot;
  if (
    metadata.retrievalCompletedAt < metadata.retrievedAt ||
    metadata.publishedAt < metadata.retrievalCompletedAt ||
    metadata.faaNasr.retrievedAt < metadata.retrievedAt ||
    metadata.faaNasr.retrievedAt > metadata.retrievalCompletedAt
  ) {
    throw invalid('Committed Navaid Snapshot retrieval timestamps do not reconcile.');
  }

  const checksums = [
    metadata.snapshotChecksum,
    ...Object.values(metadata.componentChecksums),
    metadata.faaNasr.archiveChecksum,
    metadata.faaNasr.contentChecksum,
    metadata.magneticModel.coefficientChecksum,
  ];
  if (checksums.some(checksumValue => !CHECKSUM_PATTERN.test(checksumValue))) {
    throw invalid('Committed Navaid Snapshot checksum metadata is invalid.');
  }

  const expectedMagneticModel = Wmm2025.wmm2025Provenance(
    metadata.retrievedAt.slice(0, 10)
  );
  if (
    metadata.magneticModel.model !== expectedMagneticModel.model ||
    metadata.magneticModel.version !== expectedMagneticModel.version ||
    metadata.magneticModel.epochYear !== expectedMagneticModel.epochYear ||
    metadata.magneticModel.referenceDate !== expectedMagneticModel.referenceDate ||
    metadata.magneticModel.source !== expectedMagneticModel.source ||
    metadata.magneticModel.coefficientChecksum !==
      expectedMagneticModel.coefficientChecksum
  ) {
    throw invalid('Committed magnetic model provenance does not reconcile.');
  }

  const rawIds = new Set<string>();
  for (const raw of snapshot.rawNavaids) {
    if (rawIds.has(raw.sourceRecordId)) {
      throw invalid('Committed raw Navaid identities do not reconcile.');
    }

    rawIds.add(raw.sourceRecordId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.canonicalRecord) as unknown;
    } catch {
      throw invalid('A committed raw Navaid canonical record is invalid.');
    }

    if (
      !isObject(parsed) ||
      canonicalizeJson(parsed) !== raw.canonicalRecord ||
      checksum(raw.canonicalRecord) !== raw.recordChecksum
    ) {
      throw invalid('A committed raw Navaid record checksum does not reconcile.');
    }
  }

  const partitionIds = new Set<string>();
  const databaseIds = new Set<string>();
  for (const navaid of snapshot.plannerNavaids) {
    const expectedDeclination = Wmm2025.localMagneticDeclinationFromWmm2025({
      referenceDate: metadata.magneticModel.referenceDate,
      longitude: navaid.longitude,
      latitude: navaid.latitude,
    });
    if (
      partitionIds.has(navaid.sourceRecordId) ||
      databaseIds.has(navaid.databaseId) ||
      !NAVAID_FAMILIES.has(navaid.family) ||
      !inRange(navaid.longitude, -180, 180, true) ||
      !inRange(navaid.latitude, -90, 90, true) ||
      navaid.frequencyValue <= 0 ||
      !['kHz', 'MHz'].includes(navaid.frequencyUnit) ||
      navaid.publishedRangeNm <= 0 ||
      navaid.magneticDeclinationDegEast !== expectedDeclination ||
      !validFacilityVariationColumns(navaid)
    ) {
      throw invalid('Committed planner-ready Navaid rows do not reconcile.');
    }

    partitionIds.add(navaid.sourceRecordId);
    databaseIds.add(navaid.databaseId);
  }

  for (const exclusion of snapshot.exclusions) {
    if (
      partitionIds.has(exclusion.sourceRecordId) ||
      !EXCLUSION_REASONS.has(exclusion.reason)
    ) {
      throw invalid('Committed Navaid exclusions do not reconcile.');
    }

    partitionIds.add(exclusion.sourceRecordId);
  }

  if (!sameSet(rawIds, partitionIds)) {
    throw invalid('Committed raw Navaids are not completely partitioned.');
  }

  const auditedIds = new Set<string>();
  const plannerBySource = new Map(
    snapshot.plannerNavaids.map(navaid => [navaid.sourceRecordId, navaid])
  );
  for (const audit of snapshot.facilityVariationAudits) {
    const navaid = plannerBySource.get(audit.sourceRecordId);
    if (
      auditedIds.has(audit.sourceRecordId) ||
      navaid === undefined ||
      navaid.family === 'NDB' ||
      !validAudit(audit, navaid, metadata)
    ) {
      throw invalid('Committed Facility Variation audits do not reconcile.');
    }

    auditedIds.add(audit.sourceRecordId);
  }

  const vorIds = new Set(
    snapshot.plannerNavaids
      .filter(navaid => navaid.family !== 'NDB')
      .map(navaid => navaid.sourceRecordId)
  );
  if (!sameSet(auditedIds, vorIds)) {
    throw invalid('Facility Variation audits do not reconcile with VOR-family Navaids.');
  }

  if (
    metadata.counts.rawNavaids !== snapshot.rawNavaids.length ||
    metadata.counts.plannerNavaids !== snapshot.plannerNavaids.length ||
    metadata.counts.exclusions !== snapshot.exclusions.length ||
    snapshot.plannerNavaids.length + snapshot.exclusions.length !==
      snapshot.rawNavaids.length
  ) {
    throw invalid('Committed Navaid Snapshot counts do not reconcile.');
  }

  const recomputed = codec.recomputeComponentChecksums(snapshot);
  if (
    Object.entries(recomputed).some(
      ([name, value]) =>
        metadata.componentChecksums[name as keyof typeof recomputed] !== value
    )
  ) {
    throw invalid('Committed Navaid Snapshot component checksums do not reconcile.');
  }

  // Version 1 did not persist FAA NASR publishedAt even though the aggregate
  // manifest included it. The aggregate digest therefore cannot be independently
  // reconstructed from committed storage; retaining it preserves v1 identity.
}

function validFacilityVariationColumns(
  navaid: NavaidSnapshotCandidate['plannerNavaids'][number]
): boolean {
  const absent =
    navaid.facilityVariationDegEast === null &&
    navaid.facilityVariationSource === null &&
    navaid.facilityVariationEffectiveDate === null;
  const present =
    navaid.family !== 'NDB' &&
    navaid.facilityVariationDegEast !== null &&
    inRange(navaid.facilityVariationDegEast, -180, 180, false) &&
    navaid.facilityVariationSource !== null &&
    navaid.facilityVariationSource.trim() !== '' &&
    (navaid.facilityVariationEffectiveDate === null ||
      DATE_PATTERN.test(navaid.facilityVariationEffectiveDate));
  return absent || present;
}

function validAudit(
  audit: NavaidSnapshotCandidate['facilityVariationAudits'][number],
  navaid: NavaidSnapshotCandidate['plannerNavaids'][number],
  metadata: ReturnType<ProducerSchemaNavaidSnapshotCodec['decode']>['metadata']
): boolean {
  const nasr = metadata.faaNasr;
  if (
    !AUDIT_OUTCOMES.has(audit.outcome) ||
    audit.matchingPolicyIdentity !== metadata.matchingPolicyIdentity ||
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
      audit.sourceIdentity === null &&
      audit.facilityVariationDegEast === null &&
      audit.facilityVariationEpochYear === null &&
      audit.faaRecordIdentity === null &&
      audit.faaFacilityIdentifier === null &&
      audit.faaFacilityType === null &&
      audit.faaLongitude === null &&
      audit.faaLatitude === null &&
      audit.faaFrequencyHz === null &&
      audit.rawMagneticVariation === null &&
      audit.rawMagneticVariationHemisphere === null &&
      audit.rawMagneticVariationEpochYear === null &&
      audit.separationNm === null &&
      navaid.facilityVariationDegEast === null &&
      navaid.facilityVariationSource === null &&
      navaid.facilityVariationEffectiveDate === null
    );
  }

  return (
    audit.sourceIdentity !== null &&
    audit.sourceIdentity === navaid.facilityVariationSource &&
    audit.facilityVariationDegEast === navaid.facilityVariationDegEast &&
    audit.facilityVariationDegEast !== null &&
    inRange(audit.facilityVariationDegEast, -180, 180, false) &&
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
    Number.isFinite(audit.separationNm) &&
    audit.separationNm >= 0 &&
    audit.separationNm <= 1 + 0.001 / 1852
  );
}

type CachedAirportStorage = CachedAirport & Readonly<{canonicalRecord: string}>;

async function readCachedAirports(
  connection: DuckDBConnection
): Promise<readonly CachedAirportStorage[]> {
  const result = await connection.runAndReadAll(`SELECT icao, database_id, name,
    longitude, latitude, CAST(canonical_record AS VARCHAR) AS canonical_record,
    record_checksum, source_identity, CAST(retrieved_at AS VARCHAR) AS retrieved_at,
    CAST(published_at AS VARCHAR) AS published_at
    FROM radial_producer.cached_airports ORDER BY icao`);
  return result.getRowObjectsJS().map(row => ({
    icao: requiredString(row, 'icao'),
    sourceId: requiredString(row, 'database_id'),
    name: requiredString(row, 'name'),
    longitude: number(row, 'longitude'),
    latitude: number(row, 'latitude'),
    canonicalRecord: requiredString(row, 'canonical_record'),
    recordChecksum: requiredString(row, 'record_checksum'),
    sourceIdentity: requiredString(row, 'source_identity'),
    retrievedAt: timestamp(row, 'retrieved_at'),
    publishedAt: timestamp(row, 'published_at'),
  }));
}

function validateCachedAirports(airports: readonly CachedAirportStorage[]): void {
  const sourceIds = new Set<string>();
  for (const airport of airports) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(airport.canonicalRecord) as unknown;
    } catch {
      throw invalid('A Cached Airport canonical record is invalid.');
    }

    if (
      sourceIds.has(airport.sourceId) ||
      !inRange(airport.longitude, -180, 180, true) ||
      !inRange(airport.latitude, -90, 90, true) ||
      !isObject(parsed) ||
      canonicalizeJson(parsed) !== airport.canonicalRecord ||
      checksum(airport.canonicalRecord) !== airport.recordChecksum ||
      airport.publishedAt < airport.retrievedAt
    ) {
      throw invalid('Committed Cached Airport rows do not reconcile.');
    }

    sourceIds.add(airport.sourceId);
  }
}

async function validatePlannerAirports(
  connection: DuckDBConnection,
  snapshotId: string,
  cachedAirports: readonly CachedAirportStorage[],
  snapshot: ReturnType<ProducerSchemaNavaidSnapshotCodec['decode']>
): Promise<void> {
  const projectionRows = await rows(
    connection,
    `SELECT icao, database_id, name, longitude, latitude,
       magnetic_declination_deg_east
     FROM radial_producer.planner_airports
     WHERE snapshot_id = CAST(? AS UUID) ORDER BY icao`,
    snapshotId
  );
  if (projectionRows.length !== cachedAirports.length) {
    throw invalid('Cached Airport planner projection counts do not reconcile.');
  }

  const airportByIcao = new Map(cachedAirports.map(airport => [airport.icao, airport]));
  for (const row of projectionRows) {
    const icao = requiredString(row, 'icao');
    const airport = airportByIcao.get(icao);
    if (airport === undefined) {
      throw invalid('A Cached Airport planner projection is orphaned.');
    }

    const longitude = number(row, 'longitude');
    const latitude = number(row, 'latitude');
    const expectedDeclination = Wmm2025.localMagneticDeclinationFromWmm2025({
      referenceDate: snapshot.metadata.magneticModel.referenceDate,
      longitude,
      latitude,
    });
    if (
      requiredString(row, 'database_id') !== airport.sourceId ||
      requiredString(row, 'name') !== airport.name ||
      longitude !== airport.longitude ||
      latitude !== airport.latitude ||
      nullableNumber(row, 'magnetic_declination_deg_east') !== expectedDeclination
    ) {
      throw invalid('A Cached Airport planner projection does not reconcile.');
    }
  }
}

function summarize(
  snapshot: ReturnType<ProducerSchemaNavaidSnapshotCodec['decode']>
): SnapshotSummary {
  const {metadata} = snapshot;
  const exclusionCounts = grouped(snapshot.exclusions.map(row => row.reason));
  const missingAudits = snapshot.facilityVariationAudits.filter(
    audit => audit.outcome !== 'matched'
  );
  return {
    snapshotId: metadata.snapshotId,
    snapshotChecksum: metadata.snapshotChecksum,
    componentChecksums: metadata.componentChecksums,
    retrievedAt: metadata.retrievedAt,
    retrievalCompletedAt: metadata.retrievalCompletedAt,
    publishedAt: metadata.publishedAt,
    sourceIdentity: metadata.sourceIdentity,
    derivationPolicyIdentity: metadata.derivationPolicyIdentity,
    matchingPolicyIdentity: metadata.matchingPolicyIdentity,
    nasr: metadata.faaNasr,
    magneticModel: metadata.magneticModel,
    rawNavaidCount: snapshot.rawNavaids.length,
    plannerNavaidCount: snapshot.plannerNavaids.length,
    vorFamilyNavaidCount: snapshot.plannerNavaids.filter(row => row.family !== 'NDB')
      .length,
    fallbackNavaidCount: snapshot.plannerNavaids.filter(row => row.family === 'NDB')
      .length,
    exclusionCount: snapshot.exclusions.length,
    exclusionCounts,
    facilityVariationPresentCount:
      snapshot.facilityVariationAudits.length - missingAudits.length,
    facilityVariationMissingCount: missingAudits.length,
    facilityVariationMissingReasons: grouped(missingAudits.map(row => row.outcome)),
    facilityVariationEpochYearMissingCount: snapshot.facilityVariationAudits.filter(
      audit => audit.outcome === 'matched' && audit.facilityVariationEpochYear === null
    ).length,
  };
}

function grouped(values: readonly string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({reason, count}));
}

async function rows(connection: DuckDBConnection, sql: string, value: string) {
  return (await connection.runAndReadAll(sql, [value])).getRowObjectsJS();
}

async function oneRow(
  connection: DuckDBConnection,
  sql: string,
  value: string,
  diagnostic: string
) {
  const result = await rows(connection, sql, value);
  if (result.length !== 1) throw invalid(diagnostic);
  return result[0]!;
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`Committed ${field} is unavailable.`);
  }

  return value;
}

function nullableString(row: Record<string, unknown>, field: string): string | null {
  return row[field] === null ? null : requiredString(row, field);
}

function number(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`Committed ${field} is invalid.`);
  }

  return value;
}

function positiveNumber(row: Record<string, unknown>, field: string): number {
  const value = number(row, field);
  if (value <= 0) throw invalid(`Committed ${field} is invalid.`);
  return value;
}

function nullableNumber(row: Record<string, unknown>, field: string): number | null {
  return row[field] === null ? null : number(row, field);
}

function nonNegativeInteger(row: Record<string, unknown>, field: string): number {
  const value = number(row, field);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`Committed ${field} is invalid.`);
  }

  return value;
}

function timestamp(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(`Committed ${field} is invalid.`);
  return parsed.toISOString();
}

function date(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(`Committed ${field} is invalid.`);
  }

  return value;
}

function nullableDate(row: Record<string, unknown>, field: string): string | null {
  return row[field] === null ? null : date(row, field);
}

function inRange(
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

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

class InvalidCommittedNavaidSnapshotError extends Error {}

function invalid(message: string): InvalidCommittedNavaidSnapshotError {
  return new InvalidCommittedNavaidSnapshotError(message);
}

function isInvalidCommittedNavaidSnapshotError(
  error: unknown
): error is InvalidCommittedNavaidSnapshotError {
  return error instanceof InvalidCommittedNavaidSnapshotError;
}

export default {
  inspect: inspectCommittedNavaidSnapshot,
  isInvalidError: isInvalidCommittedNavaidSnapshotError,
};
