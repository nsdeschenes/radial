import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import validation from '#radial/route-planner/internal/validation.js';

const DATA_STATUS_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The data status command accepts no arguments or operational flags.\n' +
  'Action: Run "radial data status".\n';
const NAVAID_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
  'Action: Run "radial data reload navaids".\n';
const AIRPORT_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
  'Action: Run "radial data reload airport <ICAO>".\n';

function formatCliCompatibilityDiagnostic(invocation: readonly string[]): string {
  if (invocation[0] === 'data') {
    if (invocation[1] === 'status') {
      return DATA_STATUS_USAGE;
    }

    if (invocation[1] === 'reload' && invocation[2] === 'airport') {
      if (
        invocation.length === 4 &&
        invocation[3]?.startsWith('--') === false &&
        !validation.validateAirportIcao(invocation[3]).ok
      ) {
        return formatInvalidAirportIcao(invocation[3]);
      }

      return AIRPORT_RELOAD_USAGE;
    }

    return NAVAID_RELOAD_USAGE;
  }

  const routeArguments =
    invocation.at(-1) === '--warnings' ? invocation.slice(0, -1) : invocation;
  if (routeArguments.length !== 2) {
    return diagnostics.formatArgumentCountDiagnostic(routeArguments.length);
  }

  const validated = validation.validateRoutePlanningRequest({
    arrivalIcao: routeArguments[1] ?? '',
    departureIcao: routeArguments[0] ?? '',
  });
  return validated.ok
    ? diagnostics.formatArgumentCountDiagnostic(routeArguments.length)
    : diagnostics.formatInvalidRequestDiagnostic(validated.failure);
}

function formatInvalidAirportIcao(value: string): string {
  return airportReloadOutput.formatFailure({
    code: 'DATA_INVALID_ICAO',
    summary: 'The Airport ICAO is invalid.',
    cause: `The requested Airport ICAO ${JSON.stringify(value)} is not four ASCII letters.`,
    action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
    activeDataPreserved: true,
  });
}

export default formatCliCompatibilityDiagnostic;
