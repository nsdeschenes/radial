import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';

type DataStatusResult = RadialApplicationTypes['DataStatusResult'];
type DataStatusSuccess = RadialApplicationTypes['DataStatusSuccess'];

function uninitializedValue(
  databasePath: string,
  legacyObjects: readonly string[] = []
): DataStatusSuccess {
  return {
    databasePath,
    status: 'uninitialized',
    legacyObjects,
    producerSchema: null,
    snapshot: null,
    cachedAirports: [],
  };
}

function failure(
  code: RadialApplicationTypes['DataFailure']['code'],
  summary: string,
  cause: string,
  action: string
): DataStatusResult {
  return {
    ok: false,
    failure: {code, summary, cause, action, activeDataPreserved: true},
  };
}

function success(value: DataStatusSuccess): DataStatusResult {
  return {ok: true, value};
}

export default {failure, success, uninitializedValue};
