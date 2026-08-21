import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {type DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
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
      snapshot: null,
      cachedAirports: [
        {
          icao: 'CYYZ',
          sourceId: 'airport-yyz',
          name: 'Toronto Pearson',
          longitude: -79.6306,
          latitude: 43.6777,
          recordChecksum:
            'sha256:581b0b5f9856d1f68cfd15960a3ebd920e106848b6906749a9e2ca8581c88790',
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
      snapshot: {
        snapshotId: SNAPSHOT_ID,
        snapshotChecksum:
          'sha256:8701c658ce0c0070a9c88f5118a05d5a8b3de7db90ced468b845972df6d731b3',
        componentChecksums: {
          rawNavaids:
            'sha256:24ef99bfc6fe04ce8366c8b30a3b173ebe71e61beb6040311ff1ff9ce82b808f',
          plannerNavaids:
            'sha256:fa225269d333440ecaf92c90d419a991e7da79635396e05298075dc2abbcc61f',
          exclusions:
            'sha256:40573ad4e5aefdebf521fd3d934ab203a17717ccef0596827dbd622c1b55e745',
          facilityVariationAudits:
            'sha256:6a86745190a51f069655976a033180ffc0e68a6760947d8b75ce46ae84a4ad42',
        },
        rawNavaidCount: 2,
        plannerNavaidCount: 1,
        vorFamilyNavaidCount: 1,
        fallbackNavaidCount: 0,
        exclusionCount: 1,
        exclusionCounts: [{reason: 'unsupported-navaid-type', count: 1}],
        facilityVariationPresentCount: 1,
        facilityVariationMissingCount: 0,
        facilityVariationMissingReasons: [],
        facilityVariationEpochYearMissingCount: 0,
      },
    });
  });
});

test('inspects the independent textual version 1 compatibility fixture', async () => {
  await withDatabase(async instance => {
    const fixture = await readFile(
      new URL(
        '../../../fixtures/producer-schema/version-one-compatible.sql',
        import.meta.url
      ),
      'utf8'
    );
    const connection = await instance.connect();
    await connection.run('LOAD spatial');
    connection.closeSync();
    await mutate(instance, fixture);

    await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
      kind: 'current',
      producerSchemaVersion: 1,
      plannerContractVersion: 1,
      checksumManifestVersion: 1,
      snapshot: {
        snapshotId: SNAPSHOT_ID,
        snapshotChecksum:
          'sha256:8701c658ce0c0070a9c88f5118a05d5a8b3de7db90ced468b845972df6d731b3',
        rawNavaidCount: 2,
        plannerNavaidCount: 1,
        exclusionCount: 1,
      },
    });
  });
});

test.each([
  {
    name: 'raw row checksum corruption',
    mutation: `UPDATE radial_producer.raw_navaids
      SET record_checksum = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      WHERE source_record_id = 'vor-1'`,
    diagnostic: 'A committed raw Navaid record checksum does not reconcile.',
  },
  {
    name: 'component checksum corruption',
    mutation: `UPDATE radial_producer.navaid_snapshots
      SET raw_navaids_checksum = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
    diagnostic: 'Committed Navaid Snapshot component checksums do not reconcile.',
  },
  {
    name: 'metadata count corruption',
    mutation: `UPDATE radial_producer.navaid_snapshots
      SET raw_navaid_count = 3, planner_navaid_count = 2`,
    diagnostic: 'Committed Navaid Snapshot counts do not reconcile.',
  },
  {
    name: 'semantic corruption outside the checksum manifest',
    mutation: `UPDATE radial_producer.navaid_snapshots
      SET nasr_retrieved_at = TIMESTAMPTZ '2026-08-18 00:00:00+00'`,
    diagnostic: 'Committed Navaid Snapshot retrieval timestamps do not reconcile.',
  },
  {
    name: 'audit JSON and column disagreement',
    mutation: `UPDATE radial_producer.facility_variation_audits
      SET outcome = 'no-unique-match', source_identity = NULL`,
    diagnostic: 'stored Facility Variation audit columns do not reconcile',
  },
  {
    name: 'Cached Airport projection count corruption',
    setup: true,
    mutation: 'DELETE FROM radial_producer.planner_airports',
    diagnostic: 'Cached Airport planner projection counts do not reconcile.',
  },
])('rejects $name independently', async ({setup, mutation, diagnostic}) => {
  await withDatabase(async instance => {
    await producerSchema.prepare(instance);
    if (setup === true) await insertSyntheticCachedAirport(instance);
    await publishSnapshot(instance, false);
    await mutate(instance, mutation);

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic,
    });
  });
});

test('rejects Cached Airport canonical checksum corruption without a Snapshot', async () => {
  await withDatabase(async instance => {
    await producerSchema.prepare(instance);
    await insertSyntheticCachedAirport(instance);
    await mutate(
      instance,
      `UPDATE radial_producer.cached_airports
       SET record_checksum = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`
    );

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic: 'Committed Cached Airport rows do not reconcile.',
    });
  });
});

test('rejects semantic corruption after every stored checksum is made consistent', async () => {
  await withDatabase(async instance => {
    await publishSnapshot(instance);
    const candidate = createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z');
    const plannerNavaids = candidate.plannerNavaids.map(navaid => ({
      ...navaid,
      name: '',
    }));
    const plannerNavaidsChecksum = checksum(canonicalizeJson(plannerNavaids));
    const componentChecksums = {
      ...candidate.componentChecksums,
      plannerNavaids: plannerNavaidsChecksum,
    };
    const {retrievedAt: _, ...faaNasr} = candidate.provenance.faaNasr;
    const snapshotChecksum = checksum(
      canonicalizeJson({
        manifestVersion: 1,
        provenance: {...candidate.provenance, faaNasr},
        componentChecksums,
        counts: {
          rawNavaids: candidate.rawNavaids.length,
          plannerNavaids: plannerNavaids.length,
          exclusions: candidate.exclusions.length,
        },
      })
    );
    await mutate(instance, "UPDATE radial_producer.planner_navaids SET name = ''");
    await mutate(
      instance,
      `UPDATE radial_producer.navaid_snapshots
       SET planner_navaids_checksum = '${plannerNavaidsChecksum}',
           snapshot_checksum = '${snapshotChecksum}'`
    );

    await expect(producerSchema.inspect(instance)).resolves.toEqual({
      kind: 'invalid',
      diagnostic: 'Committed name is unavailable.',
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

async function publishSnapshot(instance: DuckDBInstance, prepare = true): Promise<void> {
  if (prepare) await producerSchema.prepare(instance);
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

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
