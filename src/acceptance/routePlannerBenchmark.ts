import {arch, cpus, platform, totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';

import {DuckDBInstance} from '@duckdb/node-api';

import type RoutePlannerAcceptanceTypes from '#radial/acceptance/RoutePlannerAcceptanceTypes.js';
import verifyAcceptanceRoutePlan from '#radial/acceptance/verifyAcceptanceRoutePlan.js';
import verifyAcceptanceSnapshot from '#radial/acceptance/verifyAcceptanceSnapshot.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type BenchmarkInput = Readonly<{
  baselinePath: string;
  snapshotPath: string;
  machineId: string;
}>;

const MEDIAN_GATE_MS = 2000;

async function runRoutePlannerBenchmark({
  baselinePath,
  snapshotPath,
  machineId,
}: BenchmarkInput): Promise<RoutePlannerAcceptanceTypes['BenchmarkReport']> {
  const {baseline, snapshotSha256} = await verifyAcceptanceSnapshot(
    baselinePath,
    snapshotPath
  );
  const openedPlanner = await openRoutePlanner({
    databasePath: snapshotPath,
    maxRouteFactor: baseline.route.maxRouteFactor,
  });
  if (!openedPlanner.ok) {
    throw new Error(
      `Route Planner failed to open: ${JSON.stringify(openedPlanner.failure)}.`
    );
  }

  let warmupMs: number;
  let samplesMs: [number, number, number, number, number];
  try {
    warmupMs = await measurePlanningCall(openedPlanner.value, baseline);
    samplesMs = [
      await measurePlanningCall(openedPlanner.value, baseline),
      await measurePlanningCall(openedPlanner.value, baseline),
      await measurePlanningCall(openedPlanner.value, baseline),
      await measurePlanningCall(openedPlanner.value, baseline),
      await measurePlanningCall(openedPlanner.value, baseline),
    ];
  } finally {
    await openedPlanner.value[Symbol.asyncDispose]();
  }

  const sortedSamples = samplesMs.toSorted((left, right) => left - right);
  const medianMs = sortedSamples[2];
  if (medianMs === undefined) {
    throw new Error('Benchmark median invariant failed.');
  }

  const worstMs = Math.max(...samplesMs);
  const machine = currentMachineDetails();
  const representativeMachine =
    machineId === baseline.benchmark.representativeMachineId &&
    JSON.stringify(machine) === JSON.stringify(baseline.benchmark.machine);

  return {
    snapshotSha256,
    machineId,
    representativeMachine,
    machine,
    runtime: {
      nodeVersion: process.version,
      duckdbVersion: await readDuckDbVersion(snapshotPath),
    },
    warmupMs,
    samplesMs,
    medianMs,
    worstMs,
    medianGateMs: MEDIAN_GATE_MS,
    medianGatePassed: representativeMachine ? medianMs < MEDIAN_GATE_MS : null,
  };
}

function currentMachineDetails() {
  const cpuList = cpus();
  return {
    platform: platform(),
    architecture: arch(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
  };
}

async function measurePlanningCall(
  planner: RoutePlannerTypes['RoutePlanner'],
  baseline: RoutePlannerAcceptanceTypes['AcceptanceBaseline']
): Promise<number> {
  const startedAt = performance.now();
  const result = await planner.planRoute({
    departureIcao: baseline.route.departureIcao,
    arrivalIcao: baseline.route.arrivalIcao,
  });
  const durationMs = performance.now() - startedAt;
  if (!result.ok) {
    throw new Error(
      `Benchmark route planning failed: ${JSON.stringify(result.failure)}.`
    );
  }

  verifyAcceptanceRoutePlan(result.value.plan, baseline);
  return durationMs;
}

async function readDuckDbVersion(snapshotPath: string): Promise<string> {
  const instance = await DuckDBInstance.create(snapshotPath);
  const connection = await instance.connect();
  try {
    const result = await connection.runAndReadAll('SELECT version() AS version');
    const version = result.getRowObjectsJS()[0]?.['version'];
    if (typeof version !== 'string') {
      throw new Error('DuckDB version query returned an invalid value.');
    }

    return version;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export default runRoutePlannerBenchmark;
