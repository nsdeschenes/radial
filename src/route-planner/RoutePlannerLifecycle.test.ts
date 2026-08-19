import {DuckDBInstance} from '@duckdb/node-api';
import {expect, test} from 'vitest';

import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

const oneDegreeNm = 60.040457151489605;

test('returns independent structured results from concurrent planning calls', async () => {
  await using database = await syntheticPlannerDatabase.create({
    airports: [
      airport('airport-a', 'AAAA', 0),
      airport('airport-b', 'BBBB', 2),
      airport('airport-c', 'CCCC', 10),
      airport('airport-d', 'DDDD', 12),
    ],
    navaids: [navaid('navaid-ab', 'AB', 1), navaid('navaid-cd', 'CD', 11)],
  });
  const planner = await openPlanner(database.databasePath);

  const [first, second] = await Promise.all([
    planner.planRoute({departureIcao: 'AAAA', arrivalIcao: 'BBBB'}),
    planner.planRoute({departureIcao: 'CCCC', arrivalIcao: 'DDDD'}),
  ]);

  expect(routePointIds(first)).toEqual(['airport-a', 'navaid-ab', 'airport-b']);
  expect(routePointIds(second)).toEqual(['airport-c', 'navaid-cd', 'airport-d']);
  await planner[Symbol.asyncDispose]();
});

test('each planning call observes one committed database snapshot', async () => {
  await using database = await syntheticPlannerDatabase.create(routeDefinition());
  const instance = await DuckDBInstance.create(database.databasePath);
  const opened = await openRoutePlanner(
    {databasePath: database.databasePath},
    async () => instance
  );
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  const writer = await instance.connect();
  await writer.run('BEGIN TRANSACTION');
  await writer.run(`
    UPDATE synthetic_airports SET longitude = longitude + 10;
    UPDATE synthetic_navaids SET longitude = longitude + 10;
  `);

  const beforeCommit = await opened.value.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });
  await writer.run('COMMIT');
  const afterCommit = await opened.value.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });

  expect(routePointLongitudes(beforeCommit)).toEqual([0, 1, 2]);
  expect(routePointLongitudes(afterCommit)).toEqual([10, 11, 12]);
  writer.closeSync();
  await opened.value[Symbol.asyncDispose]();
  instance.closeSync();
});

test('returns database query failures as structured planning failures', async () => {
  await using database = await syntheticPlannerDatabase.create(routeDefinition());
  const instance = await DuckDBInstance.create(database.databasePath);
  const opened = await openRoutePlanner(
    {databasePath: database.databasePath},
    async () => instance
  );
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  const connection = await instance.connect();
  await connection.run('DROP VIEW planner_airports');
  connection.closeSync();

  await expect(
    opened.value.planRoute({departureIcao: 'AAAA', arrivalIcao: 'BBBB'})
  ).resolves.toEqual({
    ok: false,
    failure: {code: 'database-query-failed', operation: 'validate-contract'},
  });
  await opened.value[Symbol.asyncDispose]();
  instance.closeSync();
});

test('disposal drains active planning and deterministically rejects later calls', async () => {
  await using database = await syntheticPlannerDatabase.create(routeDefinition());
  const planner = await openPlanner(database.databasePath);
  const settlementOrder: string[] = [];

  const planning = planner
    .planRoute({departureIcao: 'AAAA', arrivalIcao: 'BBBB'})
    .finally(() => settlementOrder.push('planning'));
  const disposal = planner[Symbol.asyncDispose]();
  const observedDisposal = disposal.finally(() => settlementOrder.push('disposal'));
  const rejectedWhileClosing = planner.planRoute({
    departureIcao: 'AAAA',
    arrivalIcao: 'BBBB',
  });

  await expect(rejectedWhileClosing).rejects.toThrow(
    'Cannot plan a route while the Route Planner is closing or disposed.'
  );
  await expect(planning).resolves.toMatchObject({ok: true});
  await expect(observedDisposal).resolves.toBeUndefined();
  expect(settlementOrder).toEqual(['planning', 'disposal']);
  expect(planner[Symbol.asyncDispose]()).toBe(disposal);
  await expect(
    planner.planRoute({departureIcao: 'AAAA', arrivalIcao: 'BBBB'})
  ).rejects.toThrow(
    'Cannot plan a route while the Route Planner is closing or disposed.'
  );
});

function routeDefinition() {
  return {
    airports: [airport('airport-a', 'AAAA', 0), airport('airport-b', 'BBBB', 2)],
    navaids: [navaid('navaid-ab', 'AB', 1)],
  } as const;
}

async function openPlanner(databasePath: string) {
  const opened = await openRoutePlanner({databasePath});
  if (!opened.ok) {
    throw new Error(`Expected the synthetic database to open: ${opened.failure.code}`);
  }

  return opened.value;
}

function routePointIds(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof openPlanner>>['planRoute']>>
) {
  if (!result.ok) {
    throw new Error(`Expected route planning to succeed: ${result.failure.code}`);
  }

  return result.value.plan.routePoints.map(routePoint => routePoint.databaseId);
}

function routePointLongitudes(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof openPlanner>>['planRoute']>>
) {
  if (!result.ok) {
    throw new Error(`Expected route planning to succeed: ${result.failure.code}`);
  }

  return result.value.plan.routePoints.map(routePoint => routePoint.longitude);
}

function airport(databaseId: string, icao: string, longitude: number) {
  return {
    databaseId,
    icao,
    name: `Airport ${databaseId}`,
    longitude,
    latitude: 0,
  } as const;
}

function navaid(databaseId: string, identifier: string, longitude: number) {
  return {
    databaseId,
    identifier,
    name: `Navaid ${databaseId}`,
    family: 'VOR',
    longitude,
    latitude: 0,
    frequencyValue: 113,
    frequencyUnit: 'MHz',
    publishedRangeNm: oneDegreeNm,
  } as const;
}
