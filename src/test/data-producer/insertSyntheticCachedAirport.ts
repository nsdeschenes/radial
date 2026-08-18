import type {DuckDBInstance} from '@duckdb/node-api';

async function insertSyntheticCachedAirport(instance: DuckDBInstance): Promise<void> {
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

export default insertSyntheticCachedAirport;
