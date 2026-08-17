const ROUTE_NAVAID_COUNT = 49;
const DECOY_NAVAID_COUNT = 99;

function createSyntheticStressCorpus() {
  const routeNavaids = Array.from({length: ROUTE_NAVAID_COUNT}, (_, index) => {
    const sequence = index + 1;
    return {
      databaseId: `stress-route-${sequence}`,
      identifier: `R${String(sequence).padStart(2, '0')}`,
      name: `Stress Route VOR ${sequence}`,
      family: 'VOR',
      longitude: sequence / 5,
      latitude: sequence % 2 === 0 ? 1 : 0,
      frequencyValue: 108 + (sequence % 100) / 100,
      frequencyUnit: 'MHz',
      publishedRangeNm: 13,
    };
  });
  const decoyNavaids = Array.from({length: DECOY_NAVAID_COUNT}, (_, index) => {
    const sequence = index + 1;
    return {
      databaseId: `stress-decoy-${sequence}`,
      identifier: `D${String(sequence).padStart(2, '0')}`,
      name: `Isolated Stress VOR ${sequence}`,
      family: 'VOR',
      longitude: sequence / 10,
      latitude: sequence % 2 === 0 ? 2 : -2,
      frequencyValue: 112 + (sequence % 50) / 100,
      frequencyUnit: 'MHz',
      publishedRangeNm: 1,
    };
  });

  return {
    airports: [
      {
        databaseId: 'stress-departure',
        icao: 'SAAA',
        name: 'Stress Departure Airport',
        longitude: 0,
        latitude: 0,
      },
      {
        databaseId: 'stress-arrival',
        icao: 'SBBB',
        name: 'Stress Arrival Airport',
        longitude: 10,
        latitude: 0,
      },
    ],
    navaids: [...routeNavaids, ...decoyNavaids],
  };
}

export default createSyntheticStressCorpus;
