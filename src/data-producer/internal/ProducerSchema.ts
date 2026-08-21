import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import committedNavaidSnapshotInspection from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotInspection.js';
import publishValidatedNavaidSnapshot from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotStore.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import type ValidatedNavaidSnapshotCandidate from '#radial/data-producer/internal/ValidatedNavaidSnapshotCandidate.js';
import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';

const PRODUCER_VIEW_SOURCES = {
  plannerAirports: {
    createFrom: `radial_producer.planner_airports AS airports
JOIN radial_producer.producer_state AS state
  ON state.singleton AND airports.snapshot_id = state.active_navaid_snapshot_id`,
    normalizedFrom:
      'radial_producer.planner_airports AS airports INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (airports.snapshot_id = state.active_navaid_snapshot_id)))',
  },
  plannerNavaids: {
    createFrom: `radial_producer.planner_navaids AS navaids
JOIN radial_producer.producer_state AS state
  ON state.singleton AND navaids.snapshot_id = state.active_navaid_snapshot_id`,
    normalizedFrom:
      'radial_producer.planner_navaids AS navaids INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (navaids.snapshot_id = state.active_navaid_snapshot_id)))',
  },
  plannerMetadata: {
    createFrom: `radial_producer.navaid_snapshots AS snapshots
JOIN radial_producer.producer_state AS state
  ON state.singleton AND snapshots.snapshot_id = state.active_navaid_snapshot_id`,
    normalizedFrom:
      'radial_producer.navaid_snapshots AS snapshots INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (snapshots.snapshot_id = state.active_navaid_snapshot_id)))',
  },
} as const;

const CANONICAL_VIEWS =
  plannerDatabaseContract.createCanonicalViews(PRODUCER_VIEW_SOURCES);
const PUBLIC_RELATION_NAMES_SQL = Object.values(plannerDatabaseContract.relationNames)
  .map(name => `'${name}'`)
  .join(', ');

const INITIAL_SCHEMA_SQL = `
  CREATE SCHEMA radial_producer;

  CREATE TABLE radial_producer.producer_state (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    producer_schema_version INTEGER NOT NULL CHECK (producer_schema_version > 0),
    planner_contract_version INTEGER NOT NULL CHECK (planner_contract_version > 0),
    checksum_manifest_version INTEGER NOT NULL CHECK (checksum_manifest_version > 0),
    active_navaid_snapshot_id UUID
  );

  CREATE TABLE radial_producer.navaid_snapshots (
    snapshot_id UUID PRIMARY KEY,
    snapshot_checksum VARCHAR NOT NULL,
    raw_navaids_checksum VARCHAR NOT NULL,
    planner_navaids_checksum VARCHAR NOT NULL,
    exclusions_checksum VARCHAR NOT NULL,
    facility_variation_audits_checksum VARCHAR NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    retrieval_completed_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    source_identity VARCHAR NOT NULL,
    derivation_policy_identity VARCHAR NOT NULL,
    matching_policy_identity VARCHAR NOT NULL,
    nasr_source_url VARCHAR NOT NULL,
    nasr_retrieved_at TIMESTAMPTZ NOT NULL,
    nasr_archive_identity VARCHAR NOT NULL,
    nasr_archive_checksum VARCHAR NOT NULL,
    nasr_content_checksum VARCHAR NOT NULL,
    nasr_cycle_id VARCHAR NOT NULL,
    nasr_effective_date DATE NOT NULL,
    raw_navaid_count INTEGER NOT NULL CHECK (raw_navaid_count >= 0),
    planner_navaid_count INTEGER NOT NULL CHECK (planner_navaid_count >= 0),
    exclusion_count INTEGER NOT NULL CHECK (exclusion_count >= 0),
    magnetic_model VARCHAR NOT NULL,
    magnetic_model_version VARCHAR NOT NULL,
    magnetic_model_epoch_year DOUBLE NOT NULL,
    magnetic_reference_date DATE NOT NULL,
    magnetic_model_source VARCHAR NOT NULL,
    magnetic_model_checksum VARCHAR NOT NULL,
    CHECK (planner_navaid_count + exclusion_count = raw_navaid_count)
  );

  CREATE TABLE radial_producer.raw_navaids (
    snapshot_id UUID NOT NULL,
    source_record_id VARCHAR NOT NULL,
    canonical_record JSON NOT NULL,
    record_checksum VARCHAR NOT NULL,
    PRIMARY KEY (snapshot_id, source_record_id)
  );

  CREATE TABLE radial_producer.planner_navaids (
    snapshot_id UUID NOT NULL,
    database_id VARCHAR NOT NULL,
    source_record_id VARCHAR NOT NULL,
    identifier VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    family VARCHAR NOT NULL,
    longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
    latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
    frequency_value DOUBLE NOT NULL CHECK (isfinite(frequency_value) AND frequency_value > 0),
    frequency_unit VARCHAR NOT NULL CHECK (frequency_unit IN ('kHz', 'MHz')),
    published_range_nm DOUBLE NOT NULL CHECK (isfinite(published_range_nm) AND published_range_nm > 0),
    magnetic_declination_deg_east DOUBLE,
    facility_variation_deg_east DOUBLE,
    facility_variation_source VARCHAR,
    facility_variation_effective_date DATE,
    PRIMARY KEY (snapshot_id, database_id),
    UNIQUE (snapshot_id, source_record_id),
    CHECK (family IN ('NDB', 'VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC')),
    CHECK (magnetic_declination_deg_east IS NULL OR
      (isfinite(magnetic_declination_deg_east) AND
       magnetic_declination_deg_east >= -180 AND magnetic_declination_deg_east < 180)),
    CHECK ((facility_variation_deg_east IS NULL AND facility_variation_source IS NULL AND
      facility_variation_effective_date IS NULL) OR
      (facility_variation_deg_east IS NOT NULL AND isfinite(facility_variation_deg_east) AND
       facility_variation_deg_east >= -180 AND facility_variation_deg_east < 180 AND
       facility_variation_source IS NOT NULL AND trim(facility_variation_source) <> ''))
  );

  CREATE TABLE radial_producer.navaid_exclusions (
    snapshot_id UUID NOT NULL,
    source_record_id VARCHAR NOT NULL,
    reason VARCHAR NOT NULL CHECK (reason IN (
      'missing-stable-identity', 'unsupported-navaid-type', 'invalid-coordinates',
      'missing-identifier', 'invalid-frequency', 'invalid-published-range'
    )),
    PRIMARY KEY (snapshot_id, source_record_id)
  );

  CREATE TABLE radial_producer.facility_variation_audits (
    snapshot_id UUID NOT NULL,
    source_record_id VARCHAR NOT NULL,
    outcome VARCHAR NOT NULL CHECK (outcome IN (
      'matched', 'outside-source-coverage', 'no-unique-match', 'unusable-source-value'
    )),
    source_identity VARCHAR,
    audit_record JSON NOT NULL,
    PRIMARY KEY (snapshot_id, source_record_id),
    CHECK ((outcome = 'matched' AND source_identity IS NOT NULL AND
      trim(source_identity) <> '') OR
      (outcome <> 'matched' AND source_identity IS NULL))
  );

  CREATE TABLE radial_producer.cached_airports (
    icao VARCHAR PRIMARY KEY,
    database_id VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
    latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
    canonical_record JSON NOT NULL,
    record_checksum VARCHAR NOT NULL,
    source_identity VARCHAR NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE radial_producer.planner_airports (
    snapshot_id UUID NOT NULL,
    icao VARCHAR NOT NULL,
    database_id VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
    latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
    magnetic_declination_deg_east DOUBLE,
    PRIMARY KEY (snapshot_id, icao)
  );

  INSERT INTO radial_producer.producer_state VALUES (true, 1, 1, 1, NULL);

  ${CANONICAL_VIEWS.createSql}
`;

const CURRENT_OBJECTS = [
  ...Object.values(plannerDatabaseContract.relationNames).map(
    name => `main.${name}:VIEW`
  ),
  'radial_producer.cached_airports:BASE TABLE',
  'radial_producer.facility_variation_audits:BASE TABLE',
  'radial_producer.navaid_exclusions:BASE TABLE',
  'radial_producer.navaid_snapshots:BASE TABLE',
  'radial_producer.planner_airports:BASE TABLE',
  'radial_producer.planner_navaids:BASE TABLE',
  'radial_producer.producer_state:BASE TABLE',
  'radial_producer.raw_navaids:BASE TABLE',
];

const CURRENT_PRIVATE_TABLE_DEFINITIONS = [
  'cached_airports:CREATE TABLE radial_producer.cached_airports(icao VARCHAR PRIMARY KEY, database_id VARCHAR NOT NULL UNIQUE, "name" VARCHAR NOT NULL, longitude DOUBLE NOT NULL, latitude DOUBLE NOT NULL, canonical_record JSON NOT NULL, record_checksum VARCHAR NOT NULL, source_identity VARCHAR NOT NULL, retrieved_at TIMESTAMP WITH TIME ZONE NOT NULL, published_at TIMESTAMP WITH TIME ZONE NOT NULL, CHECK((isfinite(longitude) AND (longitude BETWEEN -180 AND 180))), CHECK((isfinite(latitude) AND (latitude BETWEEN -90 AND 90))));',
  "facility_variation_audits:CREATE TABLE radial_producer.facility_variation_audits(snapshot_id UUID, source_record_id VARCHAR, outcome VARCHAR NOT NULL, source_identity VARCHAR, audit_record JSON NOT NULL, CHECK((outcome IN ('matched', 'outside-source-coverage', 'no-unique-match', 'unusable-source-value'))), PRIMARY KEY(snapshot_id, source_record_id), CHECK((((outcome = 'matched') AND (source_identity IS NOT NULL) AND (main.\"trim\"(source_identity) != '')) OR ((outcome != 'matched') AND (source_identity IS NULL)))));",
  "navaid_exclusions:CREATE TABLE radial_producer.navaid_exclusions(snapshot_id UUID, source_record_id VARCHAR, reason VARCHAR NOT NULL, CHECK((reason IN ('missing-stable-identity', 'unsupported-navaid-type', 'invalid-coordinates', 'missing-identifier', 'invalid-frequency', 'invalid-published-range'))), PRIMARY KEY(snapshot_id, source_record_id));",
  'navaid_snapshots:CREATE TABLE radial_producer.navaid_snapshots(snapshot_id UUID PRIMARY KEY, snapshot_checksum VARCHAR NOT NULL, raw_navaids_checksum VARCHAR NOT NULL, planner_navaids_checksum VARCHAR NOT NULL, exclusions_checksum VARCHAR NOT NULL, facility_variation_audits_checksum VARCHAR NOT NULL, retrieved_at TIMESTAMP WITH TIME ZONE NOT NULL, retrieval_completed_at TIMESTAMP WITH TIME ZONE NOT NULL, published_at TIMESTAMP WITH TIME ZONE NOT NULL, source_identity VARCHAR NOT NULL, derivation_policy_identity VARCHAR NOT NULL, matching_policy_identity VARCHAR NOT NULL, nasr_source_url VARCHAR NOT NULL, nasr_retrieved_at TIMESTAMP WITH TIME ZONE NOT NULL, nasr_archive_identity VARCHAR NOT NULL, nasr_archive_checksum VARCHAR NOT NULL, nasr_content_checksum VARCHAR NOT NULL, nasr_cycle_id VARCHAR NOT NULL, nasr_effective_date DATE NOT NULL, raw_navaid_count INTEGER NOT NULL, planner_navaid_count INTEGER NOT NULL, exclusion_count INTEGER NOT NULL, magnetic_model VARCHAR NOT NULL, magnetic_model_version VARCHAR NOT NULL, magnetic_model_epoch_year DOUBLE NOT NULL, magnetic_reference_date DATE NOT NULL, magnetic_model_source VARCHAR NOT NULL, magnetic_model_checksum VARCHAR NOT NULL, CHECK((raw_navaid_count >= 0)), CHECK((planner_navaid_count >= 0)), CHECK((exclusion_count >= 0)), CHECK(((planner_navaid_count + exclusion_count) = raw_navaid_count)));',
  'planner_airports:CREATE TABLE radial_producer.planner_airports(snapshot_id UUID, icao VARCHAR, database_id VARCHAR NOT NULL, "name" VARCHAR NOT NULL, longitude DOUBLE NOT NULL, latitude DOUBLE NOT NULL, magnetic_declination_deg_east DOUBLE, CHECK((isfinite(longitude) AND (longitude BETWEEN -180 AND 180))), CHECK((isfinite(latitude) AND (latitude BETWEEN -90 AND 90))), PRIMARY KEY(snapshot_id, icao));',
  "planner_navaids:CREATE TABLE radial_producer.planner_navaids(snapshot_id UUID, database_id VARCHAR, source_record_id VARCHAR NOT NULL, identifier VARCHAR NOT NULL, \"name\" VARCHAR NOT NULL, \"family\" VARCHAR NOT NULL, longitude DOUBLE NOT NULL, latitude DOUBLE NOT NULL, frequency_value DOUBLE NOT NULL, frequency_unit VARCHAR NOT NULL, published_range_nm DOUBLE NOT NULL, magnetic_declination_deg_east DOUBLE, facility_variation_deg_east DOUBLE, facility_variation_source VARCHAR, facility_variation_effective_date DATE, CHECK((isfinite(longitude) AND (longitude BETWEEN -180 AND 180))), CHECK((isfinite(latitude) AND (latitude BETWEEN -90 AND 90))), CHECK((isfinite(frequency_value) AND (frequency_value > 0))), CHECK((frequency_unit IN ('kHz', 'MHz'))), CHECK((isfinite(published_range_nm) AND (published_range_nm > 0))), PRIMARY KEY(snapshot_id, database_id), UNIQUE(snapshot_id, source_record_id), CHECK((\"family\" IN ('NDB', 'VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC'))), CHECK(((magnetic_declination_deg_east IS NULL) OR (isfinite(magnetic_declination_deg_east) AND (magnetic_declination_deg_east >= -180) AND (magnetic_declination_deg_east < 180)))), CHECK((((facility_variation_deg_east IS NULL) AND (facility_variation_source IS NULL) AND (facility_variation_effective_date IS NULL)) OR ((facility_variation_deg_east IS NOT NULL) AND isfinite(facility_variation_deg_east) AND (facility_variation_deg_east >= -180) AND (facility_variation_deg_east < 180) AND (facility_variation_source IS NOT NULL) AND (main.\"trim\"(facility_variation_source) != '')))));",
  'producer_state:CREATE TABLE radial_producer.producer_state(singleton BOOLEAN PRIMARY KEY, producer_schema_version INTEGER NOT NULL, planner_contract_version INTEGER NOT NULL, checksum_manifest_version INTEGER NOT NULL, active_navaid_snapshot_id UUID, CHECK(singleton), CHECK((producer_schema_version > 0)), CHECK((planner_contract_version > 0)), CHECK((checksum_manifest_version > 0)));',
  'raw_navaids:CREATE TABLE radial_producer.raw_navaids(snapshot_id UUID, source_record_id VARCHAR, canonical_record JSON NOT NULL, record_checksum VARCHAR NOT NULL, PRIMARY KEY(snapshot_id, source_record_id));',
];

const CURRENT_PUBLIC_VIEW_DEFINITIONS = CANONICAL_VIEWS.normalizedDefinitions;

type ProducerSchemaVersion = readonly [number, number, number];

type ProducerSchemaMigration = {
  readonly from: ProducerSchemaVersion;
  readonly statements: readonly string[];
  readonly to: ProducerSchemaVersion;
};

type CommittedNavaidInspection = Awaited<
  ReturnType<typeof committedNavaidSnapshotInspection.inspect>
>;

type ProducerSchemaInspection =
  | Readonly<{kind: 'absent'}>
  | Readonly<{
      kind: 'current';
      producerSchemaVersion: number;
      plannerContractVersion: number;
      checksumManifestVersion: number;
      activeNavaidSnapshotId: string | null;
      snapshot: CommittedNavaidInspection['snapshot'];
      cachedAirports: CommittedNavaidInspection['cachedAirports'];
    }>
  | Readonly<{kind: 'invalid'; diagnostic: string}>;

const CURRENT_VERSION: ProducerSchemaVersion = [1, plannerDatabaseContract.version, 1];
const RECOGNIZED_MIGRATIONS: readonly ProducerSchemaMigration[] = [];

function readProducerSchemaVersion(row: Record<string, unknown>): ProducerSchemaVersion {
  const version: ProducerSchemaVersion = [
    Number(row['producer_schema_version']),
    Number(row['planner_contract_version']),
    Number(row['checksum_manifest_version']),
  ];
  if (version.some(component => !Number.isSafeInteger(component) || component < 1)) {
    throw new InvalidProducerSchemaError(
      `Producer Schema version ${formatVersion(version)} is impossible.`
    );
  }

  return version;
}

function formatVersion(version: ProducerSchemaVersion): string {
  return version.join('/');
}

function versionsMatch(
  first: ProducerSchemaVersion,
  second: ProducerSchemaVersion
): boolean {
  return first.every((component, index) => component === second[index]);
}

function readCatalogString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === 'string' ? value : '';
}

function planMigrations(
  startingVersion: ProducerSchemaVersion
): readonly ProducerSchemaMigration[] {
  const plan: ProducerSchemaMigration[] = [];
  let version = startingVersion;
  const visitedVersions = new Set<string>();

  while (!versionsMatch(version, CURRENT_VERSION)) {
    const formattedVersion = formatVersion(version);
    if (visitedVersions.has(formattedVersion)) {
      throw new Error('Producer Schema migration registry contains a cycle.');
    }

    visitedVersions.add(formattedVersion);

    const migration = RECOGNIZED_MIGRATIONS.find(candidate =>
      versionsMatch(candidate.from, version)
    );
    if (migration === undefined) {
      throw new Error(
        `No recognized Producer Schema migration starts at ${formattedVersion}.`
      );
    }

    if (
      migration.to.some(
        (component, index) =>
          component < version[index]! || component > CURRENT_VERSION[index]!
      )
    ) {
      throw new Error('Producer Schema migration registry contains an invalid step.');
    }

    plan.push(migration);
    version = migration.to;
  }

  return plan;
}

async function hasCurrentObjects(
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>
): Promise<boolean> {
  const objects = await connection.runAndReadAll(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'radial_producer'
       OR (
         table_schema = 'main'
         AND table_name IN (${PUBLIC_RELATION_NAMES_SQL})
       )
    ORDER BY table_schema, table_name
  `);
  const objectManifestMatches =
    objects
      .getRowObjectsJS()
      .map(
        object =>
          `${readCatalogString(object, 'table_schema')}.${readCatalogString(object, 'table_name')}:${readCatalogString(object, 'table_type')}`
      )
      .join('\n') === CURRENT_OBJECTS.join('\n');
  if (!objectManifestMatches) {
    return false;
  }

  const tables = await connection.runAndReadAll(`
    SELECT table_name, sql
    FROM duckdb_tables()
    WHERE schema_name = 'radial_producer'
    ORDER BY table_name
  `);
  const privateDefinitionsMatch =
    tables
      .getRowObjectsJS()
      .map(
        table =>
          `${readCatalogString(table, 'table_name')}:${readCatalogString(table, 'sql')}`
      )
      .join('\n') === CURRENT_PRIVATE_TABLE_DEFINITIONS.join('\n');
  if (!privateDefinitionsMatch) {
    return false;
  }

  const views = await connection.runAndReadAll(`
    SELECT view_name, sql
    FROM duckdb_views()
    WHERE schema_name = 'main'
      AND view_name IN (${PUBLIC_RELATION_NAMES_SQL})
    ORDER BY view_name
  `);
  return (
    views
      .getRowObjectsJS()
      .map(
        view =>
          `${readCatalogString(view, 'view_name')}:${readCatalogString(view, 'sql')}`
      )
      .join('\n') === CURRENT_PUBLIC_VIEW_DEFINITIONS.join('\n')
  );
}

async function inspectProducerSchema(
  instance: DuckDBInstance
): Promise<ProducerSchemaInspection> {
  const connection = await instance.connect();
  let transactionStarted = false;
  try {
    await connection.run('BEGIN TRANSACTION');
    transactionStarted = true;
    const inspection = await inspectProducerSchemaTransaction(connection);
    if (inspection.kind === 'invalid') {
      await connection.run('ROLLBACK');
    } else {
      await connection.run('COMMIT');
    }

    transactionStarted = false;
    return inspection;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // The original operational failure is the useful inspection diagnostic.
      }
    }

    throw error;
  } finally {
    connection.closeSync();
  }
}

async function publishNavaidSnapshot(
  instance: DuckDBInstance,
  candidate: ValidatedNavaidSnapshotCandidate,
  publicationGate: PublicationGate,
  options: Parameters<typeof publishValidatedNavaidSnapshot>[4] = {}
) {
  return publishValidatedNavaidSnapshot(
    instance,
    candidate,
    publicationGate,
    inspectProducerSchemaTransaction,
    options
  );
}

async function inspectProducerSchemaTransaction(
  connection: DuckDBConnection
): Promise<ProducerSchemaInspection> {
  const schemas = await connection.runAndReadAll(`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name = 'radial_producer'
  `);
  if (schemas.getRowObjectsJS().length === 0) {
    if (await plannerDatabaseContract.hasAnyReservedRelation(connection)) {
      return invalidInspection(
        'The Producer Schema is absent while a planner view name is already in use.'
      );
    }

    return {kind: 'absent'};
  }

  if (!(await hasCurrentObjects(connection))) {
    return invalidInspection('Producer Schema objects do not match version 1/1/1.');
  }

  let state: ProducerSchemaState;
  try {
    state = await readProducerSchemaState(connection);
  } catch (error) {
    if (error instanceof InvalidProducerSchemaError) {
      return invalidInspection(error.message);
    }

    throw error;
  }

  if (!versionsMatch(state.version, CURRENT_VERSION)) {
    return invalidInspection(
      `Producer Schema version ${formatVersion(state.version)} is not supported; expected ${formatVersion(CURRENT_VERSION)}.`
    );
  }

  const structuralDiagnostic = await inspectSnapshotStructure(
    connection,
    state.activeNavaidSnapshotId
  );
  if (structuralDiagnostic !== null) {
    return invalidInspection(structuralDiagnostic);
  }

  let committedNavaids: CommittedNavaidInspection;
  try {
    committedNavaids = await committedNavaidSnapshotInspection.inspect(
      connection,
      state.activeNavaidSnapshotId
    );
  } catch (error) {
    if (committedNavaidSnapshotInspection.isInvalidError(error)) {
      return invalidInspection(error.message);
    }

    throw error;
  }

  return {
    kind: 'current',
    producerSchemaVersion: state.version[0],
    plannerContractVersion: state.version[1],
    checksumManifestVersion: state.version[2],
    activeNavaidSnapshotId: state.activeNavaidSnapshotId,
    snapshot: committedNavaids.snapshot,
    cachedAirports: committedNavaids.cachedAirports,
  };
}

type ProducerSchemaState = Readonly<{
  version: ProducerSchemaVersion;
  activeNavaidSnapshotId: string | null;
}>;

async function readProducerSchemaState(
  connection: DuckDBConnection
): Promise<ProducerSchemaState> {
  const state = await connection.runAndReadAll(`
    SELECT
      singleton,
      producer_schema_version,
      planner_contract_version,
      checksum_manifest_version,
      CAST(active_navaid_snapshot_id AS VARCHAR) AS active_navaid_snapshot_id
    FROM radial_producer.producer_state
  `);
  const rows = state.getRowObjectsJS();
  if (rows.length !== 1 || rows[0]?.['singleton'] !== true) {
    throw new InvalidProducerSchemaError(
      'Producer Schema state must contain exactly one singleton row.'
    );
  }

  const activeNavaidSnapshotId = rows[0]['active_navaid_snapshot_id'];
  if (activeNavaidSnapshotId !== null && typeof activeNavaidSnapshotId !== 'string') {
    throw new InvalidProducerSchemaError(
      'Producer Schema active Navaid Snapshot marker is invalid.'
    );
  }

  return {
    version: readProducerSchemaVersion(rows[0]),
    activeNavaidSnapshotId,
  };
}

async function inspectSnapshotStructure(
  connection: DuckDBConnection,
  activeNavaidSnapshotId: string | null
): Promise<string | null> {
  const snapshotReader = await connection.runAndReadAll(`
    SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id
    FROM radial_producer.navaid_snapshots
    ORDER BY snapshot_id
  `);
  const snapshotIds = snapshotReader.getRowObjectsJS().map(row => row['snapshot_id']);
  if (snapshotIds.some(snapshotId => typeof snapshotId !== 'string')) {
    return 'A Navaid Snapshot metadata row has a null or invalid Snapshot identity.';
  }

  if (activeNavaidSnapshotId === null && snapshotIds.length > 0) {
    return 'Navaid Snapshot metadata exists without an active Snapshot marker.';
  }

  if (activeNavaidSnapshotId !== null && snapshotIds.length === 0) {
    return 'The active Navaid Snapshot marker does not identify a Snapshot.';
  }

  if (snapshotIds.length > 1) {
    return 'Committed Producer Schema storage contains multiple Navaid Snapshots.';
  }

  if (activeNavaidSnapshotId !== null && snapshotIds[0] !== activeNavaidSnapshotId) {
    return 'The active Navaid Snapshot marker identifies a different Snapshot than committed metadata.';
  }

  const orphanReader = await connection.runAndReadAll(`
    SELECT table_name, count(*) AS orphan_count
    FROM (
      SELECT 'raw_navaids' AS table_name, snapshot_id
      FROM radial_producer.raw_navaids
      UNION ALL
      SELECT 'planner_navaids', snapshot_id
      FROM radial_producer.planner_navaids
      UNION ALL
      SELECT 'navaid_exclusions', snapshot_id
      FROM radial_producer.navaid_exclusions
      UNION ALL
      SELECT 'facility_variation_audits', snapshot_id
      FROM radial_producer.facility_variation_audits
      UNION ALL
      SELECT 'planner_airports', snapshot_id
      FROM radial_producer.planner_airports
    ) AS children
    WHERE snapshot_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM radial_producer.navaid_snapshots AS snapshots
      WHERE snapshots.snapshot_id = children.snapshot_id
    )
    GROUP BY table_name
    ORDER BY table_name
  `);
  const orphan = orphanReader.getRowObjectsJS()[0];
  if (orphan !== undefined) {
    return `Producer Schema table ${requiredString(orphan, 'table_name')} contains orphan Navaid Snapshot rows.`;
  }

  const identityDiagnostic = await inspectCrossSnapshotIdentities(connection);
  return identityDiagnostic;
}

async function inspectCrossSnapshotIdentities(
  connection: DuckDBConnection
): Promise<string | null> {
  const relationships = [
    {
      child: 'planner_navaids',
      parent: 'raw_navaids',
      diagnostic:
        'A planner-ready Navaid does not identify a raw Navaid in the same Snapshot.',
    },
    {
      child: 'navaid_exclusions',
      parent: 'raw_navaids',
      diagnostic:
        'A Navaid exclusion does not identify a raw Navaid in the same Snapshot.',
    },
    {
      child: 'facility_variation_audits',
      parent: 'planner_navaids',
      diagnostic:
        'A Facility Variation audit does not identify a planner-ready Navaid in the same Snapshot.',
    },
  ] as const;
  for (const relationship of relationships) {
    const reader = await connection.runAndReadAll(`
      SELECT count(*) AS invalid_count
      FROM radial_producer.${relationship.child} AS child
      WHERE child.source_record_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM radial_producer.${relationship.parent} AS parent
        WHERE parent.snapshot_id = child.snapshot_id
          AND parent.source_record_id = child.source_record_id
      )
    `);
    if (Number(reader.getRowObjectsJS()[0]?.['invalid_count']) > 0) {
      return relationship.diagnostic;
    }
  }

  const conflictingIdentityReader = await connection.runAndReadAll(`
    SELECT count(*) AS invalid_count
    FROM radial_producer.planner_navaids AS planner
    JOIN radial_producer.navaid_exclusions AS exclusion
      USING (snapshot_id, source_record_id)
  `);
  if (Number(conflictingIdentityReader.getRowObjectsJS()[0]?.['invalid_count']) > 0) {
    return 'A raw Navaid identity is both planner-ready and excluded in the same Snapshot.';
  }

  return null;
}

function invalidInspection(diagnostic: string): ProducerSchemaInspection {
  return {kind: 'invalid', diagnostic};
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidProducerSchemaError(`Committed ${field} is unavailable.`);
  }

  return value;
}

class InvalidProducerSchemaError extends Error {}

async function readStoredVersion(
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>
): Promise<ProducerSchemaVersion> {
  const state = await connection.runAndReadAll(`
    SELECT
      singleton,
      producer_schema_version,
      planner_contract_version,
      checksum_manifest_version
    FROM radial_producer.producer_state
  `);
  const rows = state.getRowObjectsJS();
  if (rows.length !== 1 || rows[0]?.['singleton'] !== true) {
    throw new Error('Producer Schema state must contain exactly one singleton row.');
  }

  return readProducerSchemaVersion(rows[0]);
}

async function migrateProducerSchema(
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>,
  startingVersion: ProducerSchemaVersion
): Promise<void> {
  const migrations = planMigrations(startingVersion);
  await connection.run('BEGIN TRANSACTION');
  try {
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        await connection.run(statement);
      }
    }

    if (!(await hasCurrentObjects(connection))) {
      throw new Error(
        `Migrated Producer Schema objects do not match version ${formatVersion(CURRENT_VERSION)}.`
      );
    }

    const migratedVersion = await readStoredVersion(connection);
    if (!versionsMatch(migratedVersion, CURRENT_VERSION)) {
      throw new Error(
        `Producer Schema migration stopped at ${formatVersion(migratedVersion)} instead of ${formatVersion(CURRENT_VERSION)}.`
      );
    }
  } catch (error) {
    await connection.run('ROLLBACK');
    throw error;
  }

  await connection.run('COMMIT');
}

async function prepareProducerSchema(instance: DuckDBInstance): Promise<void> {
  const connection = await instance.connect();
  try {
    const schemas = await connection.runAndReadAll(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'radial_producer'
    `);
    if (schemas.getRowObjectsJS().length > 0) {
      await connection.run('LOAD spatial');
      if (!(await hasCurrentObjects(connection))) {
        throw new Error('Producer Schema objects do not match version 1/1/1.');
      }

      const version = await readStoredVersion(connection);
      if (versionsMatch(version, CURRENT_VERSION)) {
        return;
      }

      if (version.some((component, index) => component > CURRENT_VERSION[index]!)) {
        throw new Error(
          `Producer Schema version ${formatVersion(version)} is newer than supported ${formatVersion(CURRENT_VERSION)}.`
        );
      }

      await migrateProducerSchema(connection, version);
      return;
    }

    if (await plannerDatabaseContract.hasAnyReservedRelation(connection)) {
      throw new Error('Producer Schema public view names collide with existing objects.');
    }

    await connection.run('INSTALL spatial');
    await connection.run('LOAD spatial');
    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run(INITIAL_SCHEMA_SQL);
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }

    await connection.run('COMMIT');
  } finally {
    connection.closeSync();
  }
}

async function producerSchemaExists(instance: DuckDBInstance): Promise<boolean> {
  const connection = await instance.connect();
  try {
    const schemas = await connection.runAndReadAll(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'radial_producer'
    `);
    return schemas.getRowObjectsJS().length > 0;
  } finally {
    connection.closeSync();
  }
}

async function readActiveNavaidSnapshotId(
  instance: DuckDBInstance
): Promise<string | null> {
  const connection = await instance.connect();
  try {
    const state = await connection.runAndReadAll(`
      SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS active_navaid_snapshot_id
      FROM radial_producer.producer_state
      WHERE singleton
    `);
    const rows = state.getRowObjectsJS();
    if (rows.length !== 1) {
      throw new Error('Producer Schema state must contain exactly one singleton row.');
    }

    const activeSnapshotId = rows[0]?.['active_navaid_snapshot_id'];
    if (activeSnapshotId !== null && typeof activeSnapshotId !== 'string') {
      throw new Error('Producer Schema active Navaid Snapshot marker is invalid.');
    }

    return activeSnapshotId;
  } finally {
    connection.closeSync();
  }
}

export default {
  prepare: prepareProducerSchema,
  inspect: inspectProducerSchema,
  publishNavaidSnapshot,
  producerSchemaExists,
  readActiveNavaidSnapshotId,
};
