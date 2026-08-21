-- Independent Producer Schema 1/1/1 compatibility fixture.
--
-- The prior DDL and rows are deliberately duplicated here; this fixture does
-- not call the production schema initializer or storage codec.

CREATE SCHEMA radial_producer;

CREATE TABLE radial_producer.producer_state (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  producer_schema_version INTEGER NOT NULL CHECK (producer_schema_version > 0),
  planner_contract_version INTEGER NOT NULL CHECK (planner_contract_version > 0),
  checksum_manifest_version INTEGER NOT NULL CHECK (checksum_manifest_version > 0),
  active_navaid_snapshot_id UUID
);

CREATE TABLE radial_producer.navaid_snapshots (
  snapshot_id UUID PRIMARY KEY, snapshot_checksum VARCHAR NOT NULL,
  raw_navaids_checksum VARCHAR NOT NULL, planner_navaids_checksum VARCHAR NOT NULL,
  exclusions_checksum VARCHAR NOT NULL,
  facility_variation_audits_checksum VARCHAR NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL, retrieval_completed_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL, source_identity VARCHAR NOT NULL,
  derivation_policy_identity VARCHAR NOT NULL, matching_policy_identity VARCHAR NOT NULL,
  nasr_source_url VARCHAR NOT NULL, nasr_retrieved_at TIMESTAMPTZ NOT NULL,
  nasr_archive_identity VARCHAR NOT NULL, nasr_archive_checksum VARCHAR NOT NULL,
  nasr_content_checksum VARCHAR NOT NULL, nasr_cycle_id VARCHAR NOT NULL,
  nasr_effective_date DATE NOT NULL,
  raw_navaid_count INTEGER NOT NULL CHECK (raw_navaid_count >= 0),
  planner_navaid_count INTEGER NOT NULL CHECK (planner_navaid_count >= 0),
  exclusion_count INTEGER NOT NULL CHECK (exclusion_count >= 0),
  magnetic_model VARCHAR NOT NULL, magnetic_model_version VARCHAR NOT NULL,
  magnetic_model_epoch_year DOUBLE NOT NULL, magnetic_reference_date DATE NOT NULL,
  magnetic_model_source VARCHAR NOT NULL, magnetic_model_checksum VARCHAR NOT NULL,
  CHECK (planner_navaid_count + exclusion_count = raw_navaid_count)
);

CREATE TABLE radial_producer.raw_navaids (
  snapshot_id UUID NOT NULL, source_record_id VARCHAR NOT NULL,
  canonical_record JSON NOT NULL, record_checksum VARCHAR NOT NULL,
  PRIMARY KEY (snapshot_id, source_record_id)
);

CREATE TABLE radial_producer.planner_navaids (
  snapshot_id UUID NOT NULL, database_id VARCHAR NOT NULL,
  source_record_id VARCHAR NOT NULL, identifier VARCHAR NOT NULL, name VARCHAR NOT NULL,
  family VARCHAR NOT NULL,
  longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
  latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
  frequency_value DOUBLE NOT NULL CHECK (isfinite(frequency_value) AND frequency_value > 0),
  frequency_unit VARCHAR NOT NULL CHECK (frequency_unit IN ('kHz', 'MHz')),
  published_range_nm DOUBLE NOT NULL CHECK (isfinite(published_range_nm) AND published_range_nm > 0),
  magnetic_declination_deg_east DOUBLE, facility_variation_deg_east DOUBLE,
  facility_variation_source VARCHAR, facility_variation_effective_date DATE,
  PRIMARY KEY (snapshot_id, database_id), UNIQUE (snapshot_id, source_record_id),
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
  snapshot_id UUID NOT NULL, source_record_id VARCHAR NOT NULL,
  reason VARCHAR NOT NULL CHECK (reason IN (
    'missing-stable-identity', 'unsupported-navaid-type', 'invalid-coordinates',
    'missing-identifier', 'invalid-frequency', 'invalid-published-range'
  )), PRIMARY KEY (snapshot_id, source_record_id)
);

CREATE TABLE radial_producer.facility_variation_audits (
  snapshot_id UUID NOT NULL, source_record_id VARCHAR NOT NULL,
  outcome VARCHAR NOT NULL CHECK (outcome IN (
    'matched', 'outside-source-coverage', 'no-unique-match', 'unusable-source-value'
  )), source_identity VARCHAR, audit_record JSON NOT NULL,
  PRIMARY KEY (snapshot_id, source_record_id),
  CHECK ((outcome = 'matched' AND source_identity IS NOT NULL AND
    trim(source_identity) <> '') OR (outcome <> 'matched' AND source_identity IS NULL))
);

CREATE TABLE radial_producer.cached_airports (
  icao VARCHAR PRIMARY KEY, database_id VARCHAR NOT NULL UNIQUE, name VARCHAR NOT NULL,
  longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
  latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
  canonical_record JSON NOT NULL, record_checksum VARCHAR NOT NULL,
  source_identity VARCHAR NOT NULL, retrieved_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE radial_producer.planner_airports (
  snapshot_id UUID NOT NULL, icao VARCHAR NOT NULL, database_id VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  longitude DOUBLE NOT NULL CHECK (isfinite(longitude) AND longitude BETWEEN -180 AND 180),
  latitude DOUBLE NOT NULL CHECK (isfinite(latitude) AND latitude BETWEEN -90 AND 90),
  magnetic_declination_deg_east DOUBLE, PRIMARY KEY (snapshot_id, icao)
);

INSERT INTO radial_producer.producer_state VALUES (true, 1, 1, 1, NULL);

CREATE VIEW planner_airports AS SELECT airports.snapshot_id, airports.database_id,
  airports.icao, airports.name, airports.longitude, airports.latitude,
  ST_Point(airports.longitude, airports.latitude) AS point,
  airports.magnetic_declination_deg_east
FROM radial_producer.planner_airports AS airports
JOIN radial_producer.producer_state AS state
  ON state.singleton AND airports.snapshot_id = state.active_navaid_snapshot_id;

CREATE VIEW planner_navaids AS SELECT navaids.snapshot_id, navaids.source_record_id,
  navaids.database_id, navaids.identifier, navaids.name, navaids.family,
  navaids.longitude, navaids.latitude,
  ST_Point(navaids.longitude, navaids.latitude) AS point, navaids.frequency_value,
  navaids.frequency_unit, navaids.published_range_nm,
  navaids.magnetic_declination_deg_east, navaids.facility_variation_deg_east,
  navaids.facility_variation_source, navaids.facility_variation_effective_date
FROM radial_producer.planner_navaids AS navaids
JOIN radial_producer.producer_state AS state
  ON state.singleton AND navaids.snapshot_id = state.active_navaid_snapshot_id;

CREATE VIEW planner_metadata AS SELECT snapshots.snapshot_id,
  snapshots.snapshot_checksum, snapshots.magnetic_model,
  snapshots.magnetic_model_version, snapshots.magnetic_model_epoch_year,
  snapshots.magnetic_reference_date, snapshots.magnetic_model_source
FROM radial_producer.navaid_snapshots AS snapshots
JOIN radial_producer.producer_state AS state
  ON state.singleton AND snapshots.snapshot_id = state.active_navaid_snapshot_id;

INSERT INTO radial_producer.raw_navaids VALUES
  ('11111111-1111-4111-8111-111111111111', 'unsupported',
   '{"_id":"unsupported","type":0}',
   'sha256:2b74c9b0f0ffa41601c43d4bad9f08b92485f6ed83c7a827378c412993f52ed2'),
  ('11111111-1111-4111-8111-111111111111', 'vor-1',
   '{"_id":"vor-1","country":"US","frequency":{"unit":2,"value":"112.150"},"geometry":{"coordinates":[-79.6139,43.6589],"type":"Point"},"identifier":"YYZ","name":"Toronto","range":{"unit":2,"value":130},"type":4}',
   'sha256:900ed345225df44986ae32b9b3a5fb1614e29c81b53751b160db6d8067d9dcb8');

INSERT INTO radial_producer.planner_navaids VALUES
  ('11111111-1111-4111-8111-111111111111', 'openaip:vor-1', 'vor-1', 'YYZ',
   'Toronto', 'VOR-DME', -79.6139, 43.6589, 112.15, 'MHz', 130,
   -9.997149534182313, -11.7, 'FAA 28-Day NASR 2607', NULL);

INSERT INTO radial_producer.navaid_exclusions VALUES
  ('11111111-1111-4111-8111-111111111111', 'unsupported',
   'unsupported-navaid-type');

INSERT INTO radial_producer.facility_variation_audits VALUES
  ('11111111-1111-4111-8111-111111111111', 'vor-1', 'matched',
   'FAA 28-Day NASR 2607',
   '{"faaFacilityIdentifier":"YYZ","faaFacilityType":"VOR/DME","faaFrequencyHz":112150000,"faaLatitude":43.6589,"faaLongitude":-79.6139,"faaRecordIdentity":"sha256:ee72f13d050f96893c890459df94a2c8de100d1079435e34f3a1dd99fac8f166","facilityVariationDegEast":-11.7,"facilityVariationEpochYear":2020,"matchingPolicyIdentity":"radial:faa-nasr-match:v1","nasrArchiveChecksum":"sha256:9bf9c6a83d65d1ed0f4c0fbbc97e2da466f7dbb44dc9b4c5b0aa206e742cd256","nasrArchiveIdentity":"28-day-nasr-2607.zip","nasrContentChecksum":"sha256:68af11ca669e0235376d7f67d50a3540a192579db510f29af5fa45305b82f8ca","nasrCycleId":"2607","nasrEffectiveDate":"2026-07-09","nasrRetrievedAt":"2026-08-17T12:00:00.500Z","nasrSourceUrl":"https://nfdc.faa.gov/webContent/28DaySub/28-day-nasr-2607.zip","openAipFrequencyHz":112150000,"openAipIdentifier":"YYZ","openAipLatitude":43.6589,"openAipLongitude":-79.6139,"outcome":"matched","rawMagneticVariation":"11.7","rawMagneticVariationEpochYear":"2020","rawMagneticVariationHemisphere":"W","separationNm":0,"sourceIdentity":"FAA 28-Day NASR 2607","sourceRecordId":"vor-1"}');

INSERT INTO radial_producer.navaid_snapshots VALUES
  ('11111111-1111-4111-8111-111111111111',
   'sha256:8701c658ce0c0070a9c88f5118a05d5a8b3de7db90ced468b845972df6d731b3',
   'sha256:24ef99bfc6fe04ce8366c8b30a3b173ebe71e61beb6040311ff1ff9ce82b808f',
   'sha256:fa225269d333440ecaf92c90d419a991e7da79635396e05298075dc2abbcc61f',
   'sha256:40573ad4e5aefdebf521fd3d934ab203a17717ccef0596827dbd622c1b55e745',
   'sha256:6a86745190a51f069655976a033180ffc0e68a6760947d8b75ce46ae84a4ad42',
   '2026-08-17T12:00:00.000Z', '2026-08-17T12:00:01.000Z',
   '2026-08-17T12:00:02.000Z', 'fixture:openaip-navaids:v1',
   'radial:navaid-derivation:v1', 'radial:faa-nasr-match:v1',
   'https://nfdc.faa.gov/webContent/28DaySub/28-day-nasr-2607.zip',
   '2026-08-17T12:00:00.500Z', '28-day-nasr-2607.zip',
   'sha256:9bf9c6a83d65d1ed0f4c0fbbc97e2da466f7dbb44dc9b4c5b0aa206e742cd256',
   'sha256:68af11ca669e0235376d7f67d50a3540a192579db510f29af5fa45305b82f8ca',
   '2607', '2026-07-09', 2, 1, 1, 'WMM', 'WMM2025', 2025,
   '2026-08-17', 'https://doi.org/10.25921/aqfd-sd83',
   'sha256:dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f');

UPDATE radial_producer.producer_state
SET active_navaid_snapshot_id = '11111111-1111-4111-8111-111111111111';
