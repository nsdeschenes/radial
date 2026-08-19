import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import type {DuckDBConnection} from '@duckdb/node-api';

import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';

type SyntheticAirport = Readonly<{
  databaseId: string;
  icao: string;
  name: string;
  longitude: number;
  latitude: number;
  magneticDeclinationDegEast?: number | null;
}>;

type SyntheticNavaid = Readonly<{
  databaseId: string;
  identifier: string;
  name: string;
  family: string;
  longitude: number;
  latitude: number;
  frequencyValue: number;
  frequencyUnit: string;
  publishedRangeNm: number;
  magneticDeclinationDegEast?: number | null;
  facilityVariationDegEast?: number | null;
  facilityVariationSource?: string | null;
  facilityVariationEffectiveDate?: string | null;
}>;

type SyntheticPlannerMetadata = Readonly<{
  magneticModel: string | null;
  magneticModelVersion: string | null;
  magneticModelEpochYear: number | null;
  magneticReferenceDate: string | null;
  magneticModelSource: string | null;
}>;

type SyntheticPlannerDatabaseDefinition = Readonly<{
  airports?: readonly SyntheticAirport[];
  navaids?: readonly SyntheticNavaid[];
  metadata?: readonly SyntheticPlannerMetadata[];
}>;

type SyntheticPlannerDatabase = Readonly<{
  databasePath: string;
  [Symbol.asyncDispose](): Promise<void>;
}>;

const NULL_METADATA: SyntheticPlannerMetadata = {
  magneticModel: null,
  magneticModelVersion: null,
  magneticModelEpochYear: null,
  magneticReferenceDate: null,
  magneticModelSource: null,
};

const SYNTHETIC_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_VIEW_SOURCES = {
  plannerAirports: {
    createFrom: `(SELECT CAST('${SYNTHETIC_SNAPSHOT_ID}' AS UUID) AS snapshot_id, *
      FROM synthetic_airports) AS airports`,
    normalizedFrom: 'synthetic_airports AS airports',
  },
  plannerNavaids: {
    createFrom: `(SELECT CAST('${SYNTHETIC_SNAPSHOT_ID}' AS UUID) AS snapshot_id,
        database_id AS source_record_id, * FROM synthetic_navaids) AS navaids`,
    normalizedFrom: 'synthetic_navaids AS navaids',
  },
  plannerMetadata: {
    createFrom: `(SELECT CAST('${SYNTHETIC_SNAPSHOT_ID}' AS UUID) AS snapshot_id,
        'synthetic-snapshot' AS snapshot_checksum, * FROM synthetic_metadata) AS snapshots`,
    normalizedFrom: 'synthetic_metadata AS snapshots',
  },
} as const;

async function createSyntheticPlannerDatabase(
  definition: SyntheticPlannerDatabaseDefinition = {}
): Promise<SyntheticPlannerDatabase> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-planner-db-'));
  const databasePath = join(temporaryDirectory, 'planner.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();

  try {
    await connection.run('INSTALL spatial');
    await configureSpatial(connection);
    await connection.run(`
      CREATE TABLE synthetic_airports (
        database_id VARCHAR,
        icao VARCHAR,
        name VARCHAR,
        longitude DOUBLE,
        latitude DOUBLE,
        magnetic_declination_deg_east DOUBLE
      );
      CREATE TABLE synthetic_navaids (
        database_id VARCHAR,
        identifier VARCHAR,
        name VARCHAR,
        family VARCHAR,
        longitude DOUBLE,
        latitude DOUBLE,
        frequency_value DOUBLE,
        frequency_unit VARCHAR,
        published_range_nm DOUBLE,
        magnetic_declination_deg_east DOUBLE,
        facility_variation_deg_east DOUBLE,
        facility_variation_source VARCHAR,
        facility_variation_effective_date DATE
      );
      CREATE TABLE synthetic_metadata (
        magnetic_model VARCHAR,
        magnetic_model_version VARCHAR,
        magnetic_model_epoch_year DOUBLE,
        magnetic_reference_date DATE,
        magnetic_model_source VARCHAR
      );
    `);

    for (const airport of definition.airports ?? []) {
      await connection.run(`INSERT INTO synthetic_airports VALUES (?, ?, ?, ?, ?, ?)`, [
        airport.databaseId,
        airport.icao,
        airport.name,
        airport.longitude,
        airport.latitude,
        airport.magneticDeclinationDegEast ?? null,
      ]);
    }

    for (const navaid of definition.navaids ?? []) {
      await connection.run(
        `INSERT INTO synthetic_navaids VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS DATE))`,
        [
          navaid.databaseId,
          navaid.identifier,
          navaid.name,
          navaid.family,
          navaid.longitude,
          navaid.latitude,
          navaid.frequencyValue,
          navaid.frequencyUnit,
          navaid.publishedRangeNm,
          navaid.magneticDeclinationDegEast ?? null,
          navaid.facilityVariationDegEast ?? null,
          navaid.facilityVariationSource ?? null,
          navaid.facilityVariationEffectiveDate ?? null,
        ]
      );
    }

    for (const metadata of definition.metadata ?? [NULL_METADATA]) {
      await connection.run(
        `INSERT INTO synthetic_metadata VALUES (?, ?, ?, CAST(? AS DATE), ?)`,
        [
          metadata.magneticModel,
          metadata.magneticModelVersion,
          metadata.magneticModelEpochYear,
          metadata.magneticReferenceDate,
          metadata.magneticModelSource,
        ]
      );
    }

    await connection.run(
      plannerDatabaseContract.createCanonicalViews(SYNTHETIC_VIEW_SOURCES).createSql
    );
  } catch (error) {
    await rm(temporaryDirectory, {recursive: true});
    throw error;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  return {
    databasePath,
    async [Symbol.asyncDispose]() {
      await rm(temporaryDirectory, {recursive: true});
    },
  };
}

async function modifySyntheticPlannerDatabase(
  databasePath: string,
  sql: string
): Promise<void> {
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await configureSpatial(connection);
    await connection.run(sql);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function configureSpatial(connection: DuckDBConnection): Promise<void> {
  await connection.run('LOAD spatial');
  await connection.run('SET geometry_always_xy = true');
}

export default {
  create: createSyntheticPlannerDatabase,
  modify: modifySyntheticPlannerDatabase,
};
