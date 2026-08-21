import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runPlanRoute from '#radial/cli/commands/runPlanRoute.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

test('owns normalized metadata, configuration, request assembly, output, telemetry, and cleanup', async () => {
  const events: string[] = [];
  const output = captureOutput();
  const telemetry = recordingTelemetry(events);
  const signal = new AbortController().signal;
  let openedConfig: ApplicationTypes['ApplicationConfig'] | undefined;
  let plannedRequest: ApplicationTypes['RoutePlanningRequest'] | undefined;
  const application = routeApplication({
    async planRoute(request) {
      plannedRequest = request;
      return {
        ok: true,
        value: {
          plan: {
            magneticReference: null,
            routeLegs: [],
            routePoints: [],
            searchMode: 'vor-family',
            totalDistanceNm: 0,
          },
          warnings: [],
        },
      };
    },
    onApplicationDispose() {
      events.push('application disposed');
    },
    onPlannerDispose() {
      events.push('planner disposed');
    },
  });

  const status = await runPlanRoute(
    {
      env: {
        OPENAIP_API_KEY: 'secret',
        RADIAL_DATABASE_PATH: ':synthetic:',
        RADIAL_MAX_ROUTE_FACTOR: '1.75',
      },
      io: output.io,
      signal,
      async loadTelemetry() {
        return telemetry;
      },
      async openApplication(config) {
        openedConfig = config;
        return {ok: true, value: application};
      },
    },
    {
      arrivalIcao: 'CYOW',
      departureIcao: 'CYYZ',
      warningDetailsRequested: false,
    }
  );
  events.push('returned');

  expect(status).toBe(0);
  expect(openedConfig).toEqual({
    databasePath: ':synthetic:',
    maxRouteFactor: 1.75,
    openAipApiKey: 'secret',
  });
  expect(plannedRequest).toEqual({
    arrivalIcao: 'CYOW',
    departureIcao: 'CYYZ',
    signal,
  });
  expect(output.value()).toEqual({
    stderr: '',
    stdout:
      'Route Points: \n' +
      'Total Distance: 0.0 NM\n' +
      'Route Legs: 0\n' +
      'Route Search Mode: VOR-family only\n' +
      '\n' +
      'Route Legs\n' +
      'Leg  From  To  Distance  Outbound True  Arrival True  Outbound Magnetic  Arrival Magnetic  Departure VOR Guidance  Arrival VOR Guidance\n' +
      '\n' +
      'Navaids\n' +
      'Identifier  Type  Frequency  Published Range\n',
  });
  expect(events).toEqual([
    'span plan-route CYYZ CYOW',
    'planner disposed',
    'operation route-plan-completed CYYZ CYOW 0 0',
    'application disposed',
    'span result 0',
    'telemetry closed',
    'returned',
  ]);
});

test('maps an expected Route Search failure without partial output and disposes locally opened resources', async () => {
  const events: string[] = [];
  const output = captureOutput();
  const application = routeApplication({
    async planRoute() {
      return {
        ok: false,
        failure: {
          arrivalIcao: 'CYOW',
          code: 'no-route',
          completedSearchLimits: [],
          departureIcao: 'CYYZ',
          maxRouteFactor: 1.5,
        },
      };
    },
    onApplicationDispose() {
      events.push('application disposed');
    },
    onPlannerDispose() {
      events.push('planner disposed');
    },
  });

  const status = await runPlanRoute(
    {
      env: {RADIAL_DATABASE_PATH: ':synthetic:'},
      io: output.io,
      async loadTelemetry() {
        return recordingTelemetry(events);
      },
      async openApplication() {
        return {ok: true, value: application};
      },
    },
    {
      arrivalIcao: 'CYOW',
      departureIcao: 'CYYZ',
      warningDetailsRequested: true,
    }
  );

  expect(status).toBe(1);
  expect(output.value()).toEqual({
    stderr: 'No route found from CYYZ to CYOW.\n',
    stdout: '',
  });
  expect(events).toContain('planner disposed');
  expect(events).toContain('application disposed');
});

test('routes requested warning details to stderr through the exact command entry', async () => {
  const output = captureOutput();
  const application = routeApplication({
    async planRoute() {
      return {
        ok: true,
        value: {
          plan: {
            magneticReference: null,
            routeLegs: [],
            routePoints: [],
            searchMode: 'ndb-fallback',
            totalDistanceNm: 0,
          },
          warnings: [{code: 'ndb-fallback-used'}],
        },
      };
    },
  });

  const status = await runPlanRoute(
    {
      env: {RADIAL_DATABASE_PATH: ':synthetic:'},
      io: output.io,
      async loadTelemetry() {
        return recordingTelemetry([]);
      },
      async openApplication() {
        return {ok: true, value: application};
      },
    },
    {
      arrivalIcao: 'CYOW',
      departureIcao: 'CYYZ',
      warningDetailsRequested: true,
    }
  );

  expect(status).toBe(0);
  expect(output.value().stderr).toBe(
    'Warnings (1)\n' +
      '\n' +
      'NDB fallback\n' +
      '  The VOR-family search was exhausted. The route uses NDBs instead.\n' +
      '  Applies to the whole route.\n'
  );
});

test('returns silent status 130 without loading an application after interruption', async () => {
  const controller = new AbortController();
  const output = captureOutput();
  let applicationLoaded = false;
  controller.abort();

  const status = await runPlanRoute(
    {
      env: {RADIAL_DATABASE_PATH: ':synthetic:'},
      io: output.io,
      signal: controller.signal,
      async loadTelemetry() {
        return recordingTelemetry([]);
      },
      async openApplication() {
        applicationLoaded = true;
        throw new Error('The application must not open.');
      },
    },
    {
      arrivalIcao: 'CYOW',
      departureIcao: 'CYYZ',
      warningDetailsRequested: false,
    }
  );

  expect(status).toBe(130);
  expect(applicationLoaded).toBe(false);
  expect(output.value()).toEqual({stderr: '', stdout: ''});
});

function routeApplication({
  planRoute,
  onApplicationDispose = () => {},
  onPlannerDispose = () => {},
}: {
  planRoute: ApplicationTypes['Planner']['planRoute'];
  onApplicationDispose?: () => void;
  onPlannerDispose?: () => void;
}): ApplicationTypes['Application'] {
  return {
    databasePath: ':synthetic:',
    dataManagement: {
      async status() {
        throw new Error('Data status is not used.');
      },
      async reloadNavaids() {
        throw new Error('Navaid reload is not used.');
      },
      async reloadAirport() {
        throw new Error('Airport reload is not used.');
      },
    },
    planning: {
      async open() {
        return {
          ok: true,
          value: {
            planRoute,
            async [Symbol.asyncDispose]() {
              onPlannerDispose();
            },
          },
        };
      },
    },
    async [Symbol.asyncDispose]() {
      onApplicationDispose();
    },
  };
}

function captureOutput() {
  let stderr = '';
  let stdout = '';
  return {
    io: {
      writeStderr(text: string) {
        stderr += text;
      },
      writeStdout(text: string) {
        stdout += text;
      },
    },
    value() {
      return {stderr, stdout};
    },
  };
}

function recordingTelemetry(events: string[]): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      if (metadata.id !== 'plan-route') {
        throw new Error('Expected Route Plan metadata.');
      }

      events.push(
        `span ${metadata.id} ${metadata.attributes['radial.route.departure_icao']} ${metadata.attributes['radial.route.arrival_icao']}`
      );
      const result = await operation();
      events.push(`span result ${result.status}`);
      return result;
    },
    recordOperation(event) {
      if (event.kind === 'route-plan-completed') {
        events.push(
          `operation ${event.kind} ${event.departureIcao} ${event.arrivalIcao} ${event.routeDistanceNm} ${event.routeLegCount}`
        );
      }
    },
    async close() {
      events.push('telemetry closed');
    },
  };
}
