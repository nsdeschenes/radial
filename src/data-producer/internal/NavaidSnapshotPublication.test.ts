import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import publishNavaidSnapshot from '#radial/data-producer/internal/NavaidSnapshotPublication.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

const FIRST_SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const FAILED_SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333';

test('atomically replaces the active snapshot and regenerates Cached Airport projections', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-publication-'));
  const databasePath = join(temporaryDirectory, 'radial.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await initializeProducerSchema(instance);
    await insertCachedAirport(instance);
    const firstCandidate = candidateAt('2026-08-17T12:00:00.000Z');
    const first = await publishNavaidSnapshot(instance, firstCandidate, {
      snapshotId: FIRST_SNAPSHOT_ID,
      publishedAt: () => '2026-08-17T12:00:02.000Z',
    });
    expect(first).toEqual({
      snapshotId: FIRST_SNAPSHOT_ID,
      snapshotChecksum: firstCandidate.snapshotChecksum,
      rawNavaidCount: 2,
      plannerNavaidCount: 1,
      exclusionCount: 1,
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
        `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id, icao
         FROM planner_airports`
      );
      expect(projectedAirports.getRowObjectsJS()).toEqual([
        {snapshot_id: FIRST_SNAPSHOT_ID, icao: 'CYYZ'},
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

    const equivalentCandidate = candidateAt('2026-08-18T12:00:00.000Z');
    expect(equivalentCandidate.snapshotChecksum).toBe(firstCandidate.snapshotChecksum);
    await publishNavaidSnapshot(instance, equivalentCandidate, {
      snapshotId: SECOND_SNAPSHOT_ID,
      publishedAt: () => '2026-08-18T12:00:02.000Z',
    });

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

  try {
    await initializeProducerSchema(instance);
    const candidate = candidateAt('2026-08-17T12:00:00.000Z');
    await publishNavaidSnapshot(instance, candidate, {
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

    await expect(
      publishNavaidSnapshot(instance, corruptCandidate, {
        snapshotId: SECOND_SNAPSHOT_ID,
        publishedAt: () => '2026-08-18T12:00:02.000Z',
      })
    ).rejects.toThrow('candidate raw Navaid checksum does not reconcile');
    await expect(
      publishNavaidSnapshot(instance, candidateAt('2026-08-19T12:00:00.000Z'), {
        snapshotId: FAILED_SNAPSHOT_ID,
        publishedAt: () => '2026-08-19T12:00:02.000Z',
        beforeCommit: () => {
          throw new Error('injected publication failure');
        },
      })
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

function candidateAt(retrievedAt: string) {
  const retrievalCompletedAt = new Date(Date.parse(retrievedAt) + 1_000).toISOString();
  return buildNavaidSnapshotCandidate({
    faaNasrCycles: [
      createSyntheticFAANasrCycle(
        [
          {
            EFF_DATE: '2026-07-09',
            FREQ: '112.150',
            LAT_DECIMAL: '43.6589',
            LONG_DECIMAL: '-79.6139',
            MAG_VARN: '11.7',
            MAG_VARN_HEMIS: 'W',
            MAG_VARN_YEAR: '2020',
            NAV_ID: 'YYZ',
            NAV_TYPE: 'VOR/DME',
          },
        ],
        {retrievedAt: new Date(Date.parse(retrievedAt) + 500).toISOString()}
      ),
    ],
    rawNavaids: [
      {
        _id: 'vor-1',
        country: 'US',
        type: 4,
        identifier: 'YYZ',
        name: 'Toronto',
        geometry: {type: 'Point', coordinates: [-79.6139, 43.6589]},
        frequency: {value: '112.150', unit: 2},
        range: {value: 130, unit: 2},
      },
      {_id: 'unsupported', type: 0},
    ],
    provenance: {
      sourceIdentity: 'fixture:openaip-navaids:v1',
      derivationPolicyIdentity: 'radial:navaid-derivation:v1',
      matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
      magneticModel: {
        model: 'fixture magnetic model',
        version: '1',
        epochYear: 2025,
        referenceDate: '2026-08-17',
        source: 'fixture:wmm:v1',
        coefficientChecksum:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    retrievedAt,
    retrievalCompletedAt,
  });
}

async function insertCachedAirport(instance: DuckDBInstance): Promise<void> {
  const connection = await instance.connect();
  try {
    await connection.run(
      `INSERT INTO radial_producer.cached_airports VALUES
        ('CYYZ', 'airport-yyz', 'Toronto Pearson', -79.6306, 43.6777,
         '{"_id":"airport-yyz"}',
         'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         'openaip:airport-yyz',
         TIMESTAMPTZ '2026-08-17 11:00:00+00',
         TIMESTAMPTZ '2026-08-17 11:00:01+00')`
    );
  } finally {
    connection.closeSync();
  }
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
