import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';

type DataReloadProgress =
  | RadialApplicationTypes['AirportReloadProgress']
  | RadialApplicationTypes['NavaidReloadProgress'];

function formatProgress(progress: DataReloadProgress): string {
  return `progress: ${progress.message}\n`;
}

function formatFailure(failure: RadialApplicationTypes['DataFailure']): string {
  return (
    `error [${failure.code}]: ${failure.summary}\n` +
    `Cause: ${failure.cause}\n` +
    `Action: ${failure.action}\n` +
    (failure.activeDataPreserved ? 'Active data remains unchanged.\n' : '')
  );
}

export default {formatFailure, formatProgress};
