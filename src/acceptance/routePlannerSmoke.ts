import {createHash} from 'node:crypto';

import {DuckDBInstance} from '@duckdb/node-api';

import type RoutePlannerAcceptanceTypes from '#radial/acceptance/RoutePlannerAcceptanceTypes.js';
import verifyAcceptanceRoutePlan from '#radial/acceptance/verifyAcceptanceRoutePlan.js';
import verifyAcceptanceSnapshot from '#radial/acceptance/verifyAcceptanceSnapshot.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/main.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type SmokeInput = Readonly<{baselinePath: string; snapshotPath: string}>;
type CliRun = Readonly<{exitCode: number; stdout: string; stderr: string}>;

async function runRoutePlannerSmoke({
  baselinePath,
  snapshotPath,
}: SmokeInput): Promise<RoutePlannerAcceptanceTypes['SmokeReport']> {
  const {baseline, snapshotSha256} = await verifyAcceptanceSnapshot(
    baselinePath,
    snapshotPath
  );

  await verifySnapshotRecordCounts(snapshotPath, baseline);

  const openedPlanner = await openRoutePlanner({
    databasePath: snapshotPath,
    maxRouteFactor: baseline.route.maxRouteFactor,
  });
  if (!openedPlanner.ok) {
    throw new Error(
      `Route Planner failed to open: ${JSON.stringify(openedPlanner.failure)}.`
    );
  }

  let plan: RoutePlannerTypes['RoutePlan'];
  try {
    const result = await openedPlanner.value.planRoute({
      departureIcao: baseline.route.departureIcao.toLowerCase(),
      arrivalIcao: ` ${baseline.route.arrivalIcao.toLowerCase()} `,
    });
    if (!result.ok) {
      throw new Error(`Route planning failed: ${JSON.stringify(result.failure)}.`);
    }

    plan = result.value.plan;
  } finally {
    await openedPlanner.value[Symbol.asyncDispose]();
  }

  verifyAcceptanceRoutePlan(plan, baseline);

  const firstCliRun = await runAcceptanceCli(snapshotPath, baseline);
  const secondCliRun = await runAcceptanceCli(snapshotPath, baseline);
  if (JSON.stringify(firstCliRun) !== JSON.stringify(secondCliRun)) {
    throw new Error('Repeated CLI runs were not byte-identical.');
  }

  if (firstCliRun.exitCode !== 0) {
    throw new Error(`Acceptance CLI exited with status ${firstCliRun.exitCode}.`);
  }

  const cliOutputSha256 = hashCliRun(firstCliRun);
  if (cliOutputSha256 !== baseline.cliOutputSha256) {
    throw new Error(
      `CLI output checksum mismatch: expected ${baseline.cliOutputSha256}, received ${cliOutputSha256}.`
    );
  }

  return {snapshotSha256, cliOutputSha256, routeLegCount: plan.routeLegs.length};
}

async function verifySnapshotRecordCounts(
  snapshotPath: string,
  baseline: RoutePlannerAcceptanceTypes['AcceptanceBaseline']
): Promise<void> {
  const instance = await DuckDBInstance.create(snapshotPath);
  const connection = await instance.connect();
  try {
    await connection.run('LOAD spatial');
    const result = await connection.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM planner_airports) AS airport_count,
        (SELECT count(*) FROM planner_navaids
          WHERE family = 'NDB') AS fallback_navaid_count,
        (SELECT count(*) FROM planner_navaids
          WHERE family != 'NDB') AS vor_family_navaid_count
    `);
    const row = result.getRowObjectsJS()[0];
    const actualCounts = {
      airports: Number(row?.['airport_count']),
      vorFamilyNavaids: Number(row?.['vor_family_navaid_count']),
      fallbackNavaids: Number(row?.['fallback_navaid_count']),
    };
    if (
      actualCounts.airports !== baseline.snapshot.recordCounts.airports ||
      actualCounts.vorFamilyNavaids !== baseline.snapshot.recordCounts.vorFamilyNavaids ||
      actualCounts.fallbackNavaids !== baseline.snapshot.recordCounts.fallbackNavaids
    ) {
      throw new Error(
        `Snapshot record counts do not match the baseline: expected ${JSON.stringify(baseline.snapshot.recordCounts)}, received ${JSON.stringify(actualCounts)}.`
      );
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function runAcceptanceCli(
  snapshotPath: string,
  baseline: RoutePlannerAcceptanceTypes['AcceptanceBaseline']
): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli({
    args: [baseline.route.departureIcao, baseline.route.arrivalIcao],
    env: {
      RADIAL_DATABASE_PATH: snapshotPath,
      RADIAL_MAX_ROUTE_FACTOR: String(baseline.route.maxRouteFactor),
    },
    io: {
      writeStdout(text) {
        stdout += text;
      },
      writeStderr(text) {
        stderr += text;
      },
    },
    openApplication: openAcceptanceApplication,
  });
  return {exitCode, stdout, stderr};
}

async function openAcceptanceApplication(
  config: RadialApplicationTypes['ApplicationConfig']
): Promise<RadialApplicationTypes['ApplicationOpenResult']> {
  return {
    ok: true,
    value: {
      databasePath: config.databasePath,
      planning: {
        open: () => openRoutePlanner(config),
      },
      dataManagement: {
        async status() {
          throw new Error('Data status is not used by acceptance smoke.');
        },
        async reloadNavaids() {
          throw new Error('Navaid reload is not used by acceptance smoke.');
        },
        async reloadAirport() {
          throw new Error('Airport reload is not used by acceptance smoke.');
        },
      },
      async [Symbol.asyncDispose]() {},
    },
  };
}

function hashCliRun(cliRun: CliRun): string {
  return createHash('sha256').update(JSON.stringify(cliRun)).digest('hex');
}

export default runRoutePlannerSmoke;
