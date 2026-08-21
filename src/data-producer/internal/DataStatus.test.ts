import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';
import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import validateNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidateValidation.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

test('reports legacy-only storage as inactive and uninitialized', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-data-status-'));
  const databasePath = join(temporaryDirectory, 'legacy.duckdb');
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run('CREATE TABLE navaids (identifier VARCHAR)');
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  try {
    const result = await readOwnedDataStatus(databasePath);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: 'uninitialized',
        legacyObjects: ['main.navaids'],
        producerSchema: null,
      }),
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports pre-bootstrap Cached Airports from an inactive Producer Schema', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-data-status-'));
  const databasePath = join(temporaryDirectory, 'inactive.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await producerSchema.prepare(instance);
    const connection = await instance.connect();
    try {
      await connection.run(
        `INSERT INTO radial_producer.cached_airports VALUES
          ('CYYZ', 'airport-yyz', 'Toronto Pearson', -79.6306, 43.6777,
           '{"_id":"airport-yyz"}',
           'sha256:581b0b5f9856d1f68cfd15960a3ebd920e106848b6906749a9e2ca8581c88790',
           'openaip:airport:airport-yyz',
           TIMESTAMPTZ '2026-08-17 11:00:00+00',
           TIMESTAMPTZ '2026-08-17 11:00:01+00')`
      );
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }

  try {
    await expect(readOwnedDataStatus(databasePath)).resolves.toEqual({
      ok: true,
      value: {
        databasePath,
        status: 'uninitialized',
        legacyObjects: [],
        producerSchema: {
          producerSchemaVersion: 1,
          plannerContractVersion: 1,
          checksumManifestVersion: 1,
        },
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
            sourceIdentity: 'openaip:airport:airport-yyz',
            retrievedAt: '2026-08-17T11:00:00.000Z',
            publishedAt: '2026-08-17T11:00:01.000Z',
          },
        ],
      },
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('distinguishes an invalid Producer Schema from ordinary uninitialized data', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-data-status-'));
  const databasePath = join(temporaryDirectory, 'invalid.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await producerSchema.prepare(instance);
    const connection = await instance.connect();
    try {
      await connection.run('DROP TABLE radial_producer.raw_navaids');
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }

  try {
    await expect(readOwnedDataStatus(databasePath)).resolves.toMatchObject({
      ok: false,
      failure: {code: 'DATA_DATABASE_INVALID'},
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('reports the active snapshot provenance, counts, and Facility Variation reasons', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-data-status-'));
  const databasePath = join(temporaryDirectory, 'ready.duckdb');
  const instance = await DuckDBInstance.create(databasePath);

  try {
    await producerSchema.prepare(instance);
    const candidate = buildNavaidSnapshotCandidate({
      faaNasrCycles: [
        createSyntheticFAANasrCycle([
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
        ]),
      ],
      rawNavaids: [
        {
          _id: 'ndb-1',
          type: 2,
          identifier: 'NDB',
          name: 'Test NDB',
          geometry: {type: 'Point', coordinates: [-79, 44]},
          frequency: {value: '365.000', unit: 1},
          range: {value: 50, unit: 2},
        },
      ],
      provenance: {
        sourceIdentity: 'fixture:openaip:navaids',
        derivationPolicyIdentity: 'fixture:derivation',
        matchingPolicyIdentity: 'fixture:matching',
      },
      retrievedAt: '2026-07-10T00:00:00.000Z',
      retrievalCompletedAt: '2026-07-10T00:00:02.000Z',
    });
    await producerSchema.publishNavaidSnapshot(
      instance,
      validateNavaidSnapshotCandidate(candidate),
      new PublicationGate(new FifoOperationCoordinator()),
      {
        snapshotId: '11111111-1111-4111-8111-111111111111',
        publishedAt: () => '2026-07-10T00:00:03.000Z',
      }
    );
  } finally {
    instance.closeSync();
  }

  try {
    const result = await readOwnedDataStatus(databasePath);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        snapshot: {
          snapshotId: '11111111-1111-4111-8111-111111111111',
          rawNavaidCount: 1,
          plannerNavaidCount: 1,
          vorFamilyNavaidCount: 0,
          fallbackNavaidCount: 1,
          exclusionCount: 0,
          exclusionCounts: [],
          facilityVariationPresentCount: 0,
          facilityVariationMissingCount: 0,
          facilityVariationMissingReasons: [],
          facilityVariationEpochYearMissingCount: 0,
          magneticModel: {
            model: 'WMM',
            version: 'WMM2025',
            referenceDate: '2026-07-10',
          },
          nasr: {
            cycleId: '2607',
            effectiveDate: '2026-07-09',
          },
        },
      },
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

async function readOwnedDataStatus(databasePath: string) {
  const instance = await DuckDBInstance.create(databasePath);
  try {
    return await readDataStatus(instance, databasePath);
  } finally {
    instance.closeSync();
  }
}
