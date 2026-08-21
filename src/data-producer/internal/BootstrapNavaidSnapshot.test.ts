import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import ensureFirstNavaidSnapshot from '#radial/data-producer/internal/BootstrapNavaidSnapshot.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';

test('leaves absent storage untouched when bootstrap credentials are missing', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = createPublicationGate();
    try {
      await expect(
        ensureFirstNavaidSnapshot(instance, '', publicationGate)
      ).resolves.toEqual(credentialsMissing());
      await expect(producerSchema.inspect(instance)).resolves.toEqual({kind: 'absent'});
    } finally {
      publicationGate.close();
    }
  });
});

test('keeps current-but-empty storage eligible for bootstrap', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = createPublicationGate();
    try {
      await producerSchema.prepare(instance);
      await expect(
        ensureFirstNavaidSnapshot(instance, '', publicationGate)
      ).resolves.toEqual(credentialsMissing());
      await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
        kind: 'current',
        activeNavaidSnapshotId: null,
        snapshot: null,
      });
    } finally {
      publicationGate.close();
    }
  });
});

test('accepts a completely inspected active snapshot without acquisition or mutation', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = createPublicationGate();
    try {
      await producerSchema.prepare(instance);
      await producerSchema.publishNavaidSnapshot(
        instance,
        createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
        publicationGate,
        {
          snapshotId: '11111111-1111-4111-8111-111111111111',
          publishedAt: () => '2026-08-17T12:00:02.000Z',
        }
      );
      const beforeBootstrap = await producerSchema.inspect(instance);
      let acquisitionCount = 0;

      await expect(
        ensureFirstNavaidSnapshot(instance, '', publicationGate, {
          createOpenAIPTransport: () => async () => {
            acquisitionCount += 1;
            throw new Error('Existing data must not trigger source acquisition.');
          },
        })
      ).resolves.toEqual({ok: true});

      expect(acquisitionCount).toBe(0);
      await expect(producerSchema.inspect(instance)).resolves.toEqual(beforeBootstrap);
    } finally {
      publicationGate.close();
    }
  });
});

test('rejects invalid committed storage before source acquisition or implicit repair', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = createPublicationGate();
    try {
      await producerSchema.prepare(instance);
      const connection = await instance.connect();
      try {
        await connection.run(`
          UPDATE radial_producer.producer_state
          SET producer_schema_version = 2
        `);
      } finally {
        connection.closeSync();
      }

      let acquisitionCount = 0;

      await expect(
        ensureFirstNavaidSnapshot(instance, 'api-key', publicationGate, {
          createOpenAIPTransport: () => async () => {
            acquisitionCount += 1;
            throw new Error('Invalid storage must not trigger source acquisition.');
          },
        })
      ).resolves.toEqual(databaseInvalid());

      expect(acquisitionCount).toBe(0);
      await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
        kind: 'invalid',
        diagnostic: 'Producer Schema version 2/1/1 is not supported; expected 1/1/1.',
      });
    } finally {
      publicationGate.close();
    }
  });
});

test('classifies a busy inspection with active data preserved', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = new RejectedPublicationGate(
      new Error('Could not set lock on file because a conflicting lock is held')
    );
    try {
      await expect(
        ensureFirstNavaidSnapshot(instance, 'api-key', publicationGate)
      ).resolves.toEqual(databaseBusy());
      await expect(producerSchema.inspect(instance)).resolves.toEqual({kind: 'absent'});
    } finally {
      publicationGate.close();
    }
  });
});

test('classifies an operational inspection failure as database-invalid', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-bootstrap-'));
  const instance = await DuckDBInstance.create(join(temporaryDirectory, 'radial.duckdb'));
  const publicationGate = createPublicationGate();
  instance.closeSync();
  try {
    await expect(
      ensureFirstNavaidSnapshot(instance, 'api-key', publicationGate)
    ).resolves.toEqual(databaseInvalid());
  } finally {
    publicationGate.close();
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('bootstraps a complete first snapshot after absent inspection', async () => {
  await withTestDatabase(async instance => {
    const publicationGate = createPublicationGate();
    let acquisitionCount = 0;
    try {
      await expect(
        ensureFirstNavaidSnapshot(instance, 'api-key', publicationGate, {
          now: () => new Date('2026-07-10T00:00:00.000Z'),
          createOpenAIPTransport: () => async () => {
            acquisitionCount += 1;
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                page: 1,
                limit: 1000,
                totalCount: 1,
                totalPages: 1,
                items: [bootstrapNavaid()],
              }),
            };
          },
          async acquireFAANasrCycles() {
            return [
              createSyntheticFAANasrCycle(
                [
                  {
                    EFF_DATE: '2026-07-09',
                    FREQ: '112.150',
                    LAT_DECIMAL: '43.6589',
                    LONG_DECIMAL: '-79.6139',
                    NAV_ID: 'YYZ',
                    NAV_TYPE: 'VOR/DME',
                  },
                ],
                {retrievedAt: '2026-07-10T00:00:00.000Z'}
              ),
            ];
          },
        })
      ).resolves.toEqual({ok: true});

      expect(acquisitionCount).toBe(1);
      await expect(producerSchema.inspect(instance)).resolves.toMatchObject({
        kind: 'current',
        activeNavaidSnapshotId: expect.any(String),
        snapshot: {
          rawNavaidCount: 1,
          plannerNavaidCount: 1,
        },
      });
    } finally {
      publicationGate.close();
    }
  });
});

class RejectedPublicationGate extends PublicationGate {
  readonly #error: Error;

  constructor(error: Error) {
    super(new FifoOperationCoordinator());
    this.#error = error;
  }

  override run<Value>(
    _operation: () => Promise<Value>,
    _signal?: AbortSignal
  ): Promise<Value> {
    return Promise.reject(this.#error);
  }
}

function createPublicationGate(): PublicationGate {
  return new PublicationGate(new FifoOperationCoordinator());
}

async function withTestDatabase(
  run: (instance: DuckDBInstance) => Promise<void>
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-bootstrap-'));
  const instance = await DuckDBInstance.create(join(temporaryDirectory, 'radial.duckdb'));
  try {
    await run(instance);
  } finally {
    instance.closeSync();
    await rm(temporaryDirectory, {recursive: true});
  }
}

function credentialsMissing() {
  return {
    ok: false,
    failure: {
      code: 'DATA_CREDENTIALS_MISSING',
      summary: 'OpenAIP credentials are missing.',
      cause: 'OPENAIP_API_KEY is required for the first Navaid Snapshot bootstrap.',
      action: 'Set OPENAIP_API_KEY and retry planning.',
      activeDataPreserved: true,
    },
  };
}

function databaseInvalid() {
  return {
    ok: false,
    failure: {
      code: 'DATA_DATABASE_INVALID',
      summary: 'The configured database is invalid.',
      cause: 'The Producer Schema could not be prepared safely.',
      action: 'Inspect the configured database and retry planning.',
      activeDataPreserved: true,
    },
  };
}

function databaseBusy() {
  return {
    ok: false,
    failure: {
      code: 'DATA_DATABASE_BUSY',
      summary: 'The configured database is busy.',
      cause: 'Another process owns the native DuckDB database file.',
      action:
        'Route the operation through the owning process or obtain exclusive maintenance access.',
      activeDataPreserved: true,
    },
  };
}

function bootstrapNavaid() {
  return {
    _id: 'ndb-1',
    type: 2,
    identifier: 'ND',
    name: 'Fallback NDB',
    geometry: {type: 'Point', coordinates: [-80, 44]},
    frequency: {value: '365.000', unit: 1},
    range: {value: 45, unit: 2},
  };
}
