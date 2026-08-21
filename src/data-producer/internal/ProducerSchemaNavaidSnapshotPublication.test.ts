import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import validateNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidateValidation.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';
import insertSyntheticCachedAirport from '#radial/test/data-producer/insertSyntheticCachedAirport.js';

const FIRST_SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const FAILED_SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333';

test('atomically replaces the active snapshot and regenerates Cached Airport projections', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    await insertSyntheticCachedAirport(instance);
    const firstCandidate = createSyntheticNavaidSnapshotCandidate(
      '2026-08-17T12:00:00.000Z'
    );
    const first = await producerSchema.publishNavaidSnapshot(
      instance,
      firstCandidate,
      publicationGate,
      {
        snapshotId: FIRST_SNAPSHOT_ID,
        publishedAt: () => '2026-08-17T12:00:02.000Z',
      }
    );
    expect(first).toEqual({
      snapshotId: FIRST_SNAPSHOT_ID,
      snapshotChecksum: firstCandidate.snapshotChecksum,
      componentChecksums: firstCandidate.componentChecksums,
      publishedAt: '2026-08-17T12:00:02.000Z',
      rawNavaidCount: 2,
      plannerNavaidCount: 1,
      vorFamilyNavaidCount: 1,
      fallbackNavaidCount: 0,
      exclusionCount: 1,
      exclusionCounts: [{reason: 'unsupported-navaid-type', count: 1}],
      facilityVariationPresentCount: 1,
      facilityVariationMissingCount: 0,
      facilityVariationEpochYearMissingCount: 0,
    });

    const connection = await instance.connect();
    try {
      const visibleNavaids = await connection.runAndReadAll(
        `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, identifier
         FROM planner_navaids`
      );
      expect(visibleNavaids.getRowObjectsJS()).toEqual([
        {snapshot_id: FIRST_SNAPSHOT_ID, identifier: 'YYZ'},
      ]);
      const projectedAirports = await connection.runAndReadAll(
        `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, icao,
                magnetic_declination_deg_east
         FROM planner_airports`
      );
      expect(projectedAirports.getRowObjectsJS()).toEqual([
        {
          snapshot_id: FIRST_SNAPSHOT_ID,
          icao: 'CYYZ',
          magnetic_declination_deg_east: expect.any(Number),
        },
      ]);
      const facilityVariation = await connection.runAndReadAll(`
        SELECT
          navaids.facility_variation_deg_east,
          navaids.facility_variation_source,
          CAST(navaids.facility_variation_effective_date AS VARCHAR)
            AS facility_variation_effective_date,
          snapshots.nasr_cycle_id,
          CAST(snapshots.nasr_effective_date AS VARCHAR) AS nasr_effective_date,
          snapshots.nasr_archive_checksum,
          CAST(audits.audit_record AS VARCHAR) AS audit_record
        FROM radial_producer.planner_navaids AS navaids
        JOIN radial_producer.navaid_snapshots AS snapshots USING (snapshot_id)
        JOIN radial_producer.facility_variation_audits AS audits
          USING (snapshot_id, source_record_id)
      `);
      const facilityVariationRow = facilityVariation.getRowObjectsJS()[0];
      expect(facilityVariationRow).toMatchObject({
        facility_variation_deg_east: -11.7,
        facility_variation_effective_date: null,
        facility_variation_source: 'FAA 28-Day NASR 2607',
        nasr_archive_checksum: firstCandidate.provenance.faaNasr.archiveChecksum,
        nasr_cycle_id: '2607',
        nasr_effective_date: '2026-07-09',
      });
      const auditRecord = facilityVariationRow?.['audit_record'];
      expect(typeof auditRecord).toBe('string');
      expect(JSON.parse(auditRecord as string)).toMatchObject({
        facilityVariationEpochYear: 2020,
        matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
        outcome: 'matched',
      });
    } finally {
      connection.closeSync();
    }

    const equivalentCandidate = createSyntheticNavaidSnapshotCandidate(
      '2026-08-17T13:00:00.000Z'
    );
    expect(equivalentCandidate.snapshotChecksum).toBe(firstCandidate.snapshotChecksum);
    await producerSchema.publishNavaidSnapshot(
      instance,
      equivalentCandidate,
      publicationGate,
      {
        snapshotId: SECOND_SNAPSHOT_ID,
        publishedAt: () => '2026-08-18T12:00:02.000Z',
      }
    );

    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: SECOND_SNAPSHOT_ID,
      snapshotIds: [SECOND_SNAPSHOT_ID],
      rawSnapshotIds: [SECOND_SNAPSHOT_ID],
      airportSnapshotIds: [SECOND_SNAPSHOT_ID],
    });
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('independently rejects a corrupt candidate and rolls back a publication failure', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    const candidate = createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z');
    await producerSchema.publishNavaidSnapshot(instance, candidate, publicationGate, {
      snapshotId: FIRST_SNAPSHOT_ID,
      publishedAt: () => '2026-08-17T12:00:02.000Z',
    });
    const corruptCandidate = {
      ...candidate,
      componentChecksums: {
        ...candidate.componentChecksums,
        rawNavaids:
          'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    };

    expect(() => validateNavaidSnapshotCandidate(corruptCandidate)).toThrow(
      'candidate raw Navaid checksum does not reconcile'
    );
    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-19T12:00:00.000Z'),
        publicationGate,
        {
          snapshotId: FAILED_SNAPSHOT_ID,
          publishedAt: () => '2026-08-19T12:00:02.000Z',
          beforeCommit: () => {
            throw new Error('injected publication failure');
          },
        }
      )
    ).rejects.toThrow('injected publication failure');

    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: FIRST_SNAPSHOT_ID,
      snapshotIds: [FIRST_SNAPSHOT_ID],
      rawSnapshotIds: [FIRST_SNAPSHOT_ID],
      airportSnapshotIds: [],
    });
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

const INJECTED_FAILURE_BOUNDARIES = [
  'gate-acquired',
  'before-connection-acquisition',
  'connection-acquired',
  'before-transaction-start',
  'transaction-started',
  'before-candidate-write',
  'candidate-written',
  'candidate-verified',
  'active-marker-replaced',
  'before-old-snapshot-removal',
  'old-snapshot-removed',
  'before-commit',
] as const;

test.each(INJECTED_FAILURE_BOUNDARIES)(
  'rolls back an injected %s failure without leaving candidate rows',
  async boundary => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
    const databasePath = join(temporaryDirectory, 'radial.duckdb');
    const instance = await DuckDBInstance.create(databasePath);
    const publicationGate = createPublicationGate();

    try {
      await producerSchema.prepare(instance);
      await insertSyntheticCachedAirport(instance);
      const firstCandidate = createSyntheticNavaidSnapshotCandidate(
        '2026-08-17T12:00:00.000Z'
      );
      await producerSchema.publishNavaidSnapshot(
        instance,
        firstCandidate,
        publicationGate,
        {
          snapshotId: FIRST_SNAPSHOT_ID,
          publishedAt: () => '2026-08-17T12:00:02.000Z',
        }
      );

      await expect(
        producerSchema.publishNavaidSnapshot(
          instance,
          createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
          publicationGate,
          {
            snapshotId: SECOND_SNAPSHOT_ID,
            publishedAt: () => '2026-08-18T12:00:02.000Z',
            onBoundary(reachedBoundary) {
              if (reachedBoundary === boundary) {
                throw new Error(`injected ${boundary} failure`);
              }
            },
          }
        )
      ).rejects.toMatchObject({
        activeDataPreserved: true,
        message: `injected ${boundary} failure`,
      });

      await expect(activeState(instance)).resolves.toEqual({
        activeSnapshotId: FIRST_SNAPSHOT_ID,
        snapshotIds: [FIRST_SNAPSHOT_ID],
        rawSnapshotIds: [FIRST_SNAPSHOT_ID],
        airportSnapshotIds: [FIRST_SNAPSHOT_ID],
      });
    } finally {
      instance.closeSync();
      await rm(temporaryDirectory, {recursive: true});
    }
  }
);

test('does not mutate when publication gate acquisition fails', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    await producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: FIRST_SNAPSHOT_ID,
        publishedAt: () => '2026-08-17T12:00:02.000Z',
      }
    );
    const closedPublicationGate = createPublicationGate();
    closedPublicationGate.close();

    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
        closedPublicationGate,
        {
          snapshotId: SECOND_SNAPSHOT_ID,
        }
      )
    ).rejects.toThrow('The operation coordinator has been closed.');

    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: FIRST_SNAPSHOT_ID,
      snapshotIds: [FIRST_SNAPSHOT_ID],
      rawSnapshotIds: [FIRST_SNAPSHOT_ID],
      airportSnapshotIds: [],
    });
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('cancels while waiting for the publication gate without acquiring storage', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();
  const gateBlocker = deferred<void>();
  const gateAcquired = deferred<void>();

  try {
    await producerSchema.prepare(instance);
    await producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: FIRST_SNAPSHOT_ID,
        publishedAt: () => '2026-08-17T12:00:02.000Z',
      }
    );
    const blockingOperation = publicationGate.run(async () => {
      gateAcquired.resolve();
      await gateBlocker.promise;
    });
    await gateAcquired.promise;
    const abortController = new AbortController();
    let publicationStarted = false;
    const publication = producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: SECOND_SNAPSHOT_ID,
        signal: abortController.signal,
        onBoundary: () => {
          publicationStarted = true;
        },
      }
    );
    abortController.abort(new Error('cancel queued publication'));

    await expect(publication).rejects.toThrow('cancel queued publication');
    expect(publicationStarted).toBe(false);
    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: FIRST_SNAPSHOT_ID,
      snapshotIds: [FIRST_SNAPSHOT_ID],
      rawSnapshotIds: [FIRST_SNAPSHOT_ID],
      airportSnapshotIds: [],
    });
    gateBlocker.resolve();
    await blockingOperation;
  } finally {
    gateBlocker.resolve();
    publicationGate.close();
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports an injected commit-start ambiguity conservatively', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    await producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: FIRST_SNAPSHOT_ID,
        publishedAt: () => '2026-08-17T12:00:02.000Z',
      }
    );

    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
        publicationGate,
        {
          snapshotId: SECOND_SNAPSHOT_ID,
          publishedAt: () => '2026-08-18T12:00:02.000Z',
          onBoundary(boundary) {
            if (boundary === 'commit-started') {
              throw new Error('ambiguous commit result');
            }
          },
        }
      )
    ).rejects.toMatchObject({
      activeDataPreserved: false,
      message: 'ambiguous commit result',
    });
    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: FIRST_SNAPSHOT_ID,
      snapshotIds: [FIRST_SNAPSHOT_ID],
      rawSnapshotIds: [FIRST_SNAPSHOT_ID],
      airportSnapshotIds: [],
    });
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('does not claim preservation when rollback itself fails', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    await producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {snapshotId: FIRST_SNAPSHOT_ID}
    );

    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
        publicationGate,
        {
          snapshotId: SECOND_SNAPSHOT_ID,
          beforeCommit: () => {
            throw new Error('publication failure');
          },
          onBoundary(boundary) {
            if (boundary === 'rollback-started') {
              throw new Error('rollback failure');
            }
          },
        }
      )
    ).rejects.toMatchObject({activeDataPreserved: false});
    await expect(activeState(instance)).resolves.toEqual({
      activeSnapshotId: FIRST_SNAPSHOT_ID,
      snapshotIds: [FIRST_SNAPSHOT_ID],
      rawSnapshotIds: [FIRST_SNAPSHOT_ID],
      airportSnapshotIds: [],
    });
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('concurrent inspection observes a complete old or new snapshot', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();
  const beforeCommit = deferred<void>();
  const continueCommit = deferred<void>();

  try {
    await producerSchema.prepare(instance);
    await producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {snapshotId: FIRST_SNAPSHOT_ID}
    );
    const publication = producerSchema.publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: SECOND_SNAPSHOT_ID,
        onBoundary: async boundary => {
          if (boundary === 'before-commit') {
            beforeCommit.resolve();
            await continueCommit.promise;
          }
        },
      }
    );
    await beforeCommit.promise;

    await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
      kind: 'current',
      activeNavaidSnapshotId: FIRST_SNAPSHOT_ID,
      snapshot: {
        snapshotId: FIRST_SNAPSHOT_ID,
        rawNavaidCount: 2,
        plannerNavaidCount: 1,
        exclusionCount: 1,
      },
    });
    continueCommit.resolve();
    await publication;
    await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
      kind: 'current',
      activeNavaidSnapshotId: SECOND_SNAPSHOT_ID,
      snapshot: {
        snapshotId: SECOND_SNAPSHOT_ID,
        rawNavaidCount: 2,
        plannerNavaidCount: 1,
        exclusionCount: 1,
      },
    });
  } finally {
    continueCommit.resolve();
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('requires explicit Producer Schema preparation before publication', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
        publicationGate,
        {snapshotId: FIRST_SNAPSHOT_ID}
      )
    ).rejects.toMatchObject({
      activeDataPreserved: true,
      message: 'Producer Schema must be prepared before publication.',
    });
    await expect(producerSchema.inspect(instance)).resolves.toEqual({kind: 'absent'});
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('rejects invalid committed state without mutation', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const publicationGate = createPublicationGate();

  try {
    await producerSchema.prepare(instance);
    const connection = await instance.connect();
    try {
      await connection.run(`
        UPDATE radial_producer.producer_state
        SET producer_schema_version = 2
        WHERE singleton
      `);
    } finally {
      connection.closeSync();
    }

    await expect(
      producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
        publicationGate,
        {snapshotId: FIRST_SNAPSHOT_ID}
      )
    ).rejects.toMatchObject({
      activeDataPreserved: true,
      message:
        'Producer Schema cannot publish over invalid committed state: Producer Schema version 2/1/1 is not supported; expected 1/1/1.',
    });

    const verificationConnection = await instance.connect();
    try {
      const state = await verificationConnection.runAndReadAll(`
        SELECT producer_schema_version,
          CAST(active_navaid_snapshot_id AS VARCHAR) AS active_navaid_snapshot_id,
          (SELECT count(*) FROM radial_producer.navaid_snapshots) AS snapshot_count
        FROM radial_producer.producer_state
      `);
      expect(state.getRowObjectsJS()).toEqual([
        {
          producer_schema_version: 2,
          active_navaid_snapshot_id: null,
          snapshot_count: 0n,
        },
      ]);
    } finally {
      verificationConnection.closeSync();
    }
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
});

function createPublicationGate(): PublicationGate {
  return new PublicationGate(new FifoOperationCoordinator());
}

async function activeState(instance: DuckDBInstance) {
  const connection = await instance.connect();
  try {
    const state = await connection.runAndReadAll(`
      SELECT CAST(active_navaid_snapshot_id AS VARCHAR) AS active_snapshot_id
      FROM radial_producer.producer_state
    `);
    const snapshots = await connection.runAndReadAll(`
      SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id
      FROM radial_producer.navaid_snapshots ORDER BY snapshot_id
    `);
    const raw = await connection.runAndReadAll(`
      SELECT DISTINCT CAST(snapshot_id AS VARCHAR) AS snapshot_id
      FROM radial_producer.raw_navaids ORDER BY snapshot_id
    `);
    const airports = await connection.runAndReadAll(`
      SELECT DISTINCT CAST(snapshot_id AS VARCHAR) AS snapshot_id
      FROM radial_producer.planner_airports ORDER BY snapshot_id
    `);
    return {
      activeSnapshotId: state.getRowObjectsJS()[0]?.['active_snapshot_id'],
      snapshotIds: snapshots.getRowObjectsJS().map(row => row['snapshot_id']),
      rawSnapshotIds: raw.getRowObjectsJS().map(row => row['snapshot_id']),
      airportSnapshotIds: airports.getRowObjectsJS().map(row => row['snapshot_id']),
    };
  } finally {
    connection.closeSync();
  }
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value?: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value as Value);
    },
  };
}
