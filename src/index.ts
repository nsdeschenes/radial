import {loadEnvFile} from 'node:process';

// import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';
import DuckDB from '#radial/db/duckdb/duckdb.js';

loadEnvFile('./.env.local');

async function main() {
  using duckDbClient = new DuckDB();
  await duckDbClient.initialize();

  // const openAipClient = new OpenAIP(process.env['OPENAIP_API_KEY'] ?? '');
  // const airports = await openAipClient.airports({});
  // console.log('airports', airports);
}

await main();
