import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type SnapshotMagneticReference = Readonly<{
  model: string;
  version: string;
  epochYear: number;
  referenceDate: string;
  source: string;
}>;

type AcceptanceBaseline = Readonly<{
  version: 1;
  snapshot: Readonly<{
    sha256: string;
    schemaVersion: number;
    provenance: Readonly<{source: string; retrievedAt: string}>;
    recordCounts: Readonly<{
      airports: number;
      vorFamilyNavaids: number;
      fallbackNavaids: number;
    }>;
    magneticReference: SnapshotMagneticReference | null;
  }>;
  route: Readonly<{
    departureIcao: string;
    arrivalIcao: string;
    maxRouteFactor: number;
    searchMode: RoutePlannerTypes['RoutePlan']['searchMode'];
    orderedNavaids: readonly Readonly<{databaseId: string; identifier: string}>[];
  }>;
  cliOutputSha256: string;
  approval: Readonly<{approvedBy: string; approvedAt: string}>;
  benchmark: Readonly<{
    radialRevision: string;
    representativeMachineId: string;
    machine: Readonly<{
      platform: string;
      architecture: string;
      cpuModel: string;
      logicalCpuCount: number;
      totalMemoryBytes: number;
    }>;
    runtime: Readonly<{nodeVersion: string; duckdbVersion: string}>;
    warmupMs: number;
    samplesMs: readonly [number, number, number, number, number];
    medianMs: number;
    worstMs: number;
  }>;
}>;

type SmokeReport = Readonly<{
  snapshotSha256: string;
  cliOutputSha256: string;
  routeLegCount: number;
}>;

type BenchmarkReport = Readonly<{
  snapshotSha256: string;
  machineId: string;
  representativeMachine: boolean;
  machine: Readonly<{
    platform: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  }>;
  runtime: Readonly<{nodeVersion: string; duckdbVersion: string}>;
  warmupMs: number;
  samplesMs: readonly [number, number, number, number, number];
  medianMs: number;
  worstMs: number;
  medianGateMs: 2000;
  medianGatePassed: boolean | null;
}>;

export default interface RoutePlannerAcceptanceTypes {
  AcceptanceBaseline: AcceptanceBaseline;
  BenchmarkReport: BenchmarkReport;
  SmokeReport: SmokeReport;
}
