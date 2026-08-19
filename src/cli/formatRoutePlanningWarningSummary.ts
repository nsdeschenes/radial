import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

function formatRoutePlanningWarningSummary(
  success: RoutePlannerTypes['RoutePlanningSuccess']
): string {
  const warningCount = success.warnings.length;
  if (warningCount === 0) {
    return '';
  }

  const warningLabel = warningCount === 1 ? 'warning' : 'warnings';
  return `Route completed with ${warningCount} ${warningLabel}. Re-run with --warnings to view details.\n`;
}

export default formatRoutePlanningWarningSummary;
