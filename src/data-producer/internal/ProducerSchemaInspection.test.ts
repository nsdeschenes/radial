import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {type DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import publishNavaidSnapshot from '#radial/data-producer/internal/NavaidSnapshotPublication.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';
import insertSyntheticCachedAirport from '#radial/test/data-producer/insertSyntheticCachedAirport.js';

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';

test('inspects absent storage without preparing it', async () => {
  await withDatabase(async instance => {
    await expect(producerSchema.inspect(instance)).resolves.toEqual({kind: 'absent'});

    const connection = await instance.connect();
    try {
      const schemas = await connection.runAndReadAll(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'radial_producer'
      `);
      expect(schemas.getRowObjectsJS()).toEqual([]);
    } finally {
      connection.closeSync();
    }
  });
});

test('classifies a reserved planner-relation collision as invalid absent storage', async () => {
  await withDatabase(async instance => {
    await mutate(instance, 'CREATE TABLE planner_navaids (legacy_value INTEGER)');

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic:
        'The Producer Schema is absent while a planner view name is already in use.',
    });
  });
});

test('inspects current-but-empty storage and interprets Cached Airports', async () => {
  await withDatabase(async instance => {
    await producerSchema.prepare(instance);
    await insertSyntheticCachedAirport(instance);

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'current',
      producerSchemaVersion: 1,
      plannerContractVersion: 1,
      checksumManifestVersion: 1,
      activeNavaidSnapshotId: null,
      cachedAirports: [
        {
          icao: 'CYYZ',
          sourceId: 'airport-yyz',
          name: 'Toronto Pearson',
          longitude: -79.6306,
          latitude: 43.6777,
          recordChecksum:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceIdentity: 'openaip:airport-yyz',
          retrievedAt: '2026-08-17T11:00:00.000Z',
          publishedAt: '2026-08-17T11:00:01.000Z',
        },
      ],
    });
  });
});

test('inspects a structurally valid active Navaid Snapshot', async () => {
  await withDatabase(async instance => {
    await publishSnapshot(instance);

    await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
      kind: 'current',
      activeNavaidSnapshotId: SNAPSHOT_ID,
    });
  });
});

test.each([
  {
    name: 'an incomplete object manifest',
    mutation: 'DROP TABLE radial_producer.raw_navaids',
    diagnostic: 'Producer Schema objects do not match version 1/1/1.',
  },
  {
    name: 'a missing producer-state singleton',
    mutation: 'DELETE FROM radial_producer.producer_state',
    diagnostic: 'Producer Schema state must contain exactly one singleton row.',
  },
  {
    name: 'an unsupported version tuple',
    mutation: 'UPDATE radial_producer.producer_state SET producer_schema_version = 2',
    diagnostic: 'Producer Schema version 2/1/1 is not supported; expected 1/1/1.',
  },
  {
    name: 'an active marker with no metadata target',
    mutation: `UPDATE radial_producer.producer_state
      SET active_navaid_snapshot_id = CAST('${SNAPSHOT_ID}' AS UUID)`,
    diagnostic: 'The active Navaid Snapshot marker does not identify a Snapshot.',
  },
  {
    name: 'orphan child rows',
    mutation: `INSERT INTO radial_producer.raw_navaids VALUES
      (CAST('${SNAPSHOT_ID}' AS UUID), 'orphan', '{}', 'sha256:orphan')`,
    diagnostic: 'Producer Schema table raw_navaids contains orphan Navaid Snapshot rows.',
  },
])('rejects $name', async ({mutation, diagnostic}) => {
  await withDatabase(async instance => {
    await producerSchema.prepare(instance);
    await mutate(instance, mutation);

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic,
    });
  });
});

test.each([
  {
    name: 'inactive Snapshot metadata',
    mutation:
      'UPDATE radial_producer.producer_state SET active_navaid_snapshot_id = NULL',
    diagnostic: 'Navaid Snapshot metadata exists without an active Snapshot marker.',
  },
  {
    name: 'multiple committed Snapshots',
    mutation: `INSERT INTO radial_producer.navaid_snapshots
      SELECT * REPLACE (CAST('${OTHER_SNAPSHOT_ID}' AS UUID) AS snapshot_id)
      FROM radial_producer.navaid_snapshots`,
    diagnostic: 'Committed Producer Schema storage contains multiple Navaid Snapshots.',
  },
  {
    name: 'a cross-Snapshot identity relationship',
    mutation: `UPDATE radial_producer.planner_navaids
      SET source_record_id = 'missing-raw-record'`,
    diagnostic:
      'A planner-ready Navaid does not identify a raw Navaid in the same Snapshot.',
  },
])('rejects $name', async ({mutation, diagnostic}) => {
  await withDatabase(async instance => {
    await publishSnapshot(instance);
    await mutate(instance, mutation);

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic,
    });
  });
});

async function publishSnapshot(instance: DuckDBInstance): Promise<void> {
  await producerSchema.prepare(instance);
  await publishNavaidSnapshot(
    instance,
    createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
    new PublicationGate(new FifoOperationCoordinator()),
    {
      snapshotId: SNAPSHOT_ID,
      publishedAt: () => '2026-08-17T12:00:02.000Z',
    }
  );
}

async function mutate(instance: DuckDBInstance, sql: string): Promise<void> {
  const connection: DuckDBConnection = await instance.connect();
  try {
    await connection.run(sql);
  } finally {
    connection.closeSync();
  }
}

async function withDatabase(
  useInstance: (instance: DuckDBInstance) => Promise<void>
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'producer-inspection-'));
  const instance = await DuckDBInstance.create(join(temporaryDirectory, 'radial.duckdb'));
  try {
    await useInstance(instance);
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
}
