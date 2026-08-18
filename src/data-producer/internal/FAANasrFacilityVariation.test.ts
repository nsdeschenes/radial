import {createHash} from 'node:crypto';

import {expect, test} from 'vitest';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import faaNasrFacilityVariation from '#radial/data-producer/internal/FAANasrFacilityVariation.js';

const encoder = new TextEncoder();

test('selects and verifies the latest published official cycle effective by retrieval start', () => {
  const previous = cycle('2606', '2026-06-11', '2026-05-28T12:00:00.000Z');
  const applicable = cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z');
  const preview = cycle('2608', '2026-08-06', '2026-07-23T12:00:00.000Z');

  const selected = faaNasrFacilityVariation.selectApplicableCycle(
    [preview, previous, applicable],
    '2026-07-10T00:00:00.000Z'
  );

  expect(selected).toMatchObject({
    archiveChecksum: applicable.archiveChecksum,
    archiveIdentity: '28-day-nasr-2607.zip',
    cycleId: '2607',
    effectiveDate: '2026-07-09',
  });
});

test('rejects unavailable, unofficial, inconsistent, or corrupted selected cycles', () => {
  expect(() =>
    faaNasrFacilityVariation.selectApplicableCycle(
      [cycle('2608', '2026-08-06', '2026-07-23T12:00:00.000Z')],
      '2026-07-10T00:00:00.000Z'
    )
  ).toThrow('no published FAA 28-Day NASR cycle is effective by retrieval start');

  expect(() =>
    faaNasrFacilityVariation.selectApplicableCycle(
      [
        {
          ...cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z'),
          sourceUrl: 'https://example.com/28-day-nasr-2607.zip',
        },
      ],
      '2026-07-10T00:00:00.000Z'
    )
  ).toThrow('FAA NASR source URL must use the official HTTPS origin');

  expect(() =>
    faaNasrFacilityVariation.selectApplicableCycle(
      [
        {
          ...cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z'),
          archiveChecksum:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
      '2026-07-10T00:00:00.000Z'
    )
  ).toThrow('FAA NASR archive checksum does not match its content');

  expect(() =>
    faaNasrFacilityVariation.selectApplicableCycle(
      [
        {
          ...cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z'),
          contentChecksum:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      '2026-07-10T00:00:00.000Z'
    )
  ).toThrow('FAA NASR canonical content checksum does not match its records');

  const duplicated = cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z');
  expect(() =>
    faaNasrFacilityVariation.selectApplicableCycle(
      [duplicated, {...duplicated, cycleId: '9999'}],
      '2026-07-10T00:00:00.000Z'
    )
  ).toThrow('FAA NASR cycle metadata contains a duplicate effective date');

  expect(() => verifiedCycleWithRecords([nasrRecord({FREQ: 'not-a-frequency'})])).toThrow(
    'FAA NASR NAV_BASE record 1 has incompatible content'
  );
});

test('matches one VOR-family record using normalized identity, exact frequency, and WGS84 distance', () => {
  const selected = faaNasrFacilityVariation.selectApplicableCycle(
    [cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z')],
    '2026-07-10T00:00:00.000Z'
  );

  const result = faaNasrFacilityVariation.match(
    {
      country: 'US',
      family: 'VOR-DME',
      frequencyUnit: 'MHz',
      frequencyValue: 112.15,
      identifier: ' yyz ',
      latitude: 43.6589,
      longitude: -79.6139,
      sourceRecordId: 'openaip-yyz',
    },
    selected,
    'radial:faa-nasr-match:v1'
  );

  expect(result.facilityVariation).toEqual({
    degreesEast: -11.7,
    epochYear: 2020,
    source: 'FAA 28-Day NASR 2607',
  });
  expect(result.audit).toMatchObject({
    facilityVariationDegEast: -11.7,
    facilityVariationEpochYear: 2020,
    faaFacilityIdentifier: 'YYZ',
    faaFrequencyHz: 112_150_000,
    matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
    nasrArchiveChecksum: selected.archiveChecksum,
    nasrCycleId: '2607',
    nasrEffectiveDate: '2026-07-09',
    openAipFrequencyHz: 112_150_000,
    outcome: 'matched',
  });

  const eastPositive = faaNasrFacilityVariation.match(
    {
      country: 'US',
      family: 'VOR',
      frequencyUnit: 'MHz',
      frequencyValue: 112.15,
      identifier: 'YYZ',
      latitude: 43.6589,
      longitude: -79.6139,
      sourceRecordId: 'east-positive',
    },
    verifiedCycleWithRecords([nasrRecord({MAG_VARN_HEMIS: 'E'})]),
    'radial:faa-nasr-match:v1'
  );
  expect(eastPositive.facilityVariation?.degreesEast).toBe(11.7);

  expect(
    faaNasrFacilityVariation.match(
      {
        country: 'US',
        family: 'VOR',
        frequencyUnit: 'MHz',
        frequencyValue: 112.151,
        identifier: 'YYZ',
        latitude: 43.6589,
        longitude: -79.6139,
        sourceRecordId: 'different-frequency',
      },
      selected,
      'radial:faa-nasr-match:v1'
    )
  ).toMatchObject({audit: {outcome: 'no-unique-match'}, facilityVariation: null});
});

test('includes the one-nautical-mile WGS84 boundary and rejects a farther candidate', () => {
  const boundaryLatitude = 0.01674892271018241;
  const atBoundary = verifiedCycleWithRecords([
    nasrRecord({LAT_DECIMAL: String(boundaryLatitude), LONG_DECIMAL: '0'}),
  ]);
  const outside = verifiedCycleWithRecords([
    nasrRecord({LAT_DECIMAL: String(boundaryLatitude + 0.000_001), LONG_DECIMAL: '0'}),
  ]);
  const openAip = {
    country: 'US',
    family: 'VOR' as const,
    frequencyUnit: 'MHz' as const,
    frequencyValue: 112.15,
    identifier: 'YYZ',
    latitude: 0,
    longitude: 0,
    sourceRecordId: 'boundary',
  };

  expect(
    faaNasrFacilityVariation.match(openAip, atBoundary, 'match:v1').audit.outcome
  ).toBe('matched');
  expect(faaNasrFacilityVariation.match(openAip, outside, 'match:v1')).toMatchObject({
    audit: {outcome: 'no-unique-match'},
    facilityVariation: null,
  });
});

test('classifies missing Facility Variation without substituting another magnetic field', () => {
  const usable = nasrRecord();
  const scenarios = [
    {
      country: 'CA',
      expected: 'outside-source-coverage',
      records: [usable],
    },
    {
      country: 'US',
      expected: 'no-unique-match',
      records: [usable, {...usable, LAT_DECIMAL: '43.659'}],
    },
    {
      country: 'US',
      expected: 'unusable-source-value',
      records: [{...usable, MAG_VARN: ''}],
    },
  ] as const;

  for (const scenario of scenarios) {
    const result = faaNasrFacilityVariation.match(
      {
        country: scenario.country,
        family: 'VORTAC',
        frequencyUnit: 'MHz',
        frequencyValue: 112.15,
        identifier: 'YYZ',
        latitude: 43.6589,
        longitude: -79.6139,
        sourceRecordId: scenario.expected,
      },
      verifiedCycleWithRecords(scenario.records),
      'match:v1'
    );

    expect(result.facilityVariation).toBeNull();
    expect(result.audit.outcome).toBe(scenario.expected);
  }
});

function cycle(cycleId: string, effectiveDate: string, publishedAt: string) {
  const archiveBytes = encoder.encode(`official FAA fixture ${cycleId}`);
  const records = [nasrRecord({EFF_DATE: effectiveDate})];
  return {
    archiveBytes,
    archiveChecksum: bytesChecksum(archiveBytes),
    archiveIdentity: `28-day-nasr-${cycleId}.zip`,
    contentChecksum: textChecksum(canonicalizeJson(canonicalRecordSet(records))),
    cycleId,
    effectiveDate,
    publishedAt,
    records,
    retrievedAt: '2026-07-10T00:00:01.000Z',
    sourceUrl: `https://nfdc.faa.gov/webContent/28DaySub/28-day-nasr-${cycleId}.zip`,
  } as const;
}

function verifiedCycleWithRecords(records: readonly Readonly<Record<string, unknown>>[]) {
  const artifact = cycle('2607', '2026-07-09', '2026-06-25T12:00:00.000Z');
  return faaNasrFacilityVariation.selectApplicableCycle(
    [
      {
        ...artifact,
        contentChecksum: textChecksum(canonicalizeJson(canonicalRecordSet(records))),
        records,
      },
    ],
    '2026-07-10T00:00:00.000Z'
  );
}

function canonicalRecordSet(records: readonly Readonly<Record<string, unknown>>[]) {
  return records
    .map(record => canonicalizeJson(record))
    .toSorted()
    .map(record => JSON.parse(record) as Readonly<Record<string, unknown>>);
}

function nasrRecord(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    EFF_DATE: '2026-07-09',
    FREQ: '112.150',
    LAT_DECIMAL: '43.6589',
    LONG_DECIMAL: '-79.6139',
    MAG_VARN: '11.7',
    MAG_VARN_HEMIS: 'W',
    MAG_VARN_YEAR: '2020',
    NAV_ID: 'YYZ',
    NAV_TYPE: 'VOR/DME',
    ...overrides,
  };
}

function bytesChecksum(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function textChecksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
