import type {DuckDBInstance} from '@duckdb/node-api';

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

  CREATE VIEW main.planner_airports AS
  SELECT
    airports.snapshot_id,
    airports.database_id,
    airports.icao,
    airports.name,
    airports.longitude,
    airports.latitude,
    ST_Point(airports.longitude, airports.latitude) AS point,
    airports.magnetic_declination_deg_east
  FROM radial_producer.planner_airports AS airports
  JOIN radial_producer.producer_state AS state
    ON state.singleton AND airports.snapshot_id = state.active_navaid_snapshot_id;

  CREATE VIEW main.planner_navaids AS
  SELECT
    navaids.snapshot_id,
    navaids.source_record_id,
    navaids.database_id,
    navaids.identifier,
    navaids.name,
    navaids.family,
    navaids.longitude,
    navaids.latitude,
    ST_Point(navaids.longitude, navaids.latitude) AS point,
    navaids.frequency_value,
    navaids.frequency_unit,
    navaids.published_range_nm,
    navaids.magnetic_declination_deg_east,
    navaids.facility_variation_deg_east,
    navaids.facility_variation_source,
    navaids.facility_variation_effective_date
  FROM radial_producer.planner_navaids AS navaids
  JOIN radial_producer.producer_state AS state
    ON state.singleton AND navaids.snapshot_id = state.active_navaid_snapshot_id;

  CREATE VIEW main.planner_metadata AS
  SELECT
    snapshots.snapshot_id,
    snapshots.snapshot_checksum,
    snapshots.magnetic_model,
    snapshots.magnetic_model_version,
    snapshots.magnetic_model_epoch_year,
    snapshots.magnetic_reference_date,
    snapshots.magnetic_model_source
  FROM radial_producer.navaid_snapshots AS snapshots
  JOIN radial_producer.producer_state AS state
    ON state.singleton AND snapshots.snapshot_id = state.active_navaid_snapshot_id;
`;

const CURRENT_OBJECTS = [
  'main.planner_airports:VIEW',
  'main.planner_metadata:VIEW',
  'main.planner_navaids:VIEW',
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

const CURRENT_PUBLIC_VIEW_DEFINITIONS = [
  'planner_airports:CREATE VIEW planner_airports AS SELECT airports.snapshot_id, airports.database_id, airports.icao, airports."name", airports.longitude, airports.latitude, st_point(airports.longitude, airports.latitude) AS point, airports.magnetic_declination_deg_east FROM radial_producer.planner_airports AS airports INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (airports.snapshot_id = state.active_navaid_snapshot_id)));',
  'planner_metadata:CREATE VIEW planner_metadata AS SELECT snapshots.snapshot_id, snapshots.snapshot_checksum, snapshots.magnetic_model, snapshots.magnetic_model_version, snapshots.magnetic_model_epoch_year, snapshots.magnetic_reference_date, snapshots.magnetic_model_source FROM radial_producer.navaid_snapshots AS snapshots INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (snapshots.snapshot_id = state.active_navaid_snapshot_id)));',
  'planner_navaids:CREATE VIEW planner_navaids AS SELECT navaids.snapshot_id, navaids.source_record_id, navaids.database_id, navaids.identifier, navaids."name", navaids."family", navaids.longitude, navaids.latitude, st_point(navaids.longitude, navaids.latitude) AS point, navaids.frequency_value, navaids.frequency_unit, navaids.published_range_nm, navaids.magnetic_declination_deg_east, navaids.facility_variation_deg_east, navaids.facility_variation_source, navaids.facility_variation_effective_date FROM radial_producer.planner_navaids AS navaids INNER JOIN radial_producer.producer_state AS state ON ((state.singleton AND (navaids.snapshot_id = state.active_navaid_snapshot_id)));',
];

type ProducerSchemaVersion = readonly [number, number, number];

type ProducerSchemaMigration = {
  readonly from: ProducerSchemaVersion;
  readonly statements: readonly string[];
  readonly to: ProducerSchemaVersion;
};

const CURRENT_VERSION: ProducerSchemaVersion = [1, 1, 1];
const RECOGNIZED_MIGRATIONS: readonly ProducerSchemaMigration[] = [];

function readProducerSchemaVersion(row: Record<string, unknown>): ProducerSchemaVersion {
  const version: ProducerSchemaVersion = [
    Number(row['producer_schema_version']),
    Number(row['planner_contract_version']),
    Number(row['checksum_manifest_version']),
  ];
  if (version.some(component => !Number.isSafeInteger(component) || component < 1)) {
    throw new Error(`Producer Schema version ${formatVersion(version)} is impossible.`);
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
         AND table_name IN ('planner_airports', 'planner_metadata', 'planner_navaids')
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
      AND view_name IN ('planner_airports', 'planner_metadata', 'planner_navaids')
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

async function hasPublicPlannerObjects(
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>
): Promise<boolean> {
  const objects = await connection.runAndReadAll(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'main'
      AND table_name IN ('planner_airports', 'planner_metadata', 'planner_navaids')
  `);
  return objects.getRowObjectsJS().length > 0;
}

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

async function initializeProducerSchema(instance: DuckDBInstance): Promise<void> {
  const connection = await instance.connect();
  try {
    const schemas = await connection.runAndReadAll(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'radial_producer'
    `);
    if (schemas.getRowObjectsJS().length > 0) {
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
    if (await hasPublicPlannerObjects(connection)) {
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

export default initializeProducerSchema;
