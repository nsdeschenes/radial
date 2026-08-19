import {expect, test} from 'vitest';

import formatRoutePlan from '#radial/cli/formatRoutePlan.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type RoutePlan = RoutePlannerTypes['RoutePlan'];

test('renders the complete Route Plan with display-only rounding and calculated alignment', () => {
  expect(formatRoutePlan(createRoutePlan())).toBe(
    'Route Points: CYYZ → YTP → CYOW\n' +
      'Total Distance: 298.0 NM\n' +
      'Route Legs: 2\n' +
      'Route Search Mode: VOR-family only\n' +
      '\n' +
      'Route Legs\n' +
      'Leg  From  To    Distance  Outbound True  Arrival True  Outbound Magnetic  Arrival Magnetic  Departure VOR Guidance  Arrival VOR Guidance\n' +
      '  1  CYYZ  YTP   123.5 NM           006°          355°               001°              000°  —                       Inbound 359°\n' +
      '  2  YTP   CYOW  174.6 NM           005°          007°               000°                 —  Outbound 358°           —\n' +
      '\n' +
      'Navaids\n' +
      'Identifier  Type      Frequency  Published Range\n' +
      'YTP         VOR-DME  113.70 MHz         150.0 NM\n'
  );
});

test('renders each used Navaid once with its exact type and conventional frequency unit', () => {
  const plan = createRoutePlan();
  const ndb = {
    kind: 'ndb' as const,
    databaseId: 'ndb-1',
    identifier: 'ÅÄÖ-LONG-NAVAID',
    name: 'Unicode NDB',
    longitude: -78,
    latitude: 44,
    magneticDeclinationDegEast: null,
    frequency: {unit: 'kHz' as const, value: 365.5},
    publishedRangeNm: 75.04,
  };

  expect(
    formatRoutePlan({
      ...plan,
      searchMode: 'ndb-fallback',
      routePoints: [plan.routePoints[0]!, ndb, ndb, plan.routePoints[2]!],
      routeLegs: [],
    })
  ).toContain(
    'Navaids\n' +
      'Identifier       Type  Frequency  Published Range\n' +
      'ÅÄÖ-LONG-NAVAID  NDB   365.5 kHz          75.0 NM\n'
  );
});

test('wraps long Route Point sequences at 100 characters only between points', () => {
  const plan = createRoutePlan();
  const routePoints = Array.from({length: 13}, (_, index) => ({
    ...plan.routePoints[0]!,
    databaseId: `airport-${index}`,
    icao: `P${String(index).padStart(3, '0')}`,
  }));
  const output = formatRoutePlan({...plan, routePoints, routeLegs: []});
  const [firstLine, secondLine] = output.split('\n');

  expect(firstLine).toBe(
    'Route Points: P000 → P001 → P002 → P003 → P004 → P005 → P006 → P007 → P008 → P009 → P010 → P011'
  );
  expect(firstLine).toHaveLength(95);
  expect(secondLine).toBe('              P012');
});

function createRoutePlan(): RoutePlan {
  const departure: RoutePlannerTypes['AirportRoutePoint'] = {
    kind: 'airport',
    databaseId: 'airport-departure',
    icao: 'CYYZ',
    name: 'Toronto Pearson',
    longitude: -79.6306,
    latitude: 43.6777,
    magneticDeclinationDegEast: 5,
  };
  const navaid: RoutePlannerTypes['RoutePoint'] = {
    kind: 'vor-family',
    databaseId: 'navaid-ytp',
    identifier: 'YTP',
    name: 'Toronto VOR/DME',
    family: 'VOR-DME',
    longitude: -79.587,
    latitude: 43.67,
    magneticDeclinationDegEast: 5,
    frequency: {unit: 'MHz', value: 113.7},
    publishedRangeNm: 149.96,
    facilityVariation: {
      degreesEast: 7,
      source: 'Synthetic chart',
      effectiveDate: '2025-01-01',
    },
  };
  const arrival: RoutePlannerTypes['AirportRoutePoint'] = {
    kind: 'airport',
    databaseId: 'airport-arrival',
    icao: 'CYOW',
    name: 'Ottawa',
    longitude: -75.6692,
    latitude: 45.3225,
    magneticDeclinationDegEast: null,
  };

  return {
    totalDistanceNm: 298.04,
    searchMode: 'vor-family',
    routePoints: [departure, navaid, arrival],
    routeLegs: [
      {
        departure,
        arrival: navaid,
        distanceNm: 123.45,
        departureTrueCourseDeg: 5.5,
        arrivalTrueCourseDeg: 354.5,
        departureMagneticCourseDeg: 0.5,
        arrivalMagneticCourseDeg: 359.5,
        departureVorGuidance: null,
        arrivalVorGuidance: {trueCourseDeg: 5.5, magneticCourseDeg: 358.5},
      },
      {
        departure: navaid,
        arrival,
        distanceNm: 174.59,
        departureTrueCourseDeg: 4.5,
        arrivalTrueCourseDeg: 6.5,
        departureMagneticCourseDeg: 359.5,
        arrivalMagneticCourseDeg: null,
        departureVorGuidance: {trueCourseDeg: 4.5, magneticCourseDeg: 357.5},
        arrivalVorGuidance: null,
      },
    ],
    magneticReference: null,
  };
}
