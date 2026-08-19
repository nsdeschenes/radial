import type {DuckDBInstance} from '@duckdb/node-api';

import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import initializeProducerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import isDuckDBBusyError from '#radial/db/duckdb/isDuckDBBusyError.js';

type DataFailure = RadialApplicationTypes['DataFailure'];
type NavaidDataProducerDependencies = NonNullable<Parameters<typeof reloadNavaids>[3]>;
type BootstrapResult = Readonly<{ok: true}> | Readonly<{ok: false; failure: DataFailure}>;

async function ensureFirstNavaidSnapshot(
  instance: DuckDBInstance,
  openAipApiKey: string,
  publicationGate: PublicationGate,
  dependencies: NavaidDataProducerDependencies = {}
): Promise<BootstrapResult> {
  let readiness: 'ready' | 'bootstrap' | 'credentials-missing';
  try {
    readiness = await publicationGate.run(async () => {
      const schemaExists = await initializeProducerSchema.producerSchemaExists(instance);
      if (schemaExists) {
        await initializeProducerSchema(instance);
        if (
          (await initializeProducerSchema.readActiveNavaidSnapshotId(instance)) !== null
        ) {
          return 'ready';
        }
      }

      if (openAipApiKey.trim() === '') {
        return 'credentials-missing';
      }

      await initializeProducerSchema(instance);
      return 'bootstrap';
    });
  } catch (error) {
    return isDuckDBBusyError(error) ? databaseBusy() : databaseInvalid();
  }

  if (readiness === 'ready') {
    return {ok: true};
  }

  if (readiness === 'credentials-missing') {
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

  const reloaded = await reloadNavaids(
    instance,
    {openAipApiKey},
    publicationGate,
    dependencies
  );
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

function databaseBusy(): BootstrapResult {
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

export default ensureFirstNavaidSnapshot;
