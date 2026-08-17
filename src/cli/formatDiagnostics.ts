import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type InvalidRequestFailure = RoutePlannerTypes['InvalidRequestFailure'];
type PlannerOpenFailure = RoutePlannerTypes['PlannerOpenFailure'];
type RoutePlanningFailure = RoutePlannerTypes['RoutePlanningFailure'];

const USAGE =
  'Usage: radial <departure-icao> <arrival-icao>\n' + 'Example: radial CYYZ CYOW\n';

function formatArgumentCountDiagnostic(argumentCount: number): string {
  return `Expected exactly two ICAO airport codes; received ${argumentCount}.\n${USAGE}`;
}

function formatInvalidRequestDiagnostic(failure: InvalidRequestFailure): string {
  if (failure.reason === 'identical-airports') {
    return `Departure and arrival must be different airports; both normalize to ${JSON.stringify(failure.normalizedIcao)}.\n${USAGE}`;
  }

  const role = failure.field === 'departureIcao' ? 'Departure' : 'Arrival';
  return `${role} must be a four-letter ICAO airport code; received ${JSON.stringify(failure.value)}.\n${USAGE}`;
}

function formatPlannerOpenDiagnostic(failure: PlannerOpenFailure): string {
  switch (failure.code) {
    case 'invalid-configuration':
      if (failure.field === 'databasePath') {
        return 'Unable to initialize Route Planner: RADIAL_DATABASE_PATH is required.\n';
      }

      return (
        'Unable to initialize Route Planner: RADIAL_MAX_ROUTE_FACTOR must be a finite ' +
        `number greater than or equal to 1; received ${JSON.stringify(String(failure.value))}.\n`
      );
    case 'database-unavailable':
      return `Unable to initialize Route Planner: database at ${JSON.stringify(failure.databasePath)} is unavailable.\n`;
    case 'database-contract-invalid':
      return 'Unable to initialize Route Planner: the database contract is invalid.\n';
  }
}

function formatRoutePlanningDiagnostic(failure: RoutePlanningFailure): string {
  switch (failure.code) {
    case 'invalid-request':
      return formatInvalidRequestDiagnostic(failure);
    case 'airport-not-found':
      return `${capitalize(failure.role)} airport ${JSON.stringify(failure.normalizedIcao)} was not found in the local database.\n`;
    case 'airport-ambiguous':
      return `${capitalize(failure.role)} airport ${JSON.stringify(failure.normalizedIcao)} matched multiple usable records in the local database.\n`;
    case 'database-query-failed':
      return failure.operation === 'resolve-airports'
        ? 'Unable to plan route: the airport lookup query failed.\n'
        : 'Unable to plan route: a database query failed.\n';
    case 'no-route':
      return `No route found from ${failure.departureIcao} to ${failure.arrivalIcao}.\n`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default {
  formatArgumentCountDiagnostic,
  formatInvalidRequestDiagnostic,
  formatPlannerOpenDiagnostic,
  formatRoutePlanningDiagnostic,
};
