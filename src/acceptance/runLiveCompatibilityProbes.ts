import parseJsonWithUniqueKeys from '#radial/data-producer/internal/JsonWithUniqueKeys.js';
import acquireProductionFAANasrCycle from '#radial/data-producer/internal/ProductionFAANasrCycleSource.js';
import createProductionOpenAIPNavaidTransport from '#radial/data-producer/internal/ProductionOpenAIPNavaidTransport.js';

const apiKey = process.env['OPENAIP_API_KEY'];

if (apiKey === undefined || apiKey.trim() === '') {
  process.stderr.write('Usage: OPENAIP_API_KEY=<key> nub run acceptance:compatibility\n');
  process.exitCode = 2;
} else {
  try {
    const transport = createProductionOpenAIPNavaidTransport(apiKey);
    const response = await transport({
      page: 1,
      limit: 1000,
      sortBy: '_id',
      sortDesc: false,
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    });
    if (response.status !== 200) {
      throw new Error(`OpenAIP Navaid probe returned HTTP ${response.status}.`);
    }

    const navaidPage = parseJsonWithUniqueKeys(response.body) as {items?: unknown};
    if (!Array.isArray(navaidPage.items)) {
      throw new Error('OpenAIP Navaid probe returned an incompatible page.');
    }

    const retrievalStartedAt = new Date().toISOString();
    const cycles = await acquireProductionFAANasrCycle(retrievalStartedAt);
    const cycle = cycles[0];
    if (cycle === undefined) {
      throw new Error('FAA NASR probe returned no applicable cycle.');
    }

    process.stdout.write(
      `OpenAIP Navaids: page 1 compatible (${navaidPage.items.length} records).\n`
    );
    process.stdout.write(
      `FAA NASR: cycle ${cycle.cycleId} compatible (${cycle.records.length} NAV_BASE records).\n`
    );
    process.stdout.write(
      'Compatibility probes completed; results are manual and non-gating.\n'
    );
  } catch (error) {
    process.stderr.write(
      `Compatibility probe failed: ${error instanceof Error ? error.message : 'upstream source was incompatible.'}\n`
    );
    process.exitCode = 1;
  }
}
