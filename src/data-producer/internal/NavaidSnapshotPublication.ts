import {createHash, randomUUID} from 'node:crypto';

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import type buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import NavaidSnapshotPublicationError from '#radial/data-producer/internal/NavaidSnapshotPublicationError.js';
import NavaidSnapshotValidationError from '#radial/data-producer/internal/NavaidSnapshotValidationError.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025, wmm2025Provenance} = Wmm2025;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;

type NavaidSnapshotCandidate = ReturnType<typeof buildNavaidSnapshotCandidate>;

type NavaidPublicationBoundary =
  | 'before-transaction'
  | 'before-transaction-start'
  | 'transaction-started'
  | 'candidate-write'
  | 'candidate-verified'
  | 'active-marker-changed'
  | 'before-commit';

const MAXIMUM_FACILITY_MATCH_DISTANCE_NM = 1 + 0.001 / 1852;

type PublicationOptions = Readonly<{
  snapshotId?: string;
  publishedAt?: () => string;
  beforeCommit?: () => void | Promise<void>;
  onBoundary?: (boundary: NavaidPublicationBoundary) => void | Promise<void>;
  signal?: AbortSignal;
}>;

type PublicationResult = Readonly<{
  snapshotId: string;
  snapshotChecksum: string;
  rawNavaidCount: number;
  plannerNavaidCount: number;
  exclusionCount: number;
}>;

async function publishNavaidSnapshot(
  instance: DuckDBInstance,
  candidate: NavaidSnapshotCandidate,
  publicationGate: PublicationGate,
  options: PublicationOptions = {}
): Promise<PublicationResult> {
  abortableOperation.throwIfAborted(options.signal);
  try {
    validateCandidate(candidate);
  } catch (error) {
    throw new NavaidSnapshotValidationError(
      error instanceof Error ? error.message : 'Navaid Snapshot candidate is invalid.'
    );
  }

  abortableOperation.throwIfAborted(options.signal);
  const snapshotId = options.snapshotId ?? randomUUID();
  validateUuid(snapshotId);
  return publicationGate.run(
    () => publishNavaidSnapshotWithinGate(instance, candidate, snapshotId, options),
    options.signal
  );
}

async function publishNavaidSnapshotWithinGate(
  instance: DuckDBInstance,
  candidate: NavaidSnapshotCandidate,
  snapshotId: string,
  options: PublicationOptions
): Promise<PublicationResult> {
  abortableOperation.throwIfAborted(options.signal);
  let connection: DuckDBConnection | undefined;
  try {
    await options.onBoundary?.('before-transaction');
    connection = await instance.connect();
    await connection.run('LOAD spatial');
  } catch (error) {
    connection?.closeSync();
    if (abortableOperation.isAbortError(error)) {
      throw error;
    }

    throw new NavaidSnapshotPublicationError(
      true,
      error instanceof Error ? error.message : 'Navaid Snapshot publication failed.'
    );
  }

  if (connection === undefined) {
    throw new NavaidSnapshotPublicationError(true);
  }

  let commitStarted = false;
  let transactionStarted = false;

  try {
    try {
      await options.onBoundary?.('before-transaction-start');
      await connection.run('BEGIN TRANSACTION');
      transactionStarted = true;
      await options.onBoundary?.('transaction-started');
      abortableOperation.throwIfAborted(options.signal);
      const previousSnapshotId = await activeSnapshotId(connection);
      await insertCandidateRows(
        connection,
        snapshotId,
        candidate,
        options.signal,
        options.onBoundary
      );
      await regenerateAirportProjections(
        connection,
        snapshotId,
        candidate.provenance.magneticModel.referenceDate,
        options.signal
      );
      abortableOperation.throwIfAborted(options.signal);
      await verifyStoredCandidate(connection, snapshotId, candidate);
      await options.onBoundary?.('candidate-verified');

      const publishedAt = (options.publishedAt ?? (() => new Date().toISOString()))();
      validateTimestamp(publishedAt, 'publishedAt');
      await insertSnapshotMetadata(connection, snapshotId, candidate, publishedAt);
      await verifySnapshotMetadata(connection, snapshotId, candidate);
      await connection.run(
        `UPDATE radial_producer.producer_state
         SET active_navaid_snapshot_id = CAST(? AS UUID)
         WHERE singleton`,
        [snapshotId]
      );
      await options.onBoundary?.('active-marker-changed');
      abortableOperation.throwIfAborted(options.signal);
      await verifyActiveJoins(connection, snapshotId, candidate);
      if (previousSnapshotId !== null) {
        await removeSnapshot(connection, previousSnapshotId, options.signal);
      }

      await verifyNoCrossSnapshotReferences(connection);
      await options.beforeCommit?.();
      await options.onBoundary?.('before-commit');
      abortableOperation.throwIfAborted(options.signal);
      commitStarted = true;
      await connection.run('COMMIT');
    } catch (publicationError) {
      if (!transactionStarted) {
        throw new NavaidSnapshotPublicationError(
          true,
          publicationError instanceof Error
            ? publicationError.message
            : 'Navaid Snapshot publication failed.'
        );
      }

      try {
        await connection.run('ROLLBACK');
        throw new NavaidSnapshotPublicationError(
          !commitStarted,
          publicationError instanceof Error
            ? publicationError.message
            : 'Navaid Snapshot publication failed.'
        );
      } catch (rollbackError) {
        if (rollbackError instanceof NavaidSnapshotPublicationError) {
          throw rollbackError;
        }

        throw new NavaidSnapshotPublicationError(false);
      }
    }
  } finally {
    connection.closeSync();
  }

  return {
    snapshotId,
    snapshotChecksum: candidate.snapshotChecksum,
    rawNavaidCount: candidate.rawNavaids.length,
    plannerNavaidCount: candidate.plannerNavaids.length,
    exclusionCount: candidate.exclusions.length,
  };
}

function validateCandidate(candidate: NavaidSnapshotCandidate): void {
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

async function insertSnapshotMetadata(
  connection: DuckDBConnection,
  snapshotId: string,
  candidate: NavaidSnapshotCandidate,
  publishedAt: string
): Promise<void> {
  const magneticModel = candidate.provenance.magneticModel;
  await connection.run(
    `INSERT INTO radial_producer.navaid_snapshots (
      snapshot_id, snapshot_checksum, raw_navaids_checksum,
      planner_navaids_checksum, exclusions_checksum,
      facility_variation_audits_checksum, retrieved_at, retrieval_completed_at,
      published_at, source_identity, derivation_policy_identity,
      matching_policy_identity, nasr_source_url, nasr_retrieved_at,
      nasr_archive_identity, nasr_archive_checksum, nasr_content_checksum,
      nasr_cycle_id, nasr_effective_date, raw_navaid_count, planner_navaid_count,
      exclusion_count, magnetic_model, magnetic_model_version,
      magnetic_model_epoch_year, magnetic_reference_date, magnetic_model_source,
      magnetic_model_checksum
    ) VALUES (
      CAST(? AS UUID), ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ),
      CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?,
      CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?,
      CAST(? AS DATE), ?, ?
    )`,
    [
      snapshotId,
      candidate.snapshotChecksum,
      candidate.componentChecksums.rawNavaids,
      candidate.componentChecksums.plannerNavaids,
      candidate.componentChecksums.exclusions,
      candidate.componentChecksums.facilityVariationAudits,
      candidate.retrievedAt,
      candidate.retrievalCompletedAt,
      publishedAt,
      candidate.provenance.sourceIdentity,
      candidate.provenance.derivationPolicyIdentity,
      candidate.provenance.matchingPolicyIdentity,
      candidate.provenance.faaNasr.sourceUrl,
      candidate.provenance.faaNasr.retrievedAt,
      candidate.provenance.faaNasr.archiveIdentity,
      candidate.provenance.faaNasr.archiveChecksum,
      candidate.provenance.faaNasr.contentChecksum,
      candidate.provenance.faaNasr.cycleId,
      candidate.provenance.faaNasr.effectiveDate,
      candidate.rawNavaids.length,
      candidate.plannerNavaids.length,
      candidate.exclusions.length,
      magneticModel.model,
      magneticModel.version,
      magneticModel.epochYear,
      magneticModel.referenceDate,
      magneticModel.source,
      magneticModel.coefficientChecksum,
    ]
  );
}

async function insertCandidateRows(
  connection: DuckDBConnection,
  snapshotId: string,
  candidate: NavaidSnapshotCandidate,
  signal?: AbortSignal,
  onBoundary?: PublicationOptions['onBoundary']
): Promise<void> {
  for (const raw of candidate.rawNavaids) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.raw_navaids
       VALUES (CAST(? AS UUID), ?, CAST(? AS JSON), ?)`,
      [snapshotId, raw.sourceRecordId, raw.canonicalRecord, raw.recordChecksum]
    );
    await onBoundary?.('candidate-write');
  }

  for (const navaid of candidate.plannerNavaids) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.planner_navaids VALUES (
        CAST(? AS UUID), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS DATE)
      )`,
      [
        snapshotId,
        navaid.databaseId,
        navaid.sourceRecordId,
        navaid.identifier,
        navaid.name,
        navaid.family,
        navaid.longitude,
        navaid.latitude,
        navaid.frequencyValue,
        navaid.frequencyUnit,
        navaid.publishedRangeNm,
        navaid.magneticDeclinationDegEast,
        navaid.facilityVariationDegEast,
        navaid.facilityVariationSource,
        navaid.facilityVariationEffectiveDate,
      ]
    );
    await onBoundary?.('candidate-write');
  }

  for (const exclusion of candidate.exclusions) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.navaid_exclusions VALUES (CAST(? AS UUID), ?, ?)`,
      [snapshotId, exclusion.sourceRecordId, exclusion.reason]
    );
    await onBoundary?.('candidate-write');
  }

  for (const audit of candidate.facilityVariationAudits) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.facility_variation_audits
       VALUES (CAST(? AS UUID), ?, ?, ?, CAST(? AS JSON))`,
      [
        snapshotId,
        audit.sourceRecordId,
        audit.outcome,
        audit.sourceIdentity,
        canonicalizeJson(audit),
      ]
    );
    await onBoundary?.('candidate-write');
  }
}

async function regenerateAirportProjections(
  connection: DuckDBConnection,
  snapshotId: string,
  magneticReferenceDate: string,
  signal?: AbortSignal
): Promise<void> {
  const cachedAirports = await connection.runAndReadAll(
    `SELECT icao, database_id, name, longitude, latitude
     FROM radial_producer.cached_airports ORDER BY icao`
  );
  for (const airport of cachedAirports.getRowObjectsJS()) {
    abortableOperation.throwIfAborted(signal);
    const icao = airport['icao'];
    const databaseId = airport['database_id'];
    const name = airport['name'];
    const longitude = airport['longitude'];
    const latitude = airport['latitude'];
    if (
      typeof icao !== 'string' ||
      typeof databaseId !== 'string' ||
      typeof name !== 'string' ||
      typeof longitude !== 'number' ||
      typeof latitude !== 'number'
    ) {
      throw new Error('Cached Airport projection input is invalid');
    }

    const magneticDeclinationDegEast = localMagneticDeclinationFromWmm2025({
      referenceDate: magneticReferenceDate,
      longitude,
      latitude,
    });
    await connection.run(
      `INSERT INTO radial_producer.planner_airports
       VALUES (CAST(? AS UUID), ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        icao,
        databaseId,
        name,
        longitude,
        latitude,
        magneticDeclinationDegEast,
      ]
    );
  }
}

async function verifyStoredCandidate(
  connection: DuckDBConnection,
  snapshotId: string,
  candidate: NavaidSnapshotCandidate
): Promise<void> {
  const counts = await connection.runAndReadAll(
    `SELECT
      (SELECT count(*) FROM radial_producer.raw_navaids WHERE snapshot_id = CAST(? AS UUID)) AS raw_count,
      (SELECT count(*) FROM radial_producer.planner_navaids WHERE snapshot_id = CAST(? AS UUID)) AS planner_count,
      (SELECT count(*) FROM radial_producer.navaid_exclusions WHERE snapshot_id = CAST(? AS UUID)) AS exclusion_count,
      (SELECT count(*) FROM radial_producer.facility_variation_audits WHERE snapshot_id = CAST(? AS UUID)) AS audit_count,
      (SELECT count(*) FROM radial_producer.planner_airports WHERE snapshot_id = CAST(? AS UUID)) AS airport_count,
      (SELECT count(*) FROM radial_producer.cached_airports) AS cached_airport_count`,
    [snapshotId, snapshotId, snapshotId, snapshotId, snapshotId]
  );
  const row = counts.getRowObjectsJS()[0];
  if (
    Number(row?.['raw_count']) !== candidate.rawNavaids.length ||
    Number(row?.['planner_count']) !== candidate.plannerNavaids.length ||
    Number(row?.['exclusion_count']) !== candidate.exclusions.length ||
    Number(row?.['audit_count']) !== candidate.facilityVariationAudits.length ||
    Number(row?.['airport_count']) !== Number(row?.['cached_airport_count'])
  ) {
    throw new Error('stored candidate counts do not reconcile');
  }

  const storedAudits = await connection.runAndReadAll(
    `SELECT CAST(audit_record AS VARCHAR) AS audit_record
     FROM radial_producer.facility_variation_audits
     WHERE snapshot_id = CAST(? AS UUID)
     ORDER BY source_record_id`,
    [snapshotId]
  );
  const actualAuditRecords = storedAudits
    .getRowObjectsJS()
    .map(stored => requireString(stored['audit_record'], 'audit_record'));
  const expectedAuditRecords = candidate.facilityVariationAudits.map(audit =>
    canonicalizeJson(audit)
  );
  if (actualAuditRecords.join('\n') !== expectedAuditRecords.join('\n')) {
    throw new Error('stored Facility Variation provenance does not reconcile');
  }
}

async function verifySnapshotMetadata(
  connection: DuckDBConnection,
  snapshotId: string,
  candidate: NavaidSnapshotCandidate
): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT
      nasr_source_url,
      nasr_archive_identity,
      nasr_archive_checksum,
      nasr_content_checksum,
      nasr_cycle_id,
      CAST(nasr_effective_date AS VARCHAR) AS nasr_effective_date
     FROM radial_producer.navaid_snapshots
     WHERE snapshot_id = CAST(? AS UUID)`,
    [snapshotId]
  );
  const row = reader.getRowObjectsJS()[0];
  const expected = candidate.provenance.faaNasr;
  if (
    reader.getRowObjectsJS().length !== 1 ||
    row?.['nasr_source_url'] !== expected.sourceUrl ||
    row?.['nasr_archive_identity'] !== expected.archiveIdentity ||
    row?.['nasr_archive_checksum'] !== expected.archiveChecksum ||
    row?.['nasr_content_checksum'] !== expected.contentChecksum ||
    row?.['nasr_cycle_id'] !== expected.cycleId ||
    row?.['nasr_effective_date'] !== expected.effectiveDate
  ) {
    throw new Error('stored FAA NASR provenance does not reconcile');
  }
}

async function verifyActiveJoins(
  connection: DuckDBConnection,
  snapshotId: string,
  candidate: NavaidSnapshotCandidate
): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT
      (SELECT count(*) FROM planner_navaids) AS planner_count,
      (SELECT count(*) FROM planner_metadata) AS metadata_count,
      (SELECT count(*) FROM planner_airports) AS airport_count,
      (SELECT count(*) FROM radial_producer.planner_airports WHERE snapshot_id = CAST(? AS UUID)) AS expected_airport_count`,
    [snapshotId]
  );
  const row = reader.getRowObjectsJS()[0];
  if (
    Number(row?.['planner_count']) !== candidate.plannerNavaids.length ||
    Number(row?.['metadata_count']) !== 1 ||
    Number(row?.['airport_count']) !== Number(row?.['expected_airport_count'])
  ) {
    throw new Error('active planner joins do not reconcile');
  }
}

async function verifyNoCrossSnapshotReferences(
  connection: DuckDBConnection
): Promise<void> {
  const reader = await connection.runAndReadAll(`
    SELECT count(*) AS orphan_count FROM (
      SELECT snapshot_id FROM radial_producer.raw_navaids
      UNION ALL SELECT snapshot_id FROM radial_producer.planner_navaids
      UNION ALL SELECT snapshot_id FROM radial_producer.navaid_exclusions
      UNION ALL SELECT snapshot_id FROM radial_producer.facility_variation_audits
      UNION ALL SELECT snapshot_id FROM radial_producer.planner_airports
    ) AS children
    ANTI JOIN radial_producer.navaid_snapshots AS snapshots USING (snapshot_id)
  `);
  if (Number(reader.getRowObjectsJS()[0]?.['orphan_count']) !== 0) {
    throw new Error('cross-snapshot references do not reconcile');
  }
}

async function activeSnapshotId(connection: DuckDBConnection): Promise<string | null> {
  const reader = await connection.runAndReadAll(`
    SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS snapshot_id
    FROM radial_producer.producer_state WHERE singleton
  `);
  const value = reader.getRowObjectsJS()[0]?.['snapshot_id'];
  return typeof value === 'string' ? value : null;
}

async function removeSnapshot(
  connection: DuckDBConnection,
  snapshotId: string,
  signal?: AbortSignal
): Promise<void> {
  for (const table of [
    'raw_navaids',
    'planner_navaids',
    'navaid_exclusions',
    'facility_variation_audits',
    'planner_airports',
  ]) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `DELETE FROM radial_producer.${table} WHERE snapshot_id = CAST(? AS UUID)`,
      [snapshotId]
    );
  }

  await connection.run(
    `DELETE FROM radial_producer.navaid_snapshots WHERE snapshot_id = CAST(? AS UUID)`,
    [snapshotId]
  );
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

function validateUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error('snapshotId must be an opaque UUID.');
  }
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp.`);
  }
}

function validChecksum(value: string): boolean {
  return SHA256_CHECKSUM_PATTERN.test(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export default publishNavaidSnapshot;
