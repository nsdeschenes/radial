import commandCatalog from '#radial/cli/CliCommandCatalog.js';

function formatCliCompatibilityDiagnostic(invocation: readonly string[]): string {
  if (invocation[0] === 'data') {
    if (commandCatalog.dataStatus.rejection.owns(invocation)) {
      return commandCatalog.dataStatus.rejection.format(invocation);
    }

    if (commandCatalog.reloadAirport.rejection.owns(invocation)) {
      return commandCatalog.reloadAirport.rejection.format(invocation);
    }

    if (commandCatalog.reloadNavaids.rejection.owns(invocation)) {
      return commandCatalog.reloadNavaids.rejection.format(invocation);
    }
  }

  if (commandCatalog.routePlan.rejection.owns(invocation)) {
    return commandCatalog.routePlan.rejection.format(invocation);
  }

  throw new Error('No Radial command description owns the rejected invocation.');
}

export default formatCliCompatibilityDiagnostic;
