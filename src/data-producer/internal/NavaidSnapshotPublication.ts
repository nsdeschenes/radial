import {createHash, randomUUID} from 'node:crypto';

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import type buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';

type NavaidSnapshotCandidate = ReturnType<typeof buildNavaidSnapshotCandidate>;

type PublicationOptions = Readonly<{
  snapshotId?: string;
  publishedAt?: () => string;
  beforeCommit?: () => void | Promise<void>;
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
  options: PublicationOptions = {}
): Promise<PublicationResult> {
  validateCandidate(candidate);
  const snapshotId = options.snapshotId ?? randomUUID();
  validateUuid(snapshotId);
  const connection = await instance.connect();

  try {
    await connection.run('BEGIN TRANSACTION');
    try {
      const previousSnapshotId = await activeSnapshotId(connection);
      await insertCandidateRows(connection, snapshotId, candidate);
      await regenerateAirportProjections(connection, snapshotId);
      await verifyStoredCandidate(connection, snapshotId, candidate);

      const publishedAt = (options.publishedAt ?? (() => new Date().toISOString()))();
      validateTimestamp(publishedAt, 'publishedAt');
      await insertSnapshotMetadata(connection, snapshotId, candidate, publishedAt);
      await connection.run(
        `UPDATE radial_producer.producer_state
         SET active_navaid_snapshot_id = CAST(? AS UUID)
         WHERE singleton`,
        [snapshotId]
      );
      await verifyActiveJoins(connection, snapshotId, candidate);
      if (previousSnapshotId !== null) {
        await removeSnapshot(connection, previousSnapshotId);
      }
      await verifyNoCrossSnapshotReferences(connection);
      await options.beforeCommit?.();
      await connection.run('COMMIT');
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
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
    if (
      partitionIdentities.has(navaid.sourceRecordId) ||
      databaseIdentities.has(navaid.databaseId) ||
      !validPlannerNavaid(navaid)
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
    candidate.plannerNavaids.map(navaid => navaid.sourceRecordId)
  );
  if (
    auditIdentities.size !== candidate.facilityVariationAudits.length ||
    !sameSet(auditIdentities, plannerIdentities)
  ) {
    throw new Error('candidate Facility Variation audit partition does not reconcile');
  }

  const expectedComponentChecksums = {
    rawNavaids: checksum(canonicalizeJson(candidate.rawNavaids)),
    plannerNavaids: checksum(canonicalizeJson(candidate.plannerNavaids)),
    exclusions: checksum(canonicalizeJson(candidate.exclusions)),
    facilityVariationAudits: checksum(
      canonicalizeJson(candidate.facilityVariationAudits)
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
      provenance: candidate.provenance,
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

function validateProvenance(candidate: NavaidSnapshotCandidate): void {
  const provenance = candidate.provenance;
  const requiredStrings = [
    provenance.sourceIdentity,
    provenance.derivationPolicyIdentity,
    provenance.matchingPolicyIdentity,
    provenance.magneticModel.model,
    provenance.magneticModel.version,
    provenance.magneticModel.source,
  ];
  if (requiredStrings.some(value => value.trim() === '')) {
    throw new Error('candidate provenance bundle is incomplete');
  }
  if (
    !Number.isFinite(provenance.magneticModel.epochYear) ||
    provenance.magneticModel.epochYear <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(provenance.magneticModel.referenceDate) ||
    !validChecksum(provenance.magneticModel.coefficientChecksum)
  ) {
    throw new Error('candidate magnetic provenance bundle is invalid');
  }
}

function validPlannerNavaid(
  navaid: NavaidSnapshotCandidate['plannerNavaids'][number]
): boolean {
  const variationBundle = [
    navaid.facilityVariationDegEast,
    navaid.facilityVariationSource,
    navaid.facilityVariationEffectiveDate,
  ];
  const variationPresent = variationBundle.filter(value => value !== null).length;
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
    (variationPresent === 0 ||
      (variationPresent === 3 &&
        navaid.facilityVariationDegEast !== null &&
        finiteInRange(navaid.facilityVariationDegEast, -180, 180, false)))
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
      matching_policy_identity, raw_navaid_count, planner_navaid_count,
      exclusion_count, magnetic_model, magnetic_model_version,
      magnetic_model_epoch_year, magnetic_reference_date, magnetic_model_source,
      magnetic_model_checksum
    ) VALUES (
      CAST(? AS UUID), ?, ?, ?, ?, ?, CAST(? AS TIMESTAMPTZ),
      CAST(? AS TIMESTAMPTZ), CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
  candidate: NavaidSnapshotCandidate
): Promise<void> {
  for (const raw of candidate.rawNavaids) {
    await connection.run(
      `INSERT INTO radial_producer.raw_navaids
       VALUES (CAST(? AS UUID), ?, CAST(? AS JSON), ?)`,
      [snapshotId, raw.sourceRecordId, raw.canonicalRecord, raw.recordChecksum]
    );
  }
  for (const navaid of candidate.plannerNavaids) {
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
  }
  for (const exclusion of candidate.exclusions) {
    await connection.run(
      `INSERT INTO radial_producer.navaid_exclusions VALUES (CAST(? AS UUID), ?, ?)`,
      [snapshotId, exclusion.sourceRecordId, exclusion.reason]
    );
  }
  for (const audit of candidate.facilityVariationAudits) {
    await connection.run(
      `INSERT INTO radial_producer.facility_variation_audits
       VALUES (CAST(? AS UUID), ?, ?, ?)`,
      [snapshotId, audit.sourceRecordId, audit.outcome, audit.sourceIdentity]
    );
  }
}

async function regenerateAirportProjections(
  connection: DuckDBConnection,
  snapshotId: string
): Promise<void> {
  await connection.run(
    `INSERT INTO radial_producer.planner_airports
     SELECT CAST(? AS UUID), icao, database_id, name, longitude, latitude, NULL
     FROM radial_producer.cached_airports
     ORDER BY icao`,
    [snapshotId]
  );
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
  snapshotId: string
): Promise<void> {
  for (const table of [
    'raw_navaids',
    'planner_navaids',
    'navaid_exclusions',
    'facility_variation_audits',
    'planner_airports',
  ]) {
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error('snapshotId must be an opaque UUID.');
  }
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp.`);
  }
}

function validChecksum(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export default publishNavaidSnapshot;
