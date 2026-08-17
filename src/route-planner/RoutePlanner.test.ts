import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';

test.each([
  {
    config: {databasePath: ''},
    failure: {
      code: 'invalid-configuration',
      field: 'databasePath',
      reason: 'required',
      value: '',
    },
  },
  {
    config: {databasePath: ':memory:', maxRouteFactor: Number.NaN},
    failure: {
      code: 'invalid-configuration',
      field: 'maxRouteFactor',
      reason: 'must-be-finite-and-at-least-one',
      value: Number.NaN,
    },
  },
  {
    config: {databasePath: ':memory:', maxRouteFactor: 0.99},
    failure: {
      code: 'invalid-configuration',
      field: 'maxRouteFactor',
      reason: 'must-be-finite-and-at-least-one',
      value: 0.99,
    },
  },
])(
  'rejects invalid planner configuration as a structured failure',
  async ({config, failure}) => {
    await expect(openRoutePlanner(config)).resolves.toEqual({
      ok: false,
      failure,
    });
  }
);

test('rejects a database path that does not identify an existing file', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-planner-'));
  const databasePath = join(temporaryDirectory, 'missing.duckdb');

  try {
    const opened = await openRoutePlanner({databasePath});

    if (opened.ok) {
      await opened.value[Symbol.asyncDispose]();
    }

    expect(opened).toEqual({
      ok: false,
      failure: {code: 'database-unavailable', databasePath},
    });
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test.each([
  {
    request: {departureIcao: ' YYZ ', arrivalIcao: 'CYOW'},
    failure: {
      code: 'invalid-request',
      field: 'departureIcao',
      reason: 'invalid-icao',
      value: ' YYZ ',
      normalizedIcao: 'YYZ',
    },
  },
  {
    request: {departureIcao: 'ÇYYZ', arrivalIcao: 'CYOW'},
    failure: {
      code: 'invalid-request',
      field: 'departureIcao',
      reason: 'invalid-icao',
      value: 'ÇYYZ',
      normalizedIcao: 'ÇYYZ',
    },
  },
  {
    request: {departureIcao: 'cyyz', arrivalIcao: ' CYYZ '},
    failure: {
      code: 'invalid-request',
      field: 'arrivalIcao',
      reason: 'identical-airports',
      value: ' CYYZ ',
      normalizedIcao: 'CYYZ',
    },
  },
])(
  'normalizes and rejects invalid route requests through the public boundary',
  async ({request, failure}) => {
    const opened = await openRoutePlanner({
      databasePath: ':memory:',
    });
    expect(opened.ok).toBe(true);

    if (!opened.ok) {
      return;
    }

    await expect(opened.value.planRoute(request)).resolves.toEqual({ok: false, failure});
    await opened.value[Symbol.asyncDispose]();
  }
);
