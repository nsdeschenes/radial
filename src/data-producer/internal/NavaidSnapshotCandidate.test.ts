import {expect, test} from 'vitest';

import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';

const PROVENANCE = {
  sourceIdentity: 'fixture:openaip-navaids:v1',
  derivationPolicyIdentity: 'radial:navaid-derivation:v1',
  matchingPolicyIdentity: 'fixture:no-facility-variation:v1',
} as const;

test('canonically preserves and deterministically partitions every raw Navaid', () => {
  const records = [
    {
      _id: 'vor-1',
      type: 4,
      identifier: 'YYZ',
      name: 'Toronto',
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
    rawNavaids: records,
    provenance: PROVENANCE,
    retrievedAt: '2026-08-17T12:00:00.000Z',
    retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
  });
  const reordered = buildNavaidSnapshotCandidate({
    rawNavaids: records.toReversed(),
    provenance: PROVENANCE,
    retrievedAt: '2026-08-17T13:00:00.000Z',
    retrievalCompletedAt: '2026-08-17T13:00:01.000Z',
  });
  const nextDate = buildNavaidSnapshotCandidate({
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
  expect(candidate.exclusions.map(row => row.reason)).toEqual([
    'invalid-coordinates',
    'invalid-frequency',
    'invalid-published-range',
    'missing-identifier',
    'unsupported-navaid-type',
  ]);
  expect(candidate.rawNavaids.find(row => row.sourceRecordId === 'vor-1')).toMatchObject({
    canonicalRecord:
      '{"_id":"vor-1","additive":{"a":"preserved","z":true},"frequency":{"unit":2,"value":"112.150"},"geometry":{"coordinates":[-79.6139,43.6589],"type":"Point"},"identifier":"YYZ","name":"Toronto","range":{"unit":2,"value":130},"type":4}',
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

test('preserves an eligible Navaid with unavailable Blackout Zone declination', () => {
  const candidate = buildNavaidSnapshotCandidate({
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
  expect(candidate.snapshotChecksum).toBe(
    'sha256:8f0d49c1075ab582e4141544a2c80e9a2df9f5209a752745ba376d33df4b177e'
  );
});

test('rejects duplicate source IDs and non-canonicalizable raw values', () => {
  const duplicate = {_id: 'duplicate', unknown: true};
  expect(() =>
    buildNavaidSnapshotCandidate({
      rawNavaids: [duplicate, duplicate],
      provenance: PROVENANCE,
      retrievedAt: '2026-08-17T12:00:00.000Z',
      retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
    })
  ).toThrow('duplicate non-null OpenAIP source identity duplicate');

  expect(() =>
    buildNavaidSnapshotCandidate({
      rawNavaids: [{_id: 'invalid', value: Number.NaN}],
      provenance: PROVENANCE,
      retrievedAt: '2026-08-17T12:00:00.000Z',
      retrievalCompletedAt: '2026-08-17T12:00:01.000Z',
    })
  ).toThrow('raw Navaid 1 is not RFC 8785 canonicalizable');
});
