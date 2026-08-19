import {expect, test} from 'vitest';

import discovery from '#radial/route-planner/internal/progressiveDiscovery.js';

const DUPLICATE_MEASUREMENT_ERROR_PATTERN =
  /endpoint distances were measured more than once/;

test('widens through the scheduled endpoint ellipses and stops at the configured or VOR-family ceiling', () => {
  expect(discovery.scheduledLimitsNm(100, 2)).toEqual([100 * 1.1, 100 * 1.25, 100 * 1.5]);
  expect(discovery.scheduledLimitsNm(100, 1.2)).toEqual([100 * 1.1, 100 * 1.2]);
  expect(discovery.scheduledLimitsNm(100, 1)).toEqual([100]);
});

test('completes through an improving provisional Route Plan before returning it', () => {
  const scheduledLimitsNm = discovery.scheduledLimitsNm(100, 1.5);

  expect(discovery.nextLimitNm(scheduledLimitsNm, undefined, undefined)).toBe(100 * 1.1);
  expect(discovery.nextLimitNm(scheduledLimitsNm, 100 * 1.1, 140)).toBe(125);
  expect(discovery.nextLimitNm(scheduledLimitsNm, 125, 140)).toBe(140);
  expect(discovery.nextLimitNm(scheduledLimitsNm, 140, 130)).toBeUndefined();
  expect(discovery.nextLimitNm(scheduledLimitsNm, 150, undefined)).toBeUndefined();
});

test('measures each candidate once and retains its canonical distances until admission', () => {
  const discoverySession = discovery.createSession<{
    routePoint: {databaseId: string};
    departureDistanceNm: number;
    arrivalDistanceNm: number;
  }>(100, 1.5);
  const initialLimitNm = discoverySession.nextLimitNm(undefined);
  if (initialLimitNm === undefined) {
    throw new Error('Expected an initial discovery limit.');
  }

  const inside = candidate('inside', 50, 55);
  const pending = candidate('pending', 70, 70);

  expect(
    discoverySession.admitMeasuredCandidates([inside, pending], initialLimitNm)
  ).toEqual([inside]);
  expect(discoverySession.measuredDatabaseIds).toEqual(['inside', 'pending']);

  const secondLimitNm = discoverySession.nextLimitNm(undefined);
  if (secondLimitNm === undefined) {
    throw new Error('Expected a second discovery limit.');
  }

  expect(discoverySession.admitMeasuredCandidates([], secondLimitNm)).toEqual([]);

  const finalLimitNm = discoverySession.nextLimitNm(undefined);
  if (finalLimitNm === undefined) {
    throw new Error('Expected a final discovery limit.');
  }

  expect(discoverySession.admitMeasuredCandidates([], finalLimitNm)).toEqual([pending]);
  expect(() => discoverySession.admitMeasuredCandidates([pending], finalLimitNm)).toThrow(
    DUPLICATE_MEASUREMENT_ERROR_PATTERN
  );
});

test('admits only candidates newly inside the inclusive endpoint ellipse', () => {
  expect(discovery.isNewlyAdmitted(110, 100, 110)).toBe(true);
  expect(discovery.isNewlyAdmitted(0, undefined, 0)).toBe(true);
  expect(discovery.isNewlyAdmitted(100, 100, 110)).toBe(false);
  expect(discovery.isNewlyAdmitted(110 + Number.EPSILON * 64, 100, 110)).toBe(false);
});

function candidate(
  databaseId: string,
  departureDistanceNm: number,
  arrivalDistanceNm: number
) {
  return {routePoint: {databaseId}, departureDistanceNm, arrivalDistanceNm};
}
