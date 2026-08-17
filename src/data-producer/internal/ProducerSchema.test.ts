import {mkdtemp, readFile, rm} from 'node:fs/promises';
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

test('repeatedly opens a current producer schema as a no-op', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-current-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await initializeProducerSchema(instance);
    await expect(initializeProducerSchema(instance)).resolves.toBeUndefined();

    const connection = await instance.connect();
    try {
      const state = await connection.runAndReadAll(`
        SELECT *
        FROM radial_producer.producer_state
      `);
      expect(state.getRowObjectsJS()).toEqual([
        {
          singleton: true,
          producer_schema_version: 1,
          planner_contract_version: 1,
          checksum_manifest_version: 1,
          active_navaid_snapshot_id: null,
        },
      ]);
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('leaves the database file unchanged when reopening a current schema', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-read-only-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const initializedInstance = await DuckDBInstance.create(databasePath);
    await initializeProducerSchema(initializedInstance);
    initializedInstance.closeSync();
    const before = await readFile(databasePath);

    const reopenedInstance = await DuckDBInstance.create(databasePath);
    await initializeProducerSchema(reopenedInstance);
    reopenedInstance.closeSync();

    expect(await readFile(databasePath)).toEqual(before);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects a partial producer schema without repairing it', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-partial-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await initializeProducerSchema(instance);
    const connection = await instance.connect();
    await connection.run('DROP TABLE radial_producer.raw_navaids');
    connection.closeSync();

    await expect(initializeProducerSchema(instance)).rejects.toThrow(
      'Producer Schema objects do not match version 1/1/1.'
    );

    const inspectedConnection = await instance.connect();
    try {
      const tables = await inspectedConnection.runAndReadAll(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'radial_producer' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      expect(tables.getRowObjectsJS()).not.toContainEqual({table_name: 'raw_navaids'});
    } finally {
      inspectedConnection.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects a partial public planner view without repairing it', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-view-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await initializeProducerSchema(instance);
    const connection = await instance.connect();
    await connection.run(`
      DROP VIEW main.planner_metadata;
      CREATE VIEW main.planner_metadata AS SELECT 47 AS legacy_value;
    `);
    connection.closeSync();

    await expect(initializeProducerSchema(instance)).rejects.toThrow(
      'Producer Schema objects do not match version 1/1/1.'
    );

    const inspectedConnection = await instance.connect();
    try {
      const rows = await inspectedConnection.runAndReadAll(
        'SELECT * FROM main.planner_metadata'
      );
      expect(rows.getRowObjectsJS()).toEqual([{legacy_value: 47}]);
    } finally {
      inspectedConnection.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects a malformed producer-state singleton without mutation', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-state-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const instance = await DuckDBInstance.create(databasePath);
    await initializeProducerSchema(instance);
    const connection = await instance.connect();
    await connection.run('DELETE FROM radial_producer.producer_state');
    connection.closeSync();
    instance.closeSync();
    const before = await readFile(databasePath);

    const reopenedInstance = await DuckDBInstance.create(databasePath);
    await expect(initializeProducerSchema(reopenedInstance)).rejects.toThrow(
      'Producer Schema state must contain exactly one singleton row.'
    );
    reopenedInstance.closeSync();

    expect(await readFile(databasePath)).toEqual(before);
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects a newer Producer Schema component without mutation', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-producer-newer-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');

  try {
    const instance = await DuckDBInstance.create(databasePath);
    await initializeProducerSchema(instance);
    const connection = await instance.connect();
    await connection.run(`
      UPDATE radial_producer.producer_state
      SET producer_schema_version = 2
    `);
    connection.closeSync();
    instance.closeSync();
    const before = await readFile(databasePath);

    const reopenedInstance = await DuckDBInstance.create(databasePath);
    await expect(initializeProducerSchema(reopenedInstance)).rejects.toThrow(
      'Producer Schema version 2/1/1 is newer than supported 1/1/1.'
    );
    reopenedInstance.closeSync();

    expect(await readFile(databasePath)).toEqual(before);
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
    await expect(initializeProducerSchema(instance)).rejects.toThrow(
      'Producer Schema public view names collide with existing objects.'
    );
    instance.closeSync();

    const inspectedInstance = await DuckDBInstance.create(databasePath);
    const inspectedConnection = await inspectedInstance.connect();
    try {
      await inspectedConnection.run('LOAD spatial');
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
      await inspectedConnection.run('LOAD spatial');
      const legacyAirports = await inspectedConnection.runAndReadAll(
        'SELECT * FROM airports'
      );
      expect(legacyAirports.getRowObjectsJS()).toEqual([{id: 1, name: 'Legacy Airport'}]);
      const legacyNavaids = await inspectedConnection.runAndReadAll(
        'SELECT * FROM navaids'
      );
      expect(legacyNavaids.getRowObjectsJS()).toEqual([{id: 2, identifier: 'LEG'}]);
      const activeState = await inspectedConnection.runAndReadAll(`
        SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS active_navaid_snapshot_id
        FROM radial_producer.producer_state
      `);
      expect(activeState.getRowObjectsJS()).toEqual([{active_navaid_snapshot_id: null}]);
      const visibleNavaids = await inspectedConnection.runAndReadAll(
        'SELECT * FROM planner_navaids'
      );
      expect(visibleNavaids.getRowObjectsJS()).toEqual([]);
    } finally {
      inspectedConnection.closeSync();
      inspectedInstance.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});
