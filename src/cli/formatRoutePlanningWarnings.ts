import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type RoutePlanningSuccess = RoutePlannerTypes['RoutePlanningSuccess'];
type RoutePlanningWarning = RoutePlannerTypes['RoutePlanningWarning'];

function formatRoutePlanningWarnings(success: RoutePlanningSuccess): string {
  if (success.warnings.length === 0) {
    return '';
  }

  const warningsByCode = new Map<RoutePlanningWarning['code'], RoutePlanningWarning[]>();

  for (const warning of success.warnings) {
    const warnings = warningsByCode.get(warning.code) ?? [];
    warnings.push(warning);
    warningsByCode.set(warning.code, warnings);
  }

  const groups = Array.from(warningsByCode.entries(), ([code, warnings]) =>
    formatWarningGroup(code, warnings, success.plan.routeLegs)
  );

  return `Warnings (${success.warnings.length})\n\n${groups.join('\n')}`;
}

function formatWarningGroup(
  code: RoutePlanningWarning['code'],
  warnings: readonly RoutePlanningWarning[],
  routeLegs: RoutePlannerTypes['RoutePlan']['routeLegs']
): string {
  if (code === 'ndb-fallback-used') {
    return (
      'NDB fallback\n' +
      '  The VOR-family search was exhausted. The route uses NDBs instead.\n' +
      '  Applies to the whole route.\n'
    );
  }

  let title: string;
  let description: string;
  switch (code) {
    case 'magnetic-course-unavailable':
      title = 'Magnetic course unavailable';
      description =
        'Local Magnetic Declination is missing, so magnetic courses could not be calculated.';
      break;
    case 'vor-guidance-unavailable':
      title = 'VOR guidance unavailable';
      description =
        'Facility Variation of Record is missing, so VOR guidance could not be calculated.';
      break;
    case 'facility-variation-date-unavailable':
      title = 'Facility variation date unavailable';
      description =
        'VOR guidance uses Facility Variation of Record without an effective date.';
      break;
  }

  const count = warnings.length > 1 ? ` ×${warnings.length}` : '';
  return `${title}${count}\n  ${description}\n${formatWarningLocations(warnings, routeLegs)}`;
}

function formatWarningLocations(
  warnings: readonly RoutePlanningWarning[],
  routeLegs: RoutePlannerTypes['RoutePlan']['routeLegs']
): string {
  const locationsByLeg = new Map<number, string[]>();

  for (const warning of warnings) {
    if (warning.code === 'ndb-fallback-used') {
      continue;
    }

    const routeLeg = routeLegs[warning.legNumber - 1];
    if (routeLeg === undefined) {
      throw new Error(`Warning references missing Route Leg ${warning.legNumber}.`);
    }

    const routePoint = routeLeg[warning.endpoint];
    const identifier =
      routePoint.kind === 'airport' ? routePoint.icao : routePoint.identifier;
    const locations = locationsByLeg.get(warning.legNumber) ?? [];
    locations.push(`${identifier} ${warning.endpoint}`);
    locationsByLeg.set(warning.legNumber, locations);
  }

  return Array.from(
    locationsByLeg.entries(),
    ([legNumber, locations]) => `  Leg ${legNumber}: ${locations.join(', ')}\n`
  ).join('');
}

export default formatRoutePlanningWarnings;
