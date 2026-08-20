import {resolve} from 'node:path';

import {expect, test} from 'vitest';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import runCli from '#radial/cli/main.js';

type OutputWrite = Readonly<{channel: 'stderr' | 'stdout'; text: string}>;
type CompatibilityCase = Readonly<{
  name: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  applicationOpens?: number;
  routeRequest?: Readonly<{arrivalIcao: string; departureIcao: string}>;
  airportReloadIcao?: string;
  navaidReload?: boolean;
}>;

const ROUTE_USAGE =
  'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
  'Example: radial CYYZ CYOW\n';
const DATA_STATUS_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The data status command accepts no arguments or operational flags.\n' +
  'Action: Run "radial data status".\n';
const NAVAID_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
  'Action: Run "radial data reload navaids".\n';
const AIRPORT_RELOAD_USAGE =
  'error [DATA_USAGE]: Invalid data command.\n' +
  'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
  'Action: Run "radial data reload airport <ICAO>".\n';
const DATA_ENV = {
  OPENAIP_API_KEY: 'compatibility-api-key',
  RADIAL_DATABASE_PATH: ':compatibility:',
};

const compatibilityCases: readonly CompatibilityCase[] = [
  {
    name: 'empty Route Plan input',
    args: [],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 0.\n${ROUTE_USAGE}`,
  },
  {
    name: 'short Route Plan input',
    args: ['CYYZ'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 1.\n${ROUTE_USAGE}`,
  },
  {
    name: 'exact normalized Route Plan input',
    args: [' cyyz ', 'cyow'],
    env: DATA_ENV,
    exitCode: 1,
    stderr: 'No route found from CYYZ to CYOW.\n',
    applicationOpens: 1,
    routeRequest: {arrivalIcao: 'CYOW', departureIcao: 'CYYZ'},
  },
  {
    name: 'long Route Plan input',
    args: ['CYYZ', 'CYOW', 'extra'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'invalid departure ICAO',
    args: [' YYZ ', 'CYOW'],
    exitCode: 2,
    stderr:
      'Departure must be a four-letter ICAO airport code; received " YYZ ".\n' +
      ROUTE_USAGE,
  },
  {
    name: 'invalid arrival ICAO',
    args: ['CYYZ', ' YYZ '],
    exitCode: 2,
    stderr:
      'Arrival must be a four-letter ICAO airport code; received " YYZ ".\n' +
      ROUTE_USAGE,
  },
  {
    name: 'normalized-identical ICAOs',
    args: [' cyyz ', 'CYYZ'],
    exitCode: 2,
    stderr:
      'Departure and arrival must be different airports; both normalize to "CYYZ".\n' +
      ROUTE_USAGE,
  },
  {
    name: 'terminal warnings option',
    args: ['CYYZ', 'CYOW', '--warnings'],
    env: DATA_ENV,
    exitCode: 1,
    stderr: 'No route found from CYYZ to CYOW.\n',
    applicationOpens: 1,
    routeRequest: {arrivalIcao: 'CYOW', departureIcao: 'CYYZ'},
  },
  {
    name: 'prefix warnings option',
    args: ['--warnings', 'CYYZ', 'CYOW'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'embedded warnings option',
    args: ['CYYZ', '--warnings', 'CYOW'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'warnings option in place of arrival',
    args: ['CYYZ', '--warnings'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 1.\n${ROUTE_USAGE}`,
  },
  {
    name: 'repeated warnings option',
    args: ['CYYZ', 'CYOW', '--warnings', '--warnings'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'valid data status command',
    args: ['data', 'status'],
    env: {RADIAL_DATABASE_PATH: 'missing-public-cli-compatibility.duckdb'},
    exitCode: 0,
    stdout:
      'Radial data status\n' +
      'Database\n' +
      `  Path: ${resolve('missing-public-cli-compatibility.duckdb')}\n` +
      '  State: uninitialized\n' +
      '  Producer Schema version: —\n' +
      '  Planner contract version: —\n' +
      '  Checksum manifest version: —\n' +
      '  Legacy data: —\n' +
      '\nNavaid Snapshot\n' +
      '  State: uninitialized\n' +
      '\nCached Airports\n' +
      '  —\n',
  },
  {
    name: 'valid Navaid reload command',
    args: ['data', 'reload', 'navaids'],
    env: DATA_ENV,
    exitCode: 1,
    stderr:
      'error [DATA_OPENAIP_UNAVAILABLE]: OpenAIP Navaid acquisition failed.\n' +
      'Cause: The compatibility application returned an operational failure.\n' +
      'Action: Retry the Navaid reload.\n' +
      'Active data remains unchanged.\n',
    applicationOpens: 1,
    navaidReload: true,
  },
  {
    name: 'valid normalized Airport reload command',
    args: ['data', 'reload', 'airport', ' cyyz '],
    env: DATA_ENV,
    exitCode: 1,
    stderr:
      'error [DATA_AIRPORT_NOT_FOUND]: The requested Airport was not found.\n' +
      'Cause: The compatibility application returned no Airport.\n' +
      'Action: Check the ICAO and retry the Airport reload.\n' +
      'Active data remains unchanged.\n',
    applicationOpens: 1,
    airportReloadIcao: 'CYYZ',
  },
  {
    name: 'unknown data route',
    args: ['data', 'unknown'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'incomplete data route',
    args: ['data'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'incomplete reload route',
    args: ['data', 'reload'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'unknown reload route',
    args: ['data', 'reload', 'unknown'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'unsupported Route Plan option',
    args: ['CYYZ', 'CYOW', '--force'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'unsupported data status option',
    args: ['data', 'status', '--force'],
    exitCode: 2,
    stderr: DATA_STATUS_USAGE,
  },
  {
    name: 'unsupported Navaid reload option',
    args: ['data', 'reload', 'navaids', '--force'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'unsupported Airport reload option',
    args: ['data', 'reload', 'airport', '--force'],
    exitCode: 2,
    stderr: AIRPORT_RELOAD_USAGE,
  },
  {
    name: 'extra data status positional',
    args: ['data', 'status', 'extra'],
    exitCode: 2,
    stderr: DATA_STATUS_USAGE,
  },
  {
    name: 'extra Navaid reload positional',
    args: ['data', 'reload', 'navaids', 'extra'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'missing Airport reload positional',
    args: ['data', 'reload', 'airport'],
    exitCode: 2,
    stderr: AIRPORT_RELOAD_USAGE,
  },
  {
    name: 'extra Airport reload positional',
    args: ['data', 'reload', 'airport', 'CYYZ', 'extra'],
    exitCode: 2,
    stderr: AIRPORT_RELOAD_USAGE,
  },
  {
    name: 'data status leaf help',
    args: ['data', 'status', '--help'],
    exitCode: 0,
    stdout: 'Usage: radial data status\n',
  },
  {
    name: 'Navaid reload leaf help',
    args: ['data', 'reload', 'navaids', '--help'],
    exitCode: 0,
    stdout: 'Usage: radial data reload navaids\n',
  },
  {
    name: 'Airport reload leaf help',
    args: ['data', 'reload', 'airport', '--help'],
    exitCode: 0,
    stdout: 'Usage: radial data reload airport <ICAO>\n',
  },
  {
    name: 'rejected root help',
    args: ['--help'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 1.\n${ROUTE_USAGE}`,
  },
  {
    name: 'rejected data help',
    args: ['data', '--help'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'rejected reload help',
    args: ['data', 'reload', '--help'],
    exitCode: 2,
    stderr: NAVAID_RELOAD_USAGE,
  },
  {
    name: 'rejected Route Plan help',
    args: ['CYYZ', 'CYOW', '--help'],
    exitCode: 2,
    stderr: `Expected exactly two ICAO airport codes; received 3.\n${ROUTE_USAGE}`,
  },
  {
    name: 'rejected leaf help with extra positional',
    args: ['data', 'status', '--help', 'extra'],
    exitCode: 2,
    stderr: DATA_STATUS_USAGE,
  },
];

test.each(compatibilityCases)('$name preserves the Public CLI contract', async sample => {
  const capture = captureOutput();
  const application = compatibilityApplication();

  const exitCode = await runCli({
    args: sample.args,
    env: sample.env ?? {},
    io: capture.io,
    openApplication: application.open,
  });

  expect(exitCode).toBe(sample.exitCode);
  expect(capture.output()).toEqual({
    stdout: sample.stdout ?? '',
    stderr: sample.stderr ?? '',
  });
  expect(capture.writes()).toEqual(expectedWrites(sample));
  expect(application.evidence.applicationOpens).toBe(sample.applicationOpens ?? 0);
  expect(application.evidence.routeRequests).toEqual(
    sample.routeRequest === undefined ? [] : [sample.routeRequest]
  );
  expect(application.evidence.airportReloadIcaos).toEqual(
    sample.airportReloadIcao === undefined ? [] : [sample.airportReloadIcao]
  );
  expect(application.evidence.navaidReloads).toBe(sample.navaidReload === true ? 1 : 0);
});

test('recognized interruption remains silent and exits 130 through the Public CLI seam', async () => {
  const capture = captureOutput();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const application = compatibilityApplication({
    async reloadNavaids(request) {
      started.resolve();
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
      throw new Error('The interrupted reload must not complete.');
    },
  });

  const running = runCli({
    args: ['data', 'reload', 'navaids'],
    env: DATA_ENV,
    io: capture.io,
    openApplication: application.open,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();

  await expect(running).resolves.toBe(130);
  expect(capture.output()).toEqual({stderr: '', stdout: ''});
  expect(capture.writes()).toEqual([]);
  expect(application.evidence.applicationOpens).toBe(1);
});

function captureOutput() {
  let stdout = '';
  let stderr = '';
  const writes: OutputWrite[] = [];

  return {
    io: {
      writeStdout(text: string) {
        stdout += text;
        writes.push({channel: 'stdout', text});
      },
      writeStderr(text: string) {
        stderr += text;
        writes.push({channel: 'stderr', text});
      },
    },
    output() {
      return {stderr, stdout};
    },
    writes() {
      return writes;
    },
  };
}

function expectedWrites(sample: CompatibilityCase): readonly OutputWrite[] {
  if (sample.stdout !== undefined) {
    return [{channel: 'stdout', text: sample.stdout}];
  }

  if (sample.stderr !== undefined) {
    return [{channel: 'stderr', text: sample.stderr}];
  }

  return [];
}

function compatibilityApplication(
  overrides: Partial<ApplicationTypes['DataManagementCapability']> = {}
) {
  const evidence = {
    airportReloadIcaos: [] as string[],
    applicationOpens: 0,
    navaidReloads: 0,
    routeRequests: [] as Array<{arrivalIcao: string; departureIcao: string}>,
  };
  const application: ApplicationTypes['Application'] = {
    databasePath: ':compatibility:',
    dataManagement: {
      async status() {
        throw new Error('Data status does not open the application.');
      },
      async reloadNavaids() {
        evidence.navaidReloads += 1;
        return {
          ok: false,
          failure: {
            code: 'DATA_OPENAIP_UNAVAILABLE',
            summary: 'OpenAIP Navaid acquisition failed.',
            cause: 'The compatibility application returned an operational failure.',
            action: 'Retry the Navaid reload.',
            activeDataPreserved: true,
          },
        };
      },
      async reloadAirport(request) {
        evidence.airportReloadIcaos.push(request.icao);
        return {
          ok: false,
          failure: {
            code: 'DATA_AIRPORT_NOT_FOUND',
            summary: 'The requested Airport was not found.',
            cause: 'The compatibility application returned no Airport.',
            action: 'Check the ICAO and retry the Airport reload.',
            activeDataPreserved: true,
          },
        };
      },
      ...overrides,
    },
    planning: {
      async open() {
        return {
          ok: true,
          value: {
            async planRoute(request) {
              evidence.routeRequests.push({
                arrivalIcao: request.arrivalIcao,
                departureIcao: request.departureIcao,
              });
              return {
                ok: false,
                failure: {
                  code: 'no-route',
                  arrivalIcao: request.arrivalIcao,
                  completedSearchLimits: [],
                  departureIcao: request.departureIcao,
                  maxRouteFactor: 1.5,
                },
              };
            },
            async [Symbol.asyncDispose]() {},
          },
        };
      },
    },
    async [Symbol.asyncDispose]() {},
  };

  return {
    evidence,
    open: async (): Promise<ApplicationTypes['ApplicationOpenResult']> => {
      evidence.applicationOpens += 1;
      return {ok: true, value: application};
    },
  };
}
