import {expect, test} from 'vitest';

import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import formatRoutePlanningWarningSummary from '#radial/cli/formatRoutePlanningWarningSummary.js';
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
    'Warnings (4)\n' +
      '\n' +
      'NDB fallback\n' +
      '  The VOR-family search was exhausted. The route uses NDBs instead.\n' +
      '  Applies to the whole route.\n' +
      '\n' +
      'Magnetic course unavailable\n' +
      '  Local Magnetic Declination is missing, so magnetic courses could not be calculated.\n' +
      '  Leg 1: CYYZ departure\n' +
      '\n' +
      'VOR guidance unavailable\n' +
      '  Facility Variation of Record is missing, so VOR guidance could not be calculated.\n' +
      '  Leg 1: YTP arrival\n' +
      '\n' +
      'Facility variation date unavailable\n' +
      '  VOR guidance uses Facility Variation of Record without an effective date.\n' +
      '  Leg 2: YTP departure\n'
  );
});

test('renders no stderr text when a successful Route Plan has no warnings', () => {
  const success: RoutePlannerTypes['RoutePlanningSuccess'] = {
    plan: {
      totalDistanceNm: 0,
      searchMode: 'vor-family',
      routePoints: [],
      routeLegs: [],
      magneticReference: null,
    },
    warnings: [],
  };

  expect(formatRoutePlanningWarningSummary(success)).toBe('');
  expect(formatRoutePlanningWarnings(success)).toBe('');
});

test('summarizes a single warning with the details flag', () => {
  expect(
    formatRoutePlanningWarningSummary({
      plan: {
        totalDistanceNm: 0,
        searchMode: 'ndb-fallback',
        routePoints: [],
        routeLegs: [],
        magneticReference: null,
      },
      warnings: [{code: 'ndb-fallback-used'}],
    })
  ).toBe('Route completed with 1 warning. Re-run with --warnings to view details.\n');
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
