import {expect, test} from 'vitest';

import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

const PROVENANCE = {
  sourceIdentity: 'fixture:openaip-navaids:v1',
  derivationPolicyIdentity: 'radial:navaid-derivation:v1',
  matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
} as const;

function nasrCyclesAt(retrievedAt: string, effectiveDate = '2026-07-09') {
  const publishedAt = new Date(
    Date.parse(`${effectiveDate}T12:00:00.000Z`) - 14 * 24 * 60 * 60 * 1_000
  ).toISOString();
  return [
    createSyntheticFAANasrCycle(
      [
        {
          EFF_DATE: effectiveDate,
          FREQ: '112.150',
          LAT_DECIMAL: '43.6589',
          LONG_DECIMAL: '-79.6139',
          MAG_VARN: '11.7',
          MAG_VARN_HEMIS: 'W',
          MAG_VARN_YEAR: '2020',
          NAV_ID: 'YYZ',
          NAV_TYPE: 'VOR/DME',
        },
      ],
      {effectiveDate, publishedAt, retrievedAt}
    ),
  ] as const;
}

const NASR_ARCHIVE_CHECKSUM = createSyntheticFAANasrCycle([
  {
    EFF_DATE: '2026-07-09',
    FREQ: '112.150',
    LAT_DECIMAL: '43.6589',
    LONG_DECIMAL: '-79.6139',
    MAG_VARN: '11.7',
    MAG_VARN_HEMIS: 'W',
    MAG_VARN_YEAR: '2020',
    NAV_ID: 'YYZ',
    NAV_TYPE: 'VOR/DME',
  },
]).archiveChecksum;

test('canonically preserves and deterministically partitions every raw Navaid', () => {
  const records = [
    {
      _id: 'vor-1',
      type: 4,
      identifier: 'YYZ',
      name: 'Toronto',
      country: 'US',
      alignedTrueNorth: true,
      magneticDeclination: 6.5,
      geometry: {coordinates: [-79.6139, 43.6589], type: 'Point'},
      frequency: {unit: 2, value: '112.150'},
      range: {unit: 2, value: 130},
      additive: {z: true, a: 'preserved'},
    },
    {
      type: 2,
      identifier: 'ND',
      name: 'Fallback',
      geometry: {type: 'Point', coordinates: [-80, 44]},
      frequency: {value: '365.000', unit: 1},
      range: {value: 45, unit: 2},
    },
    {_id: 'unsupported', type: 0},
    {_id: 'bad-coordinate', type: 3, geometry: {type: 'Point', coordinates: [181, 0]}},
    {
      _id: 'missing-identifier',
      type: 3,
      geometry: {type: 'Point', coordinates: [0, 0]},
    },
    {
      _id: 'bad-frequency',
      type: 3,
      identifier: 'BAD',
      geometry: {type: 'Point', coordinates: [0, 0]},
      frequency: {value: '0.000', unit: 2},
    },
    {
      _id: 'bad-range',
      type: 3,
      identifier: 'RNG',
      geometry: {type: 'Point', coordinates: [0, 0]},
      frequency: {value: '113.000', unit: 2},
      range: {value: 0, unit: 2},
    },
  ];

  const candidate = buildNavaidSnapshotCandidate({
    faaNasrCycles: nasrCyclesAt('2026-08-17T12:00:00.500Z'),
    rawNavaids: records,
    provenance: PROVENANCE,
    retrievedAt: '2026-08-17T12:00:00.000Z',
    retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
  });
  const reordered = buildNavaidSnapshotCandidate({
    faaNasrCycles: nasrCyclesAt('2026-08-17T13:00:00.500Z'),
    rawNavaids: records.toReversed(),
    provenance: PROVENANCE,
    retrievedAt: '2026-08-17T13:00:00.000Z',
    retrievalCompletedAt: '2026-08-17T13:00:01.000Z',
  });
  const nextDate = buildNavaidSnapshotCandidate({
    faaNasrCycles: nasrCyclesAt('2026-08-18T12:00:00.500Z'),
    rawNavaids: records,
    provenance: PROVENANCE,
    retrievedAt: '2026-08-18T12:00:00.000Z',
    retrievalCompletedAt: '2026-08-18T12:00:01.000Z',
  });

  expect(candidate.snapshotChecksum).toBe(reordered.snapshotChecksum);
  expect(candidate.snapshotChecksum).not.toBe(nextDate.snapshotChecksum);
  expect(candidate.componentChecksums).toEqual(reordered.componentChecksums);
  expect(candidate.rawNavaids).toHaveLength(7);
  expect(candidate.plannerNavaids.map(row => row.family)).toEqual(['NDB', 'VOR-DME']);
  expect(
    candidate.plannerNavaids.find(row => row.sourceRecordId === 'vor-1')
  ).toMatchObject({
    facilityVariationDegEast: -11.7,
    facilityVariationEffectiveDate: null,
    facilityVariationSource: 'FAA 28-Day NASR 2607',
  });
  expect(candidate.facilityVariationAudits).toHaveLength(1);
  expect(candidate.facilityVariationAudits[0]).toMatchObject({
    facilityVariationEpochYear: 2020,
    nasrEffectiveDate: '2026-07-09',
    outcome: 'matched',
    sourceRecordId: 'vor-1',
  });
  expect(candidate.provenance.faaNasr).toMatchObject({
    archiveChecksum: NASR_ARCHIVE_CHECKSUM,
    cycleId: '2607',
    effectiveDate: '2026-07-09',
  });
  expect(candidate.exclusions.map(row => row.reason)).toEqual([
    'invalid-coordinates',
    'invalid-frequency',
    'invalid-published-range',
    'missing-identifier',
    'unsupported-navaid-type',
  ]);
  expect(candidate.rawNavaids.find(row => row.sourceRecordId === 'vor-1')).toMatchObject({
    canonicalRecord:
      '{"_id":"vor-1","additive":{"a":"preserved","z":true},"alignedTrueNorth":true,"country":"US","frequency":{"unit":2,"value":"112.150"},"geometry":{"coordinates":[-79.6139,43.6589],"type":"Point"},"identifier":"YYZ","magneticDeclination":6.5,"name":"Toronto","range":{"unit":2,"value":130},"type":4}',
  });
  expect(new Set(candidate.rawNavaids.map(row => row.sourceRecordId)).size).toBe(7);
  expect(candidate.rawNavaids.map(row => row.sourceRecordId)).toEqual(
    reordered.rawNavaids.map(row => row.sourceRecordId)
  );
  expect(candidate.provenance.magneticModel).toEqual({
    model: 'WMM',
    version: 'WMM2025',
    epochYear: 2025,
    referenceDate: '2026-08-17',
    source: 'https://doi.org/10.25921/aqfd-sd83',
    coefficientChecksum:
      'sha256:dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f',
  });
  expect(
    candidate.plannerNavaids.every(
      row =>
        row.magneticDeclinationDegEast !== null &&
        !Number.isInteger(row.magneticDeclinationDegEast) &&
        row.magneticDeclinationDegEast >= -180 &&
        row.magneticDeclinationDegEast < 180
    )
  ).toBe(true);
});

test('uses the default published range when OpenAIP omits range', () => {
  const candidate = buildNavaidSnapshotCandidate({
    faaNasrCycles: nasrCyclesAt('2026-08-17T12:00:00.500Z'),
    rawNavaids: [
      {
        _id: 'nil-range',
        type: 4,
        identifier: 'YHZ',
        name: 'Halifax',
        country: 'CA',
        geometry: {type: 'Point', coordinates: [-63.401944, 44.923056]},
        frequency: {value: '115.100', unit: 2},
      },
    ],
    provenance: PROVENANCE,
    retrievedAt: '2026-08-17T12:00:00.000Z',
    retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
  });

  expect(candidate.plannerNavaids).toMatchObject([
    {
      sourceRecordId: 'nil-range',
      identifier: 'YHZ',
      publishedRangeNm: 90,
    },
  ]);
  expect(candidate.exclusions).toEqual([]);
});

test('preserves an eligible Navaid with unavailable Blackout Zone declination', () => {
  const candidate = buildNavaidSnapshotCandidate({
    faaNasrCycles: nasrCyclesAt('2025-01-01T00:00:00.500Z', '2024-12-05'),
    rawNavaids: [
      {
        _id: 'blackout-vor',
        type: 3,
        identifier: 'BOZ',
        geometry: {type: 'Point', coordinates: [139.298, 85.762]},
        frequency: {value: '113.000', unit: 2},
        range: {value: 100, unit: 2},
      },
    ],
    provenance: PROVENANCE,
    retrievedAt: '2025-01-01T00:00:00.000Z',
    retrievalCompletedAt: '2025-01-01T00:00:01.000Z',
  });

  expect(candidate.plannerNavaids).toHaveLength(1);
  expect(candidate.plannerNavaids[0]?.magneticDeclinationDegEast).toBeNull();
  expect(candidate.exclusions).toEqual([]);
});

test('rejects duplicate source IDs and non-canonicalizable raw values', () => {
  const duplicate = {_id: 'duplicate', unknown: true};
  expect(() =>
    buildNavaidSnapshotCandidate({
      faaNasrCycles: nasrCyclesAt('2026-08-17T12:00:00.500Z'),
      rawNavaids: [duplicate, duplicate],
      provenance: PROVENANCE,
      retrievedAt: '2026-08-17T12:00:00.000Z',
      retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
    })
  ).toThrow('duplicate non-null OpenAIP source identity duplicate');

  expect(() =>
    buildNavaidSnapshotCandidate({
      faaNasrCycles: nasrCyclesAt('2026-08-17T12:00:00.500Z'),
      rawNavaids: [{_id: 'invalid', value: Number.NaN}],
      provenance: PROVENANCE,
      retrievedAt: '2026-08-17T12:00:00.000Z',
      retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
    })
  ).toThrow('raw Navaid 1 is not RFC 8785 canonicalizable');
});
