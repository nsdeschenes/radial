import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import dataReloadOutput from '#radial/cli/formatDataReload.js';

function formatSuccess(success: RadialApplicationTypes['AirportReloadSuccess']): string {
  return (
    `Cached Airport ${success.status}\n` +
    `  ICAO: ${success.icao}\n` +
    `  OpenAIP ID: ${success.sourceId}\n` +
    `  Retrieved: ${success.retrievedAt}\n`
  );
}

export default {
  formatFailure: dataReloadOutput.formatFailure,
  formatProgress: dataReloadOutput.formatProgress,
  formatSuccess,
};
