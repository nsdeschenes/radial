import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import validateNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidateValidation.js';
import createSyntheticFAANasrCycle from '#radial/test/createSyntheticFAANasrCycle.js';

function createSyntheticNavaidSnapshotCandidate(retrievedAt: string) {
  const retrievalCompletedAt = new Date(Date.parse(retrievedAt) + 1_000).toISOString();
  const candidate = buildNavaidSnapshotCandidate({
    faaNasrCycles: [
      createSyntheticFAANasrCycle(
        [
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
        ],
        {retrievedAt: new Date(Date.parse(retrievedAt) + 500).toISOString()}
      ),
    ],
    rawNavaids: [
      {
        _id: 'vor-1',
        country: 'US',
        type: 4,
        identifier: 'YYZ',
        name: 'Toronto',
        geometry: {type: 'Point', coordinates: [-79.6139, 43.6589]},
        frequency: {value: '112.150', unit: 2},
        range: {value: 130, unit: 2},
      },
      {_id: 'unsupported', type: 0},
    ],
    provenance: {
      sourceIdentity: 'fixture:openaip-navaids:v1',
      derivationPolicyIdentity: 'radial:navaid-derivation:v1',
      matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
    },
    retrievedAt,
    retrievalCompletedAt,
  });
  return validateNavaidSnapshotCandidate(candidate);
}

export default createSyntheticNavaidSnapshotCandidate;
