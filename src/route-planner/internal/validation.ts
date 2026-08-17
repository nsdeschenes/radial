import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type InvalidRequestFailure = RoutePlannerTypes['InvalidRequestFailure'];
type PlannerOpenFailure = RoutePlannerTypes['PlannerOpenFailure'];
type RoutePlannerConfig = RoutePlannerTypes['RoutePlannerConfig'];
type RoutePlanningRequest = RoutePlannerTypes['RoutePlanningRequest'];

type Result<Value, Failure> = {ok: true; value: Value} | {ok: false; failure: Failure};

type ValidatedPlannerConfig = Readonly<{
  databasePath: string;
  maxRouteFactor: number;
}>;

type NormalizedRoutePlanningRequest = Readonly<{
  departureIcao: string;
  arrivalIcao: string;
}>;

const ICAO_PATTERN = /^[A-Z]{4}$/;

function validatePlannerConfig(
  config: RoutePlannerConfig
): Result<ValidatedPlannerConfig, PlannerOpenFailure> {
  if (config.databasePath.trim() === '') {
    return {
      ok: false,
      failure: {
        code: 'invalid-configuration',
        field: 'databasePath',
        reason: 'required',
        value: config.databasePath,
      },
    };
  }

  const maxRouteFactor = config.maxRouteFactor ?? 1.5;
  if (!Number.isFinite(maxRouteFactor) || maxRouteFactor < 1) {
    return {
      ok: false,
      failure: {
        code: 'invalid-configuration',
        field: 'maxRouteFactor',
        reason: 'must-be-finite-and-at-least-one',
        value: maxRouteFactor,
      },
    };
  }

  return {
    ok: true,
    value: Object.freeze({databasePath: config.databasePath, maxRouteFactor}),
  };
}

function validateRoutePlanningRequest(
  request: RoutePlanningRequest
): Result<NormalizedRoutePlanningRequest, InvalidRequestFailure> {
  const departureIcao = request.departureIcao.trim().toUpperCase();
  if (!ICAO_PATTERN.test(departureIcao)) {
    return invalidIcao('departureIcao', request.departureIcao, departureIcao);
  }

  const arrivalIcao = request.arrivalIcao.trim().toUpperCase();
  if (!ICAO_PATTERN.test(arrivalIcao)) {
    return invalidIcao('arrivalIcao', request.arrivalIcao, arrivalIcao);
  }

  if (departureIcao === arrivalIcao) {
    return {
      ok: false,
      failure: {
        code: 'invalid-request',
        field: 'arrivalIcao',
        reason: 'identical-airports',
        value: request.arrivalIcao,
        normalizedIcao: arrivalIcao,
      },
    };
  }

  return {ok: true, value: Object.freeze({departureIcao, arrivalIcao})};
}

function invalidIcao(
  field: 'departureIcao' | 'arrivalIcao',
  value: string,
  normalizedIcao: string
): Result<never, InvalidRequestFailure> {
  return {
    ok: false,
    failure: {
      code: 'invalid-request',
      field,
      reason: 'invalid-icao',
      value,
      normalizedIcao,
    },
  };
}

export default {validatePlannerConfig, validateRoutePlanningRequest};
