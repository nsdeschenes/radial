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
       facility_variation_source IS NOT NULL AND facility_variation_effective_date IS NOT NULL))
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
    PRIMARY KEY (snapshot_id, source_record_id)
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

async function initializeProducerSchema(instance: DuckDBInstance): Promise<void> {
  const connection = await instance.connect();
  try {
    await connection.run('INSTALL spatial');
    await connection.run('LOAD spatial');
    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run(INITIAL_SCHEMA_SQL);
      await connection.run('COMMIT');
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
  } finally {
    connection.closeSync();
  }
}

export default initializeProducerSchema;
