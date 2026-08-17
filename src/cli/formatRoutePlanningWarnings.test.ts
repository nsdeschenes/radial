import {expect, test} from 'vitest';

import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

test('renders ordered warnings separately with their Route Leg endpoint context', () => {
  const departure = airport('CYYZ', 'departure');
  const navaid: RoutePlannerTypes['VorFamilyRoutePoint'] = {
    kind: 'vor-family',
    databaseId: 'navaid',
    identifier: 'YTP',
    name: 'Toronto VOR/DME',
    longitude: -79,
    latitude: 44,
    magneticDeclinationDegEast: null,
    family: 'VOR-DME',
    frequency: {unit: 'MHz', value: 113.7},
    publishedRangeNm: 100,
    facilityVariation: {degreesEast: 7, source: 'Chart', effectiveDate: null},
  };
  const arrival = airport('CYOW', 'arrival');
  const routeLegs: readonly RoutePlannerTypes['RouteLeg'][] = [
    routeLeg(departure, navaid),
    routeLeg(navaid, arrival),
  ];
  const success: RoutePlannerTypes['RoutePlanningSuccess'] = {
    plan: {
      totalDistanceNm: 200,
      searchMode: 'ndb-fallback',
      routePoints: [departure, navaid, arrival],
      routeLegs,
      magneticReference: null,
    },
    warnings: [
      {code: 'ndb-fallback-used'},
      {code: 'magnetic-course-unavailable', legNumber: 1, endpoint: 'departure'},
      {code: 'vor-guidance-unavailable', legNumber: 1, endpoint: 'arrival'},
      {
        code: 'facility-variation-date-unavailable',
        legNumber: 2,
        endpoint: 'departure',
      },
    ],
  };

  expect(formatRoutePlanningWarnings(success)).toBe(
    'Warning: NDB fallback was used after the VOR-family search was exhausted.\n' +
      'Warning: Route Leg 1 departure magnetic course is unavailable at CYYZ because Local Magnetic Declination is unavailable.\n' +
      'Warning: Route Leg 1 arrival VOR Guidance is unavailable at YTP because Facility Variation of Record is unavailable.\n' +
      'Warning: Route Leg 2 departure VOR Guidance at YTP uses Facility Variation of Record without an effective date.\n'
  );
});

test('renders no stderr text when a successful Route Plan has no warnings', () => {
  expect(
    formatRoutePlanningWarnings({
      plan: {
        totalDistanceNm: 0,
        searchMode: 'vor-family',
        routePoints: [],
        routeLegs: [],
        magneticReference: null,
      },
      warnings: [],
    })
  ).toBe('');
});

function airport(
  icao: string,
  databaseId: string
): RoutePlannerTypes['AirportRoutePoint'] {
  return {
    kind: 'airport',
    databaseId,
    icao,
    name: icao,
    longitude: 0,
    latitude: 0,
    magneticDeclinationDegEast: null,
  };
}

function routeLeg(
  departure: RoutePlannerTypes['RoutePoint'],
  arrival: RoutePlannerTypes['RoutePoint']
): RoutePlannerTypes['RouteLeg'] {
  return {
    departure,
    arrival,
    distanceNm: 100,
    departureTrueCourseDeg: 90,
    arrivalTrueCourseDeg: 90,
    departureMagneticCourseDeg: null,
    arrivalMagneticCourseDeg: null,
    departureVorGuidance: null,
    arrivalVorGuidance: null,
  };
}
