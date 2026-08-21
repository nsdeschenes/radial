import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import dataStatusResult from '#radial/data-producer/internal/DataStatusResult.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import isDuckDBBusyError from '#radial/db/duckdb/isDuckDBBusyError.js';

type DataStatusResult = RadialApplicationTypes['DataStatusResult'];
type DataStatusSuccess = RadialApplicationTypes['DataStatusSuccess'];
type ProducerSchemaInspection = Awaited<ReturnType<typeof producerSchema.inspect>>;

const LEGACY_TABLE_NAMES = [
  'airports',
  'airspaces',
  'hotspots',
  'navaids',
  'obstacles',
  'reporting_points',
] as const;

async function readDataStatus(
  instance: DuckDBInstance,
  databasePath: string
): Promise<DataStatusResult> {
  let connection: DuckDBConnection;
  try {
    connection = await instance.connect();
  } catch (error) {
    if (isDuckDBBusyError(error)) {
      return dataStatusResult.failure(
        'DATA_DATABASE_BUSY',
        'The configured database is busy.',
        'Another process owns the native DuckDB database file.',
        'Route the operation through the owning process or obtain exclusive maintenance access.'
      );
    }

    return dataStatusResult.failure(
      'DATA_DATABASE_UNAVAILABLE',
      'The configured database is unavailable.',
      'A read-only status connection could not be opened.',
      'Check database availability and retry.'
    );
  }

  try {
    try {
      const schema = await producerSchema.inspect(instance);
      return dataStatusResult.success(
        await inspectStatus(connection, databasePath, schema)
      );
    } catch (error) {
      if (error instanceof InvalidDataStatusError) {
        return dataStatusResult.failure(
          'DATA_DATABASE_INVALID',
          'The configured database is invalid.',
          error.message,
          'Inspect the configured database and retry with a valid Radial database.'
        );
      }

      if (isDuckDBBusyError(error)) {
        return dataStatusResult.failure(
          'DATA_DATABASE_BUSY',
          'The configured database is busy.',
          'Another process owns the native DuckDB database file.',
          'Route the operation through the owning process or obtain exclusive maintenance access.'
        );
      }

      return dataStatusResult.failure(
        'DATA_DATABASE_UNAVAILABLE',
        'The configured database is unavailable.',
        'The committed data status could not be read.',
        'Check database availability and retry.'
      );
    }
  } finally {
    connection.closeSync();
  }
}

async function inspectStatus(
  connection: DuckDBConnection,
  databasePath: string,
  schema: ProducerSchemaInspection
): Promise<DataStatusSuccess> {
  const legacyObjects = await readLegacyObjects(connection);

  if (schema.kind === 'absent') {
    return dataStatusResult.uninitializedValue(databasePath, legacyObjects);
  }

  if (schema.kind === 'invalid') {
    throw new InvalidDataStatusError(schema.diagnostic);
  }

  return {
    databasePath,
    status: schema.snapshot === null ? 'uninitialized' : 'ready',
    legacyObjects,
    producerSchema: {
      producerSchemaVersion: schema.producerSchemaVersion,
      plannerContractVersion: schema.plannerContractVersion,
      checksumManifestVersion: schema.checksumManifestVersion,
    },
    snapshot: schema.snapshot,
    cachedAirports: schema.cachedAirports,
  };
}

async function readLegacyObjects(
  connection: DuckDBConnection
): Promise<readonly string[]> {
  const result = await connection.runAndReadAll(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'main'
      AND table_name IN (${LEGACY_TABLE_NAMES.map(name => `'${name}'`).join(', ')})
    ORDER BY table_schema, table_name
  `);
  return result.getRowObjectsJS().map(row => {
    const schema = requiredString(row, 'table_schema');
    const name = requiredString(row, 'table_name');
    return `${schema}.${name}`;
  });
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidDataStatusError(`Committed ${field} is unavailable.`);
  }

  return value;
}

class InvalidDataStatusError extends Error {}

export default readDataStatus;
