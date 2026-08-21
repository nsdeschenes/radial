import commandCatalog from '#radial/cli/CliCommandCatalog.js';

const NAVAID_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
  'Action: Run "radial data reload navaids".\n';
function formatCliCompatibilityDiagnostic(invocation: readonly string[]): string {
  if (invocation[0] === 'data') {
    if (commandCatalog.dataStatus.rejection.owns(invocation)) {
      return commandCatalog.dataStatus.rejection.format(invocation);
    }

    if (commandCatalog.reloadAirport.rejection.owns(invocation)) {
      return commandCatalog.reloadAirport.rejection.format(invocation);
    }

    return NAVAID_RELOAD_USAGE;
  }

  if (commandCatalog.routePlan.rejection.owns(invocation)) {
    return commandCatalog.routePlan.rejection.format(invocation);
  }

  throw new Error('No Radial command description owns the rejected invocation.');
}

export default formatCliCompatibilityDiagnostic;
