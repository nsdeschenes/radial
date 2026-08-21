import {expect, test} from 'vitest';

import createCliTelemetrySession from '#radial/cli/telemetry/createCliTelemetrySession.js';

const resultCases = [
  {result: {kind: 'success', status: 0}, outcome: 'success', log: 'info'},
  {
    result: {kind: 'expected-failure', status: 1},
    outcome: 'failure',
    log: 'error',
  },
  {
    result: {kind: 'expected-failure', status: 2},
    outcome: 'failure',
    log: 'error',
  },
  {
    result: {kind: 'interrupted', status: 130},
    outcome: 'failure',
    log: 'error',
  },
] satisfies readonly Readonly<{
  result: Readonly<{kind: string; status: number}>;
  outcome: 'failure' | 'success';
  log: 'error' | 'info';
}>[];

test.each(resultCases)(
  'records returned status $result.status as an operational outcome',
  async sample => {
    const events: unknown[] = [];
    const telemetry = createCliTelemetrySession(recordingClient(events));

    await expect(
      telemetry.execute(
        {
          id: 'reload-airport',
          attributes: {'radial.airport.icao': 'CYYZ'},
        },
        async () => sample.result
      )
    ).resolves.toEqual(sample.result);

    expect(events).toEqual([
      {
        span: {
          attributes: {
            'radial.airport.icao': 'CYYZ',
            'radial.cli.command': 'reload-airport',
          },
          name: 'radial cli',
          op: 'cli',
        },
      },
      {
        metric: {command: 'reload-airport', outcome: sample.outcome},
      },
      {
        [sample.log]: {
          attributes: {
            'radial.airport.icao': 'CYYZ',
            'radial.cli.command': 'reload-airport',
            'radial.cli.exit_code': sample.result.status,
          },
          message: `CLI command reload-airport ${sample.result.status === 0 ? 'completed' : 'failed'}`,
        },
      },
      {span: 'ended'},
    ]);
  }
);

test('captures an escaping defect exactly once inside the command span', async () => {
  const events: unknown[] = [];
  const defect = new Error('handler defect');
  const telemetry = createCliTelemetrySession(recordingClient(events));

  await expect(
    telemetry.execute({id: 'data-status'}, async () => {
      throw defect;
    })
  ).rejects.toBe(defect);

  expect(events).toEqual([
    {
      span: {
        attributes: {'radial.cli.command': 'data-status'},
        name: 'radial cli',
        op: 'cli',
      },
    },
    {captured: defect},
    {span: 'ended'},
  ]);
});

test('records data-status operation telemetry through the central session', () => {
  const events: unknown[] = [];
  const telemetry = createCliTelemetrySession(recordingClient(events));

  telemetry.recordOperation({
    kind: 'data-status-failed',
    activeDataPreserved: true,
    failureCode: 'DATA_DATABASE_PATH_MISSING',
  });
  telemetry.recordOperation({
    kind: 'data-status-completed',
    cachedAirportCount: 2,
    snapshotPresent: true,
    status: 'ready',
  });

  expect(events).toEqual([
    {
      error: {
        attributes: {
          'radial.data.active_preserved': true,
          'radial.failure.code': 'DATA_DATABASE_PATH_MISSING',
        },
        message: 'Data status read failed',
      },
    },
    {
      info: {
        attributes: {
          'radial.airport.cached_count': 2,
          'radial.data.snapshot_present': true,
          'radial.data.status': 'ready',
        },
        message: 'Data status read completed',
      },
    },
  ]);
});

test('records Route Plan distributions and grouped warnings through the central session', () => {
  const events: unknown[] = [];
  const telemetry = createCliTelemetrySession(recordingClient(events));

  telemetry.recordOperation({
    kind: 'route-plan-completed',
    arrivalIcao: 'CYOW',
    departureIcao: 'CYYZ',
    routeDistanceNm: 195,
    routeLegCount: 3,
    warningCodes: [
      'facility-variation-date-unavailable',
      'facility-variation-date-unavailable',
    ],
  });

  expect(events).toEqual([
    {
      distribution: {attributes: undefined, name: 'total_route_legs', value: 3},
    },
    {
      distribution: {
        attributes: {arrival_icao: 'CYOW', departure_icao: 'CYYZ'},
        name: 'total_route_distance',
        value: 195,
      },
    },
    {
      warn: {
        attributes: {
          'radial.route.arrival_icao': 'CYOW',
          'radial.route.departure_icao': 'CYYZ',
          'radial.route.warning_count': 2,
          'radial.route.warning.facility-variation-date-unavailable.count': 2,
        },
        message: 'Route plan CYYZ to CYOW completed with warnings',
      },
    },
  ]);
});

test('bounds flush, always attempts close, and suppresses shutdown failures', async () => {
  const events: unknown[] = [];
  const client = recordingClient(events, {closeFails: true, flushFails: true});
  const telemetry = createCliTelemetrySession(client);

  await expect(telemetry.close()).resolves.toBeUndefined();
  expect(events).toEqual([{flush: 2_000}, 'close']);
});

function recordingClient(
  events: unknown[],
  failures: Readonly<{closeFails?: boolean; flushFails?: boolean}> = {}
) {
  return {
    captureException(error: unknown) {
      events.push({captured: error});
    },
    async close() {
      events.push('close');
      if (failures.closeFails === true) {
        throw new Error('close failed');
      }
    },
    async flush(timeout: number) {
      events.push({flush: timeout});
      if (failures.flushFails === true) {
        throw new Error('flush failed');
      }
    },
    logError(message: string, attributes: Record<string, boolean | number | string>) {
      events.push({error: {attributes, message}});
    },
    logInfo(message: string, attributes: Record<string, boolean | number | string>) {
      events.push({info: {attributes, message}});
    },
    logWarn(message: string, attributes: Record<string, boolean | number | string>) {
      events.push({warn: {attributes, message}});
    },
    recordCommand(attributes: Readonly<{command: string; outcome: string}>) {
      events.push({metric: attributes});
    },
    recordDistribution(
      name: string,
      value: number,
      attributes?: Readonly<Record<string, string>>
    ) {
      events.push({distribution: {attributes, name, value}});
    },
    async startSpan<Value>(options: unknown, operation: () => Promise<Value>) {
      events.push({span: options});
      try {
        return await operation();
      } finally {
        events.push({span: 'ended'});
      }
    },
  };
}
