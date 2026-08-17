import {expect, test} from 'vitest';

import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025, noaaDecimalYearFromUtcDate} = Wmm2025;

test.each([
  {
    referenceDate: '2025-01-01',
    latitude: 80,
    longitude: 0,
    expectedDeclination: 1.28,
  },
  {
    referenceDate: '2025-01-01',
    latitude: 0,
    longitude: 120,
    expectedDeclination: -0.16,
  },
  {
    referenceDate: '2025-01-01',
    latitude: -80,
    longitude: -120,
    expectedDeclination: 68.78,
  },
  {
    referenceDate: '2027-07-02',
    latitude: 80,
    longitude: 0,
    expectedDeclination: 2.59,
  },
])(
  'matches the official NOAA WMM2025 zero-kilometre vector at $latitude, $longitude',
  ({referenceDate, latitude, longitude, expectedDeclination}) => {
    expect(
      localMagneticDeclinationFromWmm2025({
        referenceDate,
        latitude,
        longitude,
      })
    ).toBeCloseTo(expectedDeclination, 2);
  }
);

test('converts UTC dates with NOAA decimal-year rules and enforces model validity', () => {
  expect(noaaDecimalYearFromUtcDate('2025-01-01')).toBe(2025);
  expect(noaaDecimalYearFromUtcDate('2028-07-02')).toBe(2028.5);
  expect(noaaDecimalYearFromUtcDate('2029-12-31')).toBeCloseTo(2029 + 364 / 365, 12);

  expect(() => noaaDecimalYearFromUtcDate('2024-12-31')).toThrow(
    'WMM2025 reference date must be in [2025.0, 2030.0).'
  );
  expect(() => noaaDecimalYearFromUtcDate('2030-01-01')).toThrow(
    'WMM2025 reference date must be in [2025.0, 2030.0).'
  );
});

test('makes Local Magnetic Declination unavailable only in the Blackout Zone', () => {
  expect(
    localMagneticDeclinationFromWmm2025({
      referenceDate: '2025-01-01',
      latitude: 85.762,
      longitude: 139.298,
    })
  ).toBeNull();
  expect(() =>
    localMagneticDeclinationFromWmm2025({
      referenceDate: '2025-01-01',
      latitude: Number.NaN,
      longitude: 0,
    })
  ).toThrow('WMM2025 coordinates must be finite WGS84 degrees.');
  expect(() =>
    localMagneticDeclinationFromWmm2025({
      referenceDate: '2025-01-01',
      latitude: 0,
      longitude: 180,
    })
  ).toThrow('WMM2025 longitude must be in [-180, 180).');
});
