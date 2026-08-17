import {expect, test} from 'vitest';

import coverage from '#radial/route-planner/internal/coverage.js';

test.each([
  {distanceNm: 39.999, publishedRangeNm: 40, expected: true},
  {distanceNm: 40, publishedRangeNm: 40, expected: true},
  {distanceNm: 40.000_000_000_000_01, publishedRangeNm: 40, expected: false},
])(
  'makes an airport–VOR-family Navaid Route Leg navigable within inclusive published coverage',
  ({distanceNm, publishedRangeNm, expected}) => {
    expect(coverage.isAirportToNavaidNavigable(distanceNm, publishedRangeNm)).toBe(
      expected
    );
  }
);

test.each([
  {distanceNm: 69.999, firstRangeNm: 30, secondRangeNm: 40, expected: true},
  {distanceNm: 70, firstRangeNm: 30, secondRangeNm: 40, expected: true},
  {
    distanceNm: 70.000_000_000_000_01,
    firstRangeNm: 30,
    secondRangeNm: 40,
    expected: false,
  },
])(
  'makes a Navaid–Navaid Route Leg navigable within their inclusive combined published coverage',
  ({distanceNm, firstRangeNm, secondRangeNm, expected}) => {
    expect(
      coverage.isNavaidToNavaidNavigable(distanceNm, firstRangeNm, secondRangeNm)
    ).toBe(expected);
  }
);
