import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type RouteLeg = RoutePlannerTypes['RouteLeg'];
type RouteSearchMode = RoutePlannerTypes['RoutePlan']['searchMode'];
type RoutePlanningWarning = RoutePlannerTypes['RoutePlanningWarning'];

function deriveWarnings(
  routeLegs: readonly RouteLeg[],
  searchMode: RouteSearchMode
): readonly RoutePlanningWarning[] {
  const magneticCourseWarnings: RoutePlanningWarning[] = [];
  const vorGuidanceWarnings: RoutePlanningWarning[] = [];
  const facilityDateWarnings: RoutePlanningWarning[] = [];

  for (const [index, routeLeg] of routeLegs.entries()) {
    const legNumber = index + 1;
    for (const endpoint of ['departure', 'arrival'] as const) {
      const routePoint = routeLeg[endpoint];
      const magneticCourse = routeLeg[`${endpoint}MagneticCourseDeg`];
      const vorGuidance = routeLeg[`${endpoint}VorGuidance`];

      if (magneticCourse === null) {
        magneticCourseWarnings.push({
          code: 'magnetic-course-unavailable',
          legNumber,
          endpoint,
        });
      }
      if (routePoint.kind === 'vor-family' && vorGuidance === null) {
        vorGuidanceWarnings.push({
          code: 'vor-guidance-unavailable',
          legNumber,
          endpoint,
        });
      }
      if (
        routePoint.kind === 'vor-family' &&
        routePoint.facilityVariation !== null &&
        routePoint.facilityVariation.effectiveDate === null
      ) {
        facilityDateWarnings.push({
          code: 'facility-variation-date-unavailable',
          legNumber,
          endpoint,
        });
      }
    }
  }

  return [
    ...(searchMode === 'ndb-fallback' ? ([{code: 'ndb-fallback-used'}] as const) : []),
    ...magneticCourseWarnings,
    ...vorGuidanceWarnings,
    ...facilityDateWarnings,
  ];
}

export default deriveWarnings;
