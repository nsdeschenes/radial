import {randomUUID} from 'node:crypto';

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import NavaidSnapshotPublicationError from '#radial/data-producer/internal/NavaidSnapshotPublicationError.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import producerSchemaNavaidSnapshotCodec from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCodec.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import type ValidatedNavaidSnapshotCandidate from '#radial/data-producer/internal/ValidatedNavaidSnapshotCandidate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025} = Wmm2025;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NavaidSnapshotStorageRows = ReturnType<
  typeof producerSchemaNavaidSnapshotCodec.encodeRows
>;
type SnapshotMetadataStorageRow = ReturnType<
  typeof producerSchemaNavaidSnapshotCodec.encodeMetadata
>;

type NavaidPublicationBoundary =
  | 'gate-acquired'
  | 'before-connection-acquisition'
  | 'connection-acquired'
  | 'before-transaction-start'
  | 'transaction-started'
  | 'before-candidate-write'
  | 'candidate-written'
  | 'candidate-verified'
  | 'active-marker-replaced'
  | 'before-old-snapshot-removal'
  | 'old-snapshot-removed'
  | 'before-commit'
  | 'commit-started'
  | 'rollback-started';

type PublicationOptions = Readonly<{
  snapshotId?: string;
  publishedAt?: () => string;
  beforeCommit?: () => void | Promise<void>;
  onBoundary?: (boundary: NavaidPublicationBoundary) => void | Promise<void>;
  signal?: AbortSignal;
}>;

type PublicationReceipt = Readonly<{
  snapshotId: string;
  snapshotChecksum: string;
  componentChecksums: NavaidSnapshotCandidate['componentChecksums'];
  publishedAt: string;
  rawNavaidCount: number;
  plannerNavaidCount: number;
  vorFamilyNavaidCount: number;
  fallbackNavaidCount: number;
  exclusionCount: number;
  exclusionCounts: readonly Readonly<{reason: string; count: number}>[];
  facilityVariationPresentCount: number;
  facilityVariationMissingCount: number;
  facilityVariationEpochYearMissingCount: number;
}>;

type PublicationPrecondition = Readonly<
  | {kind: 'absent'}
  | {
      kind: 'current';
      activeNavaidSnapshotId: string | null;
      snapshot: PublicationReceipt | null;
    }
  | {kind: 'invalid'; diagnostic: string}
>;

async function publishNavaidSnapshot(
  instance: DuckDBInstance,
  candidate: ValidatedNavaidSnapshotCandidate,
  publicationGate: PublicationGate,
  inspectPrecondition: (connection: DuckDBConnection) => Promise<PublicationPrecondition>,
  options: PublicationOptions = {}
): Promise<PublicationReceipt> {
  abortableOperation.throwIfAborted(options.signal);
  const snapshotId = options.snapshotId ?? randomUUID();
  validateUuid(snapshotId);
  return publicationGate.run(
    () =>
      publishNavaidSnapshotWithinGate(
        instance,
        candidate,
        snapshotId,
        inspectPrecondition,
        options
      ),
    options.signal
  );
}

async function publishNavaidSnapshotWithinGate(
  instance: DuckDBInstance,
  candidate: NavaidSnapshotCandidate,
  snapshotId: string,
  inspectPrecondition: (connection: DuckDBConnection) => Promise<PublicationPrecondition>,
  options: PublicationOptions
): Promise<PublicationReceipt> {
  abortableOperation.throwIfAborted(options.signal);
  let connection: DuckDBConnection | undefined;
  try {
    await options.onBoundary?.('gate-acquired');
    await options.onBoundary?.('before-connection-acquisition');
    connection = await instance.connect();
    await connection.run('LOAD spatial');
    await options.onBoundary?.('connection-acquired');
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
  let receipt: PublicationReceipt | undefined;

  try {
    try {
      await options.onBoundary?.('before-transaction-start');
      await connection.run('BEGIN TRANSACTION');
      transactionStarted = true;
      await options.onBoundary?.('transaction-started');
      abortableOperation.throwIfAborted(options.signal);
      const precondition = await inspectPrecondition(connection);
      if (precondition.kind === 'absent') {
        throw new Error('Producer Schema must be prepared before publication.');
      }

      if (precondition.kind === 'invalid') {
        throw new Error(
          `Producer Schema cannot publish over invalid committed state: ${precondition.diagnostic}`
        );
      }

      const storageRows = producerSchemaNavaidSnapshotCodec.encodeRows(
        candidate,
        snapshotId
      );
      const previousSnapshotId = await activeSnapshotId(connection);
      await options.onBoundary?.('before-candidate-write');
      await insertCandidateRows(connection, storageRows, options.signal);
      await regenerateAirportProjections(
        connection,
        snapshotId,
        candidate.provenance.magneticModel.referenceDate,
        options.signal
      );
      await options.onBoundary?.('candidate-written');
      abortableOperation.throwIfAborted(options.signal);
      await verifyStoredCandidate(connection, snapshotId, candidate, storageRows);
      await options.onBoundary?.('candidate-verified');

      const publishedAt = (options.publishedAt ?? (() => new Date().toISOString()))();
      validateTimestamp(publishedAt, 'publishedAt');
      const metadata = producerSchemaNavaidSnapshotCodec.encodeMetadata(
        candidate,
        snapshotId,
        publishedAt
      );
      await insertSnapshotMetadata(connection, metadata);
      await verifySnapshotMetadata(connection, snapshotId, candidate);
      await connection.run(
        `UPDATE radial_producer.producer_state
         SET active_navaid_snapshot_id = CAST(? AS UUID)
         WHERE singleton`,
        [snapshotId]
      );
      await options.onBoundary?.('active-marker-replaced');
      abortableOperation.throwIfAborted(options.signal);
      await verifyActiveJoins(connection, snapshotId, candidate);
      if (previousSnapshotId !== null) {
        await options.onBoundary?.('before-old-snapshot-removal');
        await removeSnapshot(connection, previousSnapshotId, options.signal);
        await options.onBoundary?.('old-snapshot-removed');
      }

      await verifyNoCrossSnapshotReferences(connection);
      const committedState = await inspectPrecondition(connection);
      if (
        committedState.kind !== 'current' ||
        committedState.activeNavaidSnapshotId !== snapshotId ||
        committedState.snapshot?.snapshotId !== snapshotId
      ) {
        throw new Error('committed Navaid Snapshot does not reconcile');
      }

      receipt = publicationReceipt(committedState.snapshot);
      await options.beforeCommit?.();
      await options.onBoundary?.('before-commit');
      abortableOperation.throwIfAborted(options.signal);
      commitStarted = true;
      await options.onBoundary?.('commit-started');
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
        await options.onBoundary?.('rollback-started');
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

  if (receipt === undefined) {
    throw new NavaidSnapshotPublicationError(false);
  }

  return receipt;
}

function publicationReceipt(snapshot: PublicationReceipt): PublicationReceipt {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotChecksum: snapshot.snapshotChecksum,
    componentChecksums: snapshot.componentChecksums,
    publishedAt: snapshot.publishedAt,
    rawNavaidCount: snapshot.rawNavaidCount,
    plannerNavaidCount: snapshot.plannerNavaidCount,
    vorFamilyNavaidCount: snapshot.vorFamilyNavaidCount,
    fallbackNavaidCount: snapshot.fallbackNavaidCount,
    exclusionCount: snapshot.exclusionCount,
    exclusionCounts: snapshot.exclusionCounts,
    facilityVariationPresentCount: snapshot.facilityVariationPresentCount,
    facilityVariationMissingCount: snapshot.facilityVariationMissingCount,
    facilityVariationEpochYearMissingCount:
      snapshot.facilityVariationEpochYearMissingCount,
  };
}

async function insertSnapshotMetadata(
  connection: DuckDBConnection,
  metadata: SnapshotMetadataStorageRow
): Promise<void> {
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
      metadata.snapshotId,
      metadata.snapshotChecksum,
      metadata.rawNavaidsChecksum,
      metadata.plannerNavaidsChecksum,
      metadata.exclusionsChecksum,
      metadata.facilityVariationAuditsChecksum,
      metadata.retrievedAt,
      metadata.retrievalCompletedAt,
      metadata.publishedAt,
      metadata.sourceIdentity,
      metadata.derivationPolicyIdentity,
      metadata.matchingPolicyIdentity,
      metadata.nasrSourceUrl,
      metadata.nasrRetrievedAt,
      metadata.nasrArchiveIdentity,
      metadata.nasrArchiveChecksum,
      metadata.nasrContentChecksum,
      metadata.nasrCycleId,
      metadata.nasrEffectiveDate,
      metadata.rawNavaidCount,
      metadata.plannerNavaidCount,
      metadata.exclusionCount,
      metadata.magneticModel,
      metadata.magneticModelVersion,
      metadata.magneticModelEpochYear,
      metadata.magneticReferenceDate,
      metadata.magneticModelSource,
      metadata.magneticModelChecksum,
    ]
  );
}

async function insertCandidateRows(
  connection: DuckDBConnection,
  storage: NavaidSnapshotStorageRows,
  signal?: AbortSignal
): Promise<void> {
  for (const raw of storage.rawNavaids) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.raw_navaids
       VALUES (CAST(? AS UUID), ?, CAST(? AS JSON), ?)`,
      [raw.snapshotId, raw.sourceRecordId, raw.canonicalRecord, raw.recordChecksum]
    );
  }

  for (const navaid of storage.plannerNavaids) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.planner_navaids VALUES (
        CAST(? AS UUID), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS DATE)
      )`,
      [
        navaid.snapshotId,
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
  }

  for (const exclusion of storage.exclusions) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.navaid_exclusions VALUES (CAST(? AS UUID), ?, ?)`,
      [exclusion.snapshotId, exclusion.sourceRecordId, exclusion.reason]
    );
  }

  for (const audit of storage.facilityVariationAudits) {
    abortableOperation.throwIfAborted(signal);
    await connection.run(
      `INSERT INTO radial_producer.facility_variation_audits
       VALUES (CAST(? AS UUID), ?, ?, ?, CAST(? AS JSON))`,
      [
        audit.snapshotId,
        audit.sourceRecordId,
        audit.outcome,
        audit.sourceIdentity,
        audit.auditRecord,
      ]
    );
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
  candidate: NavaidSnapshotCandidate,
  storage: NavaidSnapshotStorageRows
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
  const expectedAuditRecords = storage.facilityVariationAudits.map(
    audit => audit.auditRecord
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
