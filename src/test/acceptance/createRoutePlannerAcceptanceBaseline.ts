import type RoutePlannerAcceptanceTypes from '#radial/acceptance/RoutePlannerAcceptanceTypes.js';

type AcceptanceBaseline = RoutePlannerAcceptanceTypes['AcceptanceBaseline'];

type BaselineInput = Readonly<{
  snapshotSha256: string;
  cliOutputSha256?: string;
  magneticReference?: AcceptanceBaseline['snapshot']['magneticReference'];
  machine?: AcceptanceBaseline['benchmark']['machine'];
}>;

function createRoutePlannerAcceptanceBaseline({
  snapshotSha256,
  cliOutputSha256 = '0'.repeat(64),
  magneticReference = null,
  machine = {
    platform: 'test',
    architecture: 'test',
    cpuModel: 'test',
    logicalCpuCount: 1,
    totalMemoryBytes: 1,
  },
}: BaselineInput): AcceptanceBaseline {
  return {
    version: 1,
    snapshot: {
      sha256: snapshotSha256,
      provenance: {
        source: 'Synthetic acceptance snapshot',
        retrievedAt: '2026-08-17T00:00:00.000Z',
      },
      recordCounts: {airports: 2, navaids: 1},
      magneticReference,
    },
    route: {
      departureIcao: 'AAAA',
      arrivalIcao: 'BBBB',
      maxRouteFactor: 1.5,
      searchMode: 'vor-family',
      orderedNavaids: [{databaseId: 'vor', identifier: 'MID'}],
    },
    cliOutputSha256,
    approval: {
      approvedBy: 'Acceptance test',
      approvedAt: '2026-08-17T00:00:00.000Z',
    },
    benchmark: {
      representativeMachineId: 'acceptance-test',
      machine,
      runtime: {nodeVersion: 'test', duckdbVersion: 'test'},
      samplesMs: [1, 1, 1, 1, 1],
      medianMs: 1,
      worstMs: 1,
    },
  };
}

export default createRoutePlannerAcceptanceBaseline;
