import {loadEnvFile} from 'node:process';

import OpenAIP from '#radial/clients/OpenAIP/OpenAIP.js';

loadEnvFile('./.env.local');

async function main() {
  const client = new OpenAIP(process.env['OPENAIP_API_KEY'] ?? '');

  const airports = await client.airports({});

  console.log('airports', airports);
}

await main();
