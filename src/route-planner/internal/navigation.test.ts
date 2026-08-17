import {expect, test} from 'vitest';

import navigation from '#radial/route-planner/internal/navigation.js';

test('calculates independently worked endpoint courses without rounding', () => {
  // Worked from the spherical-course equations independently documented at
  // https://www.movable-type.co.uk/scripts/latlong.html.
  const courses = navigation.calculateEndpointTrueCourses(
    {longitude: 0, latitude: 0},
    {longitude: 10, latitude: 20}
  );

  expect(courses.departureTrueCourseDeg).toBeCloseTo(25.505550260982545, 12);
  expect(courses.arrivalTrueCourseDeg).toBeCloseTo(27.273169556803623, 12);
  expect(courses.arrivalTrueCourseDeg).not.toBe(courses.departureTrueCourseDeg);
});

test('normalizes endpoint courses across the antimeridian', () => {
  const eastbound = navigation.calculateEndpointTrueCourses(
    {longitude: 179, latitude: 10},
    {longitude: -179, latitude: 11}
  );
  const westbound = navigation.calculateEndpointTrueCourses(
    {longitude: -179, latitude: 11},
    {longitude: 179, latitude: 10}
  );

  expect(eastbound).toEqual({
    departureTrueCourseDeg: 62.86635887707865,
    arrivalTrueCourseDeg: 63.230879590990696,
  });
  expect(westbound.departureTrueCourseDeg).toBeCloseTo(243.2308795909907, 12);
  expect(westbound.arrivalTrueCourseDeg).toBeCloseTo(242.86635887707865, 12);
});

test.each([
  {
    name: 'subtracts east-positive declination',
    trueCourseDeg: 100,
    degreesEast: 7,
    magneticCourseDeg: 93,
  },
  {
    name: 'adds west-positive declination',
    trueCourseDeg: 100,
    degreesEast: -7,
    magneticCourseDeg: 107,
  },
  {
    name: 'wraps below zero',
    trueCourseDeg: 2,
    degreesEast: 7,
    magneticCourseDeg: 355,
  },
  {
    name: 'wraps above 360',
    trueCourseDeg: 358,
    degreesEast: -7,
    magneticCourseDeg: 5,
  },
])('$name when calculating a magnetic course', scenario => {
  expect(navigation.toMagneticCourse(scenario.trueCourseDeg, scenario.degreesEast)).toBe(
    scenario.magneticCourseDeg
  );
});

test('leaves a magnetic course unavailable when Local Magnetic Declination is unavailable', () => {
  expect(navigation.toMagneticCourse(100, null)).toBeNull();
});
