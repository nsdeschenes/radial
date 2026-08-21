import {DuckDBInstance} from '@duckdb/node-api';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import publishNavaidSnapshot from '#radial/data-producer/internal/NavaidSnapshotPublication.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';
import insertSyntheticCachedAirport from '#radial/test/data-producer/insertSyntheticCachedAirport.js';

const OLD_SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';

const mode = process.argv[2];
const databasePath = process.argv[3];
const phase = process.argv[4];

if (mode === undefined || databasePath === undefined) {
  throw new Error('Expected a mode and database path.');
}

const instance = await DuckDBInstance.create(databasePath);
const publicationGate = new PublicationGate(new FifoOperationCoordinator());
try {
  await producerSchema.prepare(instance);

  if (mode === 'seed') {
    await insertSyntheticCachedAirport(instance);
    await publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: OLD_SNAPSHOT_ID,
        publishedAt: () => '2026-08-17T12:00:02.000Z',
      }
    );

    process.exitCode = 0;
  } else if (mode === 'crash') {
    if (phase === undefined) {
      throw new Error('Expected a crash phase.');
    }

    await publishNavaidSnapshot(
      instance,
      createSyntheticNavaidSnapshotCandidate('2026-08-18T12:00:00.000Z'),
      publicationGate,
      {
        snapshotId: NEW_SNAPSHOT_ID,
        publishedAt: () => '2026-08-18T12:00:02.000Z',
        onBoundary: async boundary => {
          if (phase !== 'after-commit' && boundary === boundaryForPhase(phase)) {
            process.stdout.write(`reached:${phase}\n`);
            await new Promise<void>(() => {});
          }
        },
      }
    );
    if (phase === 'after-commit') {
      process.kill(process.pid, 'SIGKILL');
    }

    process.exitCode = 0;
  } else {
    throw new Error(`Unknown worker mode ${JSON.stringify(mode)}.`);
  }
} finally {
  publicationGate.close();
  if (phase !== 'after-commit') {
    instance.closeSync();
  }
}

function boundaryForPhase(phaseName: string): string {
  switch (phaseName) {
    case 'before-mutation':
      return 'before-transaction';
    case 'during-writes':
      return 'candidate-write';
    case 'after-candidate-verification':
      return 'candidate-verified';
    case 'after-active-marker':
      return 'active-marker-changed';
    case 'before-commit':
      return 'before-commit';
    default:
      throw new Error(`Unknown crash phase ${JSON.stringify(phaseName)}.`);
  }
}
