import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type RoutePlanningSuccess = RoutePlannerTypes['RoutePlanningSuccess'];
type RoutePlanningWarning = RoutePlannerTypes['RoutePlanningWarning'];

function formatRoutePlanningWarnings(success: RoutePlanningSuccess): string {
  return success.warnings
    .map(warning => formatWarning(warning, success.plan.routeLegs))
    .join('');
}

function formatWarning(
  warning: RoutePlanningWarning,
  routeLegs: RoutePlannerTypes['RoutePlan']['routeLegs']
): string {
  if (warning.code === 'ndb-fallback-used') {
    return 'Warning: NDB fallback was used after the VOR-family search was exhausted.\n';
  }

  const routeLeg = routeLegs[warning.legNumber - 1];
  if (routeLeg === undefined) {
    throw new Error(`Warning references missing Route Leg ${warning.legNumber}.`);
  }
  const routePoint = routeLeg[warning.endpoint];
  const identifier =
    routePoint.kind === 'airport' ? routePoint.icao : routePoint.identifier;
  const context = `Route Leg ${warning.legNumber} ${warning.endpoint}`;

  switch (warning.code) {
    case 'magnetic-course-unavailable':
      return `Warning: ${context} magnetic course is unavailable at ${identifier} because Local Magnetic Declination is unavailable.\n`;
    case 'vor-guidance-unavailable':
      return `Warning: ${context} VOR Guidance is unavailable at ${identifier} because Facility Variation of Record is unavailable.\n`;
    case 'facility-variation-date-unavailable':
      return `Warning: ${context} VOR Guidance at ${identifier} uses Facility Variation of Record without an effective date.\n`;
  }
}

export default formatRoutePlanningWarnings;
