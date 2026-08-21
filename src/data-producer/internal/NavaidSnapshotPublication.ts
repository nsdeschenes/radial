import {randomUUID} from 'node:crypto';

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import NavaidSnapshotPublicationError from '#radial/data-producer/internal/NavaidSnapshotPublicationError.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import type ValidatedNavaidSnapshotCandidate from '#radial/data-producer/internal/ValidatedNavaidSnapshotCandidate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025} = Wmm2025;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NavaidPublicationBoundary =
  | 'before-transaction'
  | 'before-transaction-start'
  | 'transaction-started'
  | 'candidate-write'
  | 'candidate-verified'
  | 'active-marker-changed'
  | 'before-commit';

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
  candidate: ValidatedNavaidSnapshotCandidate,
  publicationGate: PublicationGate,
  options: PublicationOptions = {}
): Promise<PublicationResult> {
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

export default publishNavaidSnapshot;
