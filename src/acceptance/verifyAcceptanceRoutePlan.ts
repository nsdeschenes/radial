import type RoutePlannerAcceptanceTypes from '#radial/acceptance/RoutePlannerAcceptanceTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

const METRES_PER_NAUTICAL_MILE = 1852;
const SPHERICAL_EARTH_RADIUS_METRES = 6_371_000;

function verifyAcceptanceRoutePlan(
  plan: RoutePlannerTypes['RoutePlan'],
  baseline: RoutePlannerAcceptanceTypes['AcceptanceBaseline']
): void {
  if (plan.routeLegs.length === 0 || plan.routePoints.length < 3) {
    throw new Error(
      'Acceptance Route Plan must contain at least one Navaid and Route Leg.'
    );
  }

  const departure = plan.routePoints[0];
  const arrival = plan.routePoints.at(-1);
  if (
    departure?.kind !== 'airport' ||
    departure.icao !== baseline.route.departureIcao ||
    arrival?.kind !== 'airport' ||
    arrival.icao !== baseline.route.arrivalIcao
  ) {
    throw new Error(
      'Acceptance Route Plan airports do not match the normalized baseline route.'
    );
  }

  if (plan.searchMode !== baseline.route.searchMode) {
    throw new Error(
      `Route Search Mode mismatch: expected ${baseline.route.searchMode}, received ${plan.searchMode}.`
    );
  }

  if (
    JSON.stringify(plan.magneticReference) !==
    JSON.stringify(baseline.snapshot.magneticReference)
  ) {
    throw new Error('Snapshot magnetic reference does not match the baseline.');
  }

  const orderedNavaids = plan.routePoints
    .filter(routePoint => routePoint.kind !== 'airport')
    .map(routePoint => ({
      databaseId: routePoint.databaseId,
      identifier: routePoint.identifier,
    }));
  if (JSON.stringify(orderedNavaids) !== JSON.stringify(baseline.route.orderedNavaids)) {
    throw new Error('Ordered Navaid identities do not match the baseline.');
  }

  if (plan.routeLegs.length !== plan.routePoints.length - 1) {
    throw new Error(
      'Route Plan does not contain exactly one Route Leg per adjacent pair.'
    );
  }

  let summedDistanceNm = 0;
  for (const [index, leg] of plan.routeLegs.entries()) {
    if (
      leg.departure.databaseId !== plan.routePoints[index]?.databaseId ||
      leg.arrival.databaseId !== plan.routePoints[index + 1]?.databaseId
    ) {
      throw new Error(`Route Leg ${index + 1} is not continuous with its Route Points.`);
    }

    verifyNavigableRouteLeg(leg, index + 1);
    summedDistanceNm += leg.distanceNm;
  }

  if (summedDistanceNm !== plan.totalDistanceNm) {
    throw new Error('Route Plan total does not equal the exact ordered Route Leg sum.');
  }

  const directDistanceNm = sphericalDistanceNm(departure, arrival);
  if (plan.totalDistanceNm > directDistanceNm * baseline.route.maxRouteFactor) {
    throw new Error('Route Plan exceeds the configured direct-distance cap.');
  }
}

function verifyNavigableRouteLeg(
  leg: RoutePlannerTypes['RouteLeg'],
  legNumber: number
): void {
  let coverageNm: number;
  if (leg.departure.kind === 'airport' && leg.arrival.kind !== 'airport') {
    coverageNm = leg.arrival.publishedRangeNm;
  } else if (leg.departure.kind !== 'airport' && leg.arrival.kind === 'airport') {
    coverageNm = leg.departure.publishedRangeNm;
  } else if (leg.departure.kind !== 'airport' && leg.arrival.kind !== 'airport') {
    coverageNm = leg.departure.publishedRangeNm + leg.arrival.publishedRangeNm;
  } else {
    throw new Error(`Route Leg ${legNumber} is a direct airport-to-airport leg.`);
  }

  if (leg.distanceNm > coverageNm) {
    throw new Error(`Route Leg ${legNumber} exceeds published Navaid coverage.`);
  }
}

function sphericalDistanceNm(
  departure: RoutePlannerTypes['RoutePoint'],
  arrival: RoutePlannerTypes['RoutePoint']
): number {
  const radiansPerDegree = Math.PI / 180;
  const departureLatitude = departure.latitude * radiansPerDegree;
  const arrivalLatitude = arrival.latitude * radiansPerDegree;
  const latitudeDifference = arrivalLatitude - departureLatitude;
  const longitudeDifference =
    (arrival.longitude - departure.longitude) * radiansPerDegree;
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(departureLatitude) *
      Math.cos(arrivalLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return (SPHERICAL_EARTH_RADIUS_METRES * centralAngle) / METRES_PER_NAUTICAL_MILE;
}

export default verifyAcceptanceRoutePlan;
