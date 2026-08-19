import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import type {DuckDBConnection} from '@duckdb/node-api';
import * as Sentry from '@sentry/node';

import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import isDuckDBBusyError from '#radial/db/duckdb/isDuckDBBusyError.js';
import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';

type DataStatusResult = RadialApplicationTypes['DataStatusResult'];
type DataStatusSuccess = RadialApplicationTypes['DataStatusSuccess'];
type DataStatusCachedAirport = RadialApplicationTypes['DataStatusCachedAirport'];
type DataStatusExclusionCount = Readonly<{reason: string; count: number}>;

const LEGACY_TABLE_NAMES = [
  'airports',
  'airspaces',
  'hotspots',
  'navaids',
  'obstacles',
  'reporting_points',
] as const;

function readDataStatus(databasePath: string): Promise<DataStatusResult> {
  return Sentry.startSpan({name: 'Read data status', op: 'task'}, () =>
    readDataStatusWithinSpan(databasePath)
  );
}

async function readDataStatusWithinSpan(
  databasePath: string
): Promise<DataStatusResult> {
  if (databasePath.trim() === '') {
    return failure(
      'DATA_DATABASE_PATH_MISSING',
      'Database path is missing.',
      'RADIAL_DATABASE_PATH is required for data status.',
      'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.'
    );
  }

  const displayPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (databasePath === ':memory:') {
    return success(uninitializedStatus(displayPath, []));
  }

  let databaseExists: boolean;
  try {
    databaseExists = (await stat(databasePath)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return success(uninitializedStatus(displayPath, []));
    }

    return failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'The configured database path could not be inspected.',
      'Check RADIAL_DATABASE_PATH and retry.'
    );
  }

  if (!databaseExists) {
    return failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'The configured database path is not a regular file.',
      'Set RADIAL_DATABASE_PATH to a DuckDB database file and retry.'
    );
  }

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(databasePath, {access_mode: 'READ_ONLY'});
  } catch (error) {
    if (isDuckDBBusyError(error)) {
      return failure(
        'DATA_DATABASE_BUSY',
        'The configured database is busy.',
        'Another process owns the native DuckDB database file.',
        'Route the operation through the owning process or obtain exclusive maintenance access.'
      );
    }

    return failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'The existing database could not be opened for read-only inspection.',
      'Check database availability and retry.'
    );
  }

  try {
    return await readDataStatusFromInstance(instance, displayPath);
  } finally {
    instance.closeSync();
  }
}

async function readDataStatusFromInstance(
  instance: DuckDBInstance,
  databasePath: string
): Promise<DataStatusResult> {
  let connection: DuckDBConnection;
  try {
    connection = await instance.connect();
  } catch (error) {
    if (isDuckDBBusyError(error)) {
      return failure(
        'DATA_DATABASE_BUSY',
        'The configured database is busy.',
        'Another process owns the native DuckDB database file.',
        'Route the operation through the owning process or obtain exclusive maintenance access.'
      );
    }

    return failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'A read-only status connection could not be opened.',
      'Check database availability and retry.'
    );
  }

  try {
    try {
      return success(await inspectStatus(connection, databasePath));
    } catch (error) {
      if (error instanceof InvalidDataStatusError) {
        return failure(
          'DATA_DATABASE_INVALID',
          'The configured database is invalid.',
          error.message,
          'Inspect the configured database and retry with a valid Radial database.'
        );
      }

      if (isDuckDBBusyError(error)) {
        return failure(
          'DATA_DATABASE_BUSY',
          'The configured database is busy.',
          'Another process owns the native DuckDB database file.',
          'Route the operation through the owning process or obtain exclusive maintenance access.'
        );
      }

      return failure(
        'DATA_DATABASE_UNAVAILABLE',
        'The configured database is unavailable.',
        'The committed data status could not be read.',
        'Check database availability and retry.'
      );
    }
  } finally {
    connection.closeSync();
  }
}

async function inspectStatus(
  connection: DuckDBConnection,
  databasePath: string
): Promise<DataStatusSuccess> {
  const schema = await initializeProducerSchema.inspect(connection);
  const legacyObjects = await readLegacyObjects(connection);

  if (schema.kind === 'absent') {
    if (await plannerDatabaseContract.hasAnyReservedRelation(connection)) {
      throw new InvalidDataStatusError(
        'The Producer Schema is absent while a planner view name is already in use.'
      );
    }

    return uninitializedStatus(databasePath, legacyObjects);
  }

  if (schema.kind === 'invalid') {
    throw new InvalidDataStatusError('The Producer Schema is incomplete or invalid.');
  }

  const state = await readProducerState(connection);
  const cachedAirports = await readCachedAirports(connection);
  const producerSchema = {
    producerSchemaVersion: schema.producerSchemaVersion,
    plannerContractVersion: schema.plannerContractVersion,
    checksumManifestVersion: schema.checksumManifestVersion,
  } as const;

  if (state.activeSnapshotId === null) {
    return {
      databasePath,
      status: 'uninitialized',
      legacyObjects,
      producerSchema,
      snapshot: null,
      cachedAirports,
    };
  }

  const snapshot = await readSnapshot(connection, state.activeSnapshotId);
  return {
    databasePath,
    status: 'ready',
    legacyObjects,
    producerSchema,
    snapshot,
    cachedAirports,
  };
}

async function readProducerState(
  connection: DuckDBConnection
): Promise<Readonly<{activeSnapshotId: string | null}>> {
  const result = await connection.runAndReadAll(`
    SELECT
      singleton,
      CAST(active_navaid_snapshot_id AS VARCHAR) AS active_snapshot_id
    FROM radial_producer.producer_state
  `);
  const rows = result.getRowObjectsJS();
  if (rows.length !== 1 || rows[0]?.['singleton'] !== true) {
    throw new InvalidDataStatusError(
      'The Producer Schema state must contain exactly one singleton row.'
    );
  }

  const activeSnapshotId = rows[0]?.['active_snapshot_id'];
  if (activeSnapshotId !== null && typeof activeSnapshotId !== 'string') {
    throw new InvalidDataStatusError('The active Navaid Snapshot marker is invalid.');
  }

  return {activeSnapshotId};
}

async function readSnapshot(
  connection: DuckDBConnection,
  snapshotId: string
): Promise<NonNullable<DataStatusSuccess['snapshot']>> {
  const metadata = await connection.runAndReadAll(
    `SELECT
       CAST(snapshot_id AS VARCHAR) AS snapshot_id,
       snapshot_checksum,
       raw_navaids_checksum,
       planner_navaids_checksum,
       exclusions_checksum,
       facility_variation_audits_checksum,
       CAST(retrieved_at AS VARCHAR) AS retrieved_at,
       CAST(retrieval_completed_at AS VARCHAR) AS retrieval_completed_at,
       CAST(published_at AS VARCHAR) AS published_at,
       source_identity,
       derivation_policy_identity,
       matching_policy_identity,
       nasr_source_url,
       CAST(nasr_retrieved_at AS VARCHAR) AS nasr_retrieved_at,
       nasr_archive_identity,
       nasr_archive_checksum,
       nasr_content_checksum,
       nasr_cycle_id,
       CAST(nasr_effective_date AS VARCHAR) AS nasr_effective_date,
       raw_navaid_count,
       planner_navaid_count,
       exclusion_count,
       magnetic_model,
       magnetic_model_version,
       magnetic_model_epoch_year,
       CAST(magnetic_reference_date AS VARCHAR) AS magnetic_reference_date,
       magnetic_model_source,
       magnetic_model_checksum
     FROM radial_producer.navaid_snapshots
     WHERE snapshot_id = CAST(? AS UUID)`,
    [snapshotId]
  );
  const rows = metadata.getRowObjectsJS();
  if (rows.length !== 1) {
    throw new InvalidDataStatusError(
      'The active Navaid Snapshot marker does not identify exactly one snapshot.'
    );
  }

  const row = rows[0]!;
  const rawNavaidCount = nonNegativeInteger(row['raw_navaid_count'], 'raw Navaid count');
  const plannerNavaidCount = nonNegativeInteger(
    row['planner_navaid_count'],
    'planner Navaid count'
  );
  const exclusionCount = nonNegativeInteger(row['exclusion_count'], 'exclusion count');
  const snapshotMetadata = {
    snapshotId: requiredString(row, 'snapshot_id'),
    snapshotChecksum: requiredString(row, 'snapshot_checksum'),
    componentChecksums: {
      rawNavaids: requiredString(row, 'raw_navaids_checksum'),
      plannerNavaids: requiredString(row, 'planner_navaids_checksum'),
      exclusions: requiredString(row, 'exclusions_checksum'),
      facilityVariationAudits: requiredString(row, 'facility_variation_audits_checksum'),
    },
    retrievedAt: canonicalTimestamp(row, 'retrieved_at'),
    retrievalCompletedAt: canonicalTimestamp(row, 'retrieval_completed_at'),
    publishedAt: canonicalTimestamp(row, 'published_at'),
    sourceIdentity: requiredString(row, 'source_identity'),
    derivationPolicyIdentity: requiredString(row, 'derivation_policy_identity'),
    matchingPolicyIdentity: requiredString(row, 'matching_policy_identity'),
    nasr: {
      sourceUrl: requiredString(row, 'nasr_source_url'),
      retrievedAt: canonicalTimestamp(row, 'nasr_retrieved_at'),
      archiveIdentity: requiredString(row, 'nasr_archive_identity'),
      archiveChecksum: requiredString(row, 'nasr_archive_checksum'),
      contentChecksum: requiredString(row, 'nasr_content_checksum'),
      cycleId: requiredString(row, 'nasr_cycle_id'),
      effectiveDate: requiredString(row, 'nasr_effective_date'),
    },
    magneticModel: {
      model: requiredString(row, 'magnetic_model'),
      version: requiredString(row, 'magnetic_model_version'),
      epochYear: finiteNumber(row['magnetic_model_epoch_year'], 'magnetic model epoch'),
      referenceDate: requiredString(row, 'magnetic_reference_date'),
      source: requiredString(row, 'magnetic_model_source'),
      coefficientChecksum: requiredString(row, 'magnetic_model_checksum'),
    },
    rawNavaidCount,
    plannerNavaidCount,
    vorFamilyNavaidCount: 0,
    fallbackNavaidCount: 0,
    exclusionCount,
    exclusionCounts: [],
    facilityVariationPresentCount: 0,
    facilityVariationMissingCount: 0,
    facilityVariationMissingReasons: [],
    facilityVariationEpochYearMissingCount: 0,
  };

  const counts = await readSnapshotCounts(connection, snapshotId);
  if (
    counts.rawNavaidCount !== rawNavaidCount ||
    counts.plannerNavaidCount !== plannerNavaidCount ||
    counts.exclusionCount !== exclusionCount ||
    counts.plannerNavaidCount + counts.exclusionCount !== counts.rawNavaidCount
  ) {
    throw new InvalidDataStatusError(
      'The active Navaid Snapshot counts do not reconcile with committed records.'
    );
  }

  const exclusionCounts = await readGroupedCounts(
    connection,
    `SELECT reason, count(*) AS count
     FROM radial_producer.navaid_exclusions
     WHERE snapshot_id = CAST(? AS UUID)
     GROUP BY reason ORDER BY reason`,
    snapshotId
  );
  const facilityVariation = await readFacilityVariationCounts(connection, snapshotId);
  if (facilityVariation.auditCount !== counts.vorFamilyNavaidCount) {
    throw new InvalidDataStatusError(
      'Facility Variation audits do not reconcile with VOR-family Navaids.'
    );
  }

  return {
    ...snapshotMetadata,
    vorFamilyNavaidCount: counts.vorFamilyNavaidCount,
    fallbackNavaidCount: counts.fallbackNavaidCount,
    exclusionCounts,
    facilityVariationPresentCount: facilityVariation.presentCount,
    facilityVariationMissingCount: facilityVariation.missingCount,
    facilityVariationMissingReasons: facilityVariation.missingReasons,
    facilityVariationEpochYearMissingCount: facilityVariation.epochYearMissingCount,
  };
}

async function readSnapshotCounts(
  connection: DuckDBConnection,
  snapshotId: string
): Promise<
  Readonly<{
    rawNavaidCount: number;
    plannerNavaidCount: number;
    vorFamilyNavaidCount: number;
    fallbackNavaidCount: number;
    exclusionCount: number;
  }>
> {
  const result = await connection.runAndReadAll(
    `SELECT
       (SELECT count(*) FROM radial_producer.raw_navaids
        WHERE snapshot_id = CAST(? AS UUID)) AS raw_count,
       (SELECT count(*) FROM radial_producer.planner_navaids
        WHERE snapshot_id = CAST(? AS UUID)) AS planner_count,
       (SELECT count(*) FROM radial_producer.planner_navaids
        WHERE snapshot_id = CAST(? AS UUID) AND family <> 'NDB') AS vor_family_count,
       (SELECT count(*) FROM radial_producer.planner_navaids
        WHERE snapshot_id = CAST(? AS UUID) AND family = 'NDB') AS fallback_count,
       (SELECT count(*) FROM radial_producer.navaid_exclusions
        WHERE snapshot_id = CAST(? AS UUID)) AS exclusion_count`,
    [snapshotId, snapshotId, snapshotId, snapshotId, snapshotId]
  );
  const row = result.getRowObjectsJS()[0];
  if (row === undefined) {
    throw new InvalidDataStatusError('Committed Navaid Snapshot counts are unavailable.');
  }

  return {
    rawNavaidCount: nonNegativeInteger(row['raw_count'], 'raw Navaid count'),
    plannerNavaidCount: nonNegativeInteger(row['planner_count'], 'planner Navaid count'),
    vorFamilyNavaidCount: nonNegativeInteger(
      row['vor_family_count'],
      'VOR-family Navaid count'
    ),
    fallbackNavaidCount: nonNegativeInteger(
      row['fallback_count'],
      'Fallback Navaid count'
    ),
    exclusionCount: nonNegativeInteger(row['exclusion_count'], 'exclusion count'),
  };
}

async function readFacilityVariationCounts(
  connection: DuckDBConnection,
  snapshotId: string
): Promise<
  Readonly<{
    auditCount: number;
    presentCount: number;
    missingCount: number;
    missingReasons: readonly DataStatusExclusionCount[];
    epochYearMissingCount: number;
  }>
> {
  const result = await connection.runAndReadAll(
    `SELECT outcome, CAST(audit_record AS VARCHAR) AS audit_record
     FROM radial_producer.facility_variation_audits
     WHERE snapshot_id = CAST(? AS UUID)
     ORDER BY source_record_id`,
    [snapshotId]
  );
  const rows = result.getRowObjectsJS();
  const missingReasons = new Map<string, number>();
  let presentCount = 0;
  let epochYearMissingCount = 0;
  for (const row of rows) {
    const outcome = requiredString(row, 'outcome');
    if (outcome === 'matched') {
      presentCount += 1;
    } else {
      missingReasons.set(outcome, (missingReasons.get(outcome) ?? 0) + 1);
    }

    const auditRecord = requiredString(row, 'audit_record');
    let parsedAudit: unknown;
    try {
      parsedAudit = JSON.parse(auditRecord) as unknown;
    } catch {
      throw new InvalidDataStatusError('A Facility Variation audit record is invalid.');
    }

    if (!isJsonObject(parsedAudit) || parsedAudit['outcome'] !== outcome) {
      throw new InvalidDataStatusError(
        'A Facility Variation audit record does not match its committed outcome.'
      );
    }

    if (
      outcome === 'matched' &&
      (parsedAudit['facilityVariationEpochYear'] === null ||
        parsedAudit['facilityVariationEpochYear'] === undefined)
    ) {
      epochYearMissingCount += 1;
    }
  }

  return {
    auditCount: rows.length,
    presentCount,
    missingCount: rows.length - presentCount,
    missingReasons: [...missingReasons]
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([reason, count]) => ({reason, count})),
    epochYearMissingCount,
  };
}

async function readGroupedCounts(
  connection: DuckDBConnection,
  query: string,
  value: string
): Promise<readonly DataStatusExclusionCount[]> {
  const result = await connection.runAndReadAll(query, [value]);
  return result.getRowObjectsJS().map(row => ({
    reason: requiredString(row, 'reason'),
    count: nonNegativeInteger(row['count'], 'grouped count'),
  }));
}

async function readCachedAirports(
  connection: DuckDBConnection
): Promise<readonly DataStatusCachedAirport[]> {
  const result = await connection.runAndReadAll(`
    SELECT
      icao,
      database_id,
      name,
      longitude,
      latitude,
      record_checksum,
      source_identity,
      CAST(retrieved_at AS VARCHAR) AS retrieved_at,
      CAST(published_at AS VARCHAR) AS published_at
    FROM radial_producer.cached_airports
    ORDER BY icao
  `);
  return result.getRowObjectsJS().map(row => {
    const longitude = finiteNumber(row['longitude'], 'Cached Airport longitude');
    const latitude = finiteNumber(row['latitude'], 'Cached Airport latitude');
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new InvalidDataStatusError('A Cached Airport has invalid coordinates.');
    }

    return {
      icao: requiredString(row, 'icao'),
      sourceId: requiredString(row, 'database_id'),
      name: requiredString(row, 'name'),
      longitude,
      latitude,
      recordChecksum: requiredString(row, 'record_checksum'),
      sourceIdentity: requiredString(row, 'source_identity'),
      retrievedAt: canonicalTimestamp(row, 'retrieved_at'),
      publishedAt: canonicalTimestamp(row, 'published_at'),
    };
  });
}

async function readLegacyObjects(
  connection: DuckDBConnection
): Promise<readonly string[]> {
  const result = await connection.runAndReadAll(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'main'
      AND table_name IN (${LEGACY_TABLE_NAMES.map(name => `'${name}'`).join(', ')})
    ORDER BY table_schema, table_name
  `);
  return result.getRowObjectsJS().map(row => {
    const schema = requiredString(row, 'table_schema');
    const name = requiredString(row, 'table_name');
    return `${schema}.${name}`;
  });
}

function uninitializedStatus(
  databasePath: string,
  legacyObjects: readonly string[]
): DataStatusSuccess {
  return {
    databasePath,
    status: 'uninitialized',
    legacyObjects,
    producerSchema: null,
    snapshot: null,
    cachedAirports: [],
  };
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidDataStatusError(`Committed ${field} is unavailable.`);
  }

  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidDataStatusError(`Committed ${field} is invalid.`);
  }

  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new InvalidDataStatusError(`Committed ${field} is invalid.`);
  }

  return number;
}

function canonicalTimestamp(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new InvalidDataStatusError(`Committed ${field} is invalid.`);
  }

  return timestamp.toISOString();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function failure(
  code: RadialApplicationTypes['DataFailure']['code'],
  summary: string,
  cause: string,
  action: string
): DataStatusResult {
  return {
    ok: false,
    failure: {code, summary, cause, action, activeDataPreserved: true},
  };
}

function success(value: DataStatusSuccess): DataStatusResult {
  return {ok: true, value};
}

class InvalidDataStatusError extends Error {}

export default Object.assign(readDataStatus, {
  fromInstance: readDataStatusFromInstance,
});
