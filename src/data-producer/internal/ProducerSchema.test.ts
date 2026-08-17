import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';

test('initializes versioned producer storage and three empty planner views', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-schema-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const instance = await DuckDBInstance.create(databasePath);
    await expect(initializeProducerSchema(instance)).resolves.toBeUndefined();
    instance.closeSync();

    const inspectedInstance = await DuckDBInstance.create(databasePath);
    const connection = await inspectedInstance.connect();
    try {
      await connection.run('LOAD spatial');
      const state = await connection.runAndReadAll(`
        SELECT
          producer_schema_version,
          planner_contract_version,
          checksum_manifest_version,
          CAST(active_navaid_snapshot_id AS VARCHAR) AS active_navaid_snapshot_id
        FROM radial_producer.producer_state
      `);
      expect(state.getRowObjectsJS()).toEqual([
        {
          producer_schema_version: 1,
          planner_contract_version: 1,
          checksum_manifest_version: 1,
          active_navaid_snapshot_id: null,
        },
      ]);

      const publicationTimestampColumn = await connection.runAndReadAll(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'radial_producer'
          AND table_name = 'navaid_snapshots'
          AND column_name = 'published_at'
      `);
      expect(publicationTimestampColumn.getRowObjectsJS()).toEqual([{is_nullable: 'NO'}]);

      const privateTables = await connection.runAndReadAll(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'radial_producer' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      expect(privateTables.getRowObjectsJS()).toEqual(
        [
          'cached_airports',
          'facility_variation_audits',
          'navaid_exclusions',
          'navaid_snapshots',
          'planner_airports',
          'planner_navaids',
          'producer_state',
          'raw_navaids',
        ].map(table_name => ({table_name}))
      );

      const mainObjects = await connection.runAndReadAll(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'main'
        ORDER BY table_name
      `);
      expect(mainObjects.getRowObjectsJS()).toEqual(
        ['planner_airports', 'planner_metadata', 'planner_navaids'].map(table_name => ({
          table_name,
        }))
      );

      for (const view of ['planner_airports', 'planner_metadata', 'planner_navaids']) {
        const rows = await connection.runAndReadAll(`SELECT * FROM ${view}`);
        expect(rows.getRowObjectsJS()).toEqual([]);
      }
    } finally {
      connection.closeSync();
      inspectedInstance.closeSync();
    }
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rolls back initialization without changing legacy aviation data', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-legacy-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  await connection.run(`
    CREATE TABLE airports (id INTEGER PRIMARY KEY, name VARCHAR);
    INSERT INTO airports VALUES (1, 'Legacy Airport');
    CREATE TABLE planner_navaids (legacy_value INTEGER);
    INSERT INTO planner_navaids VALUES (47);
  `);
  connection.closeSync();

  try {
    await expect(initializeProducerSchema(instance)).rejects.toThrow();
    instance.closeSync();

    const inspectedInstance = await DuckDBInstance.create(databasePath);
    const inspectedConnection = await inspectedInstance.connect();
    try {
      const legacyAirports = await inspectedConnection.runAndReadAll(
        'SELECT * FROM airports'
      );
      expect(legacyAirports.getRowObjectsJS()).toEqual([{id: 1, name: 'Legacy Airport'}]);
      const legacyPlannerNavaids = await inspectedConnection.runAndReadAll(
        'SELECT * FROM planner_navaids'
      );
      expect(legacyPlannerNavaids.getRowObjectsJS()).toEqual([{legacy_value: 47}]);
      const privateSchema = await inspectedConnection.runAndReadAll(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'radial_producer'
      `);
      expect(privateSchema.getRowObjectsJS()).toEqual([]);
    } finally {
      inspectedConnection.closeSync();
      inspectedInstance.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('preserves legacy aviation objects and rows during successful initialization', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-legacy-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  await connection.run(`
    CREATE TABLE airports (id INTEGER PRIMARY KEY, name VARCHAR);
    INSERT INTO airports VALUES (1, 'Legacy Airport');
    CREATE TABLE navaids (id INTEGER PRIMARY KEY, identifier VARCHAR);
    INSERT INTO navaids VALUES (2, 'LEG');
  `);
  connection.closeSync();

  try {
    await initializeProducerSchema(instance);
    instance.closeSync();

    const inspectedInstance = await DuckDBInstance.create(databasePath);
    const inspectedConnection = await inspectedInstance.connect();
    try {
      const legacyAirports = await inspectedConnection.runAndReadAll(
        'SELECT * FROM airports'
      );
      expect(legacyAirports.getRowObjectsJS()).toEqual([{id: 1, name: 'Legacy Airport'}]);
      const legacyNavaids = await inspectedConnection.runAndReadAll(
        'SELECT * FROM navaids'
      );
      expect(legacyNavaids.getRowObjectsJS()).toEqual([{id: 2, identifier: 'LEG'}]);
    } finally {
      inspectedConnection.closeSync();
      inspectedInstance.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});
