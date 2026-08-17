import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type Coordinates = Readonly<{longitude: number; latitude: number}>;
type RouteLeg = RoutePlannerTypes['RouteLeg'];
type RoutePoint = RoutePlannerTypes['RoutePoint'];

type EndpointTrueCourses = Readonly<{
  departureTrueCourseDeg: number;
  arrivalTrueCourseDeg: number;
}>;

const DEGREES_PER_RADIAN = 180 / Math.PI;
const RADIANS_PER_DEGREE = Math.PI / 180;

function calculateEndpointTrueCourses(
  departure: Coordinates,
  arrival: Coordinates
): EndpointTrueCourses {
  return {
    departureTrueCourseDeg: initialTrueCourse(departure, arrival),
    arrivalTrueCourseDeg: normalizeCourse(initialTrueCourse(arrival, departure) + 180),
  };
}

function initialTrueCourse(departure: Coordinates, arrival: Coordinates): number {
  const departureLatitude = departure.latitude * RADIANS_PER_DEGREE;
  const arrivalLatitude = arrival.latitude * RADIANS_PER_DEGREE;
  const longitudeDifference =
    (arrival.longitude - departure.longitude) * RADIANS_PER_DEGREE;
  const y = Math.sin(longitudeDifference) * Math.cos(arrivalLatitude);
  const x =
    Math.cos(departureLatitude) * Math.sin(arrivalLatitude) -
    Math.sin(departureLatitude) *
      Math.cos(arrivalLatitude) *
      Math.cos(longitudeDifference);

  return normalizeCourse(Math.atan2(y, x) * DEGREES_PER_RADIAN);
}

function normalizeCourse(courseDeg: number): number {
  return ((courseDeg % 360) + 360) % 360;
}

function toMagneticCourse(
  trueCourseDeg: number,
  degreesEast: number | null
): number | null {
  return degreesEast === null ? null : normalizeCourse(trueCourseDeg - degreesEast);
}

function createRouteLeg(
  departure: RoutePoint,
  arrival: RoutePoint,
  distanceNm: number
): RouteLeg {
  const {departureTrueCourseDeg, arrivalTrueCourseDeg} = calculateEndpointTrueCourses(
    departure,
    arrival
  );

  return {
    departure,
    arrival,
    distanceNm,
    departureTrueCourseDeg,
    arrivalTrueCourseDeg,
    departureMagneticCourseDeg: toMagneticCourse(
      departureTrueCourseDeg,
      departure.magneticDeclinationDegEast
    ),
    arrivalMagneticCourseDeg: toMagneticCourse(
      arrivalTrueCourseDeg,
      arrival.magneticDeclinationDegEast
    ),
    departureVorGuidance:
      departure.kind === 'vor-family' && departure.facilityVariation !== null
        ? {
            trueCourseDeg: departureTrueCourseDeg,
            magneticCourseDeg: toMagneticCourse(
              departureTrueCourseDeg,
              departure.facilityVariation.degreesEast
            ),
          }
        : null,
    arrivalVorGuidance:
      arrival.kind === 'vor-family' && arrival.facilityVariation !== null
        ? {
            trueCourseDeg: arrivalTrueCourseDeg,
            magneticCourseDeg: toMagneticCourse(
              arrivalTrueCourseDeg,
              arrival.facilityVariation.degreesEast
            ),
          }
        : null,
  };
}

export default {
  calculateEndpointTrueCourses,
  createRouteLeg,
  normalizeCourse,
  toMagneticCourse,
};
