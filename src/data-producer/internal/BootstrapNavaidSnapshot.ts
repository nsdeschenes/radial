import type {DuckDBInstance} from '@duckdb/node-api';

import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';

type DataFailure = RadialApplicationTypes['DataFailure'];
type NavaidDataProducerDependencies = NonNullable<Parameters<typeof reloadNavaids>[2]>;
type BootstrapResult = Readonly<{ok: true}> | Readonly<{ok: false; failure: DataFailure}>;

async function ensureFirstNavaidSnapshot(
  instance: DuckDBInstance,
  openAipApiKey: string,
  dependencies: NavaidDataProducerDependencies = {}
): Promise<BootstrapResult> {
  let schemaExists: boolean;
  try {
    schemaExists = await initializeProducerSchema.producerSchemaExists(instance);
  } catch {
    return databaseInvalid();
  }

  if (schemaExists) {
    try {
      await initializeProducerSchema(instance);
      if (
        (await initializeProducerSchema.readActiveNavaidSnapshotId(instance)) !== null
      ) {
        return {ok: true};
      }
    } catch {
      return databaseInvalid();
    }
  }

  if (openAipApiKey.trim() === '') {
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

  try {
    await initializeProducerSchema(instance);
  } catch {
    return databaseInvalid();
  }

  const reloaded = await reloadNavaids(instance, {openAipApiKey}, dependencies);
  return reloaded.ok ? {ok: true} : reloaded;
}

function databaseInvalid(): BootstrapResult {
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

export default ensureFirstNavaidSnapshot;
