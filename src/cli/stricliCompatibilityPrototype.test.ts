import {expect, test} from 'vitest';

import prototype from '#radial/cli/stricliCompatibilityPrototype.js';

const createPrototypeEvidence = prototype.createEvidence;
const INTERNAL_PLAN_ROUTE = prototype.internalPlanRoute;
const runPrototype = prototype.run;

function captureOutput() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      writeStderr(text: string) {
        stderr += text;
      },
      writeStdout(text: string) {
        stdout += text;
      },
    },
    output() {
      return {stderr, stdout};
    },
  };
}

test('routes the hidden default Route Plan command beside the nested data tree', async () => {
  const cases = [
    {args: ['CYYZ', 'CYOW'], identity: 'plan-route'},
    {args: ['data', 'status'], identity: 'data-status'},
    {args: ['data', 'reload', 'navaids'], identity: 'reload-navaids'},
    {args: ['data', 'reload', 'airport', 'CYYZ'], identity: 'reload-airport'},
  ] as const;

  for (const sample of cases) {
    const capture = captureOutput();
    const evidence = createPrototypeEvidence();

    await expect(
      runPrototype({args: sample.args, evidence, io: capture.io})
    ).resolves.toBe(0);
    expect(capture.output()).toEqual({stderr: '', stdout: ''});
    expect(evidence).toEqual({
      commandLoads: [sample.identity],
      commandRuns: [sample.identity],
      contextLoads: [sample.identity],
    });
  }
});

test('preserves leaf help bytes and adds import-light root help', async () => {
  const cases = [
    {
      args: ['--help'],
      stdout:
        'Usage:\n' +
        '  radial <departure-icao> <arrival-icao> [--warnings]\n' +
        '  radial data status\n' +
        '  radial data reload navaids\n' +
        '  radial data reload airport <ICAO>\n',
    },
    {args: ['data', 'status', '--help'], stdout: 'Usage: radial data status\n'},
    {
      args: ['data', 'reload', 'navaids', '--help'],
      stdout: 'Usage: radial data reload navaids\n',
    },
    {
      args: ['data', 'reload', 'airport', '--help'],
      stdout: 'Usage: radial data reload airport <ICAO>\n',
    },
  ] as const;

  for (const sample of cases) {
    const capture = captureOutput();
    const evidence = createPrototypeEvidence();

    await expect(
      runPrototype({args: sample.args, evidence, io: capture.io})
    ).resolves.toBe(0);
    expect(capture.output()).toEqual({stderr: '', stdout: sample.stdout});
    expect(evidence).toEqual({commandLoads: [], commandRuns: [], contextLoads: []});
  }
});

test('preserves malformed diagnostics and never loads a command for rejected input', async () => {
  const routeUsage =
    'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
    'Example: radial CYYZ CYOW\n';
  const dataStatusUsage =
    'error [DATA_USAGE]: Invalid data command.\n' +
    'Cause: The data status command accepts no arguments or operational flags.\n' +
    'Action: Run "radial data status".\n';
  const navaidUsage =
    'error [DATA_USAGE]: Invalid data command.\n' +
    'Cause: The Navaid reload accepts no arguments or operational flags.\n' +
    'Action: Run "radial data reload navaids".\n';
  const airportUsage =
    'error [DATA_USAGE]: Invalid data command.\n' +
    'Cause: The Airport reload accepts exactly one ICAO and no operational flags.\n' +
    'Action: Run "radial data reload airport <ICAO>".\n';
  const cases = [
    {
      args: [],
      stderr: `Expected exactly two ICAO airport codes; received 0.\n${routeUsage}`,
    },
    {
      args: ['CYYZ'],
      stderr: `Expected exactly two ICAO airport codes; received 1.\n${routeUsage}`,
    },
    {
      args: ['--warnings', 'CYYZ', 'CYOW'],
      stderr: `Expected exactly two ICAO airport codes; received 3.\n${routeUsage}`,
    },
    {
      args: [' YYZ ', 'CYOW'],
      stderr: `Departure must be a four-letter ICAO airport code; received " YYZ ".\n${routeUsage}`,
    },
    {
      args: ['CYYZ', ' YYZ '],
      stderr: `Arrival must be a four-letter ICAO airport code; received " YYZ ".\n${routeUsage}`,
    },
    {
      args: [' cyyz ', 'CYYZ'],
      stderr: `Departure and arrival must be different airports; both normalize to "CYYZ".\n${routeUsage}`,
    },
    {args: ['data'], stderr: navaidUsage},
    {args: ['data', 'unknown'], stderr: navaidUsage},
    {args: ['data', 'status', '--force'], stderr: dataStatusUsage},
    {args: ['data', 'reload', 'navaids', '--force'], stderr: navaidUsage},
    {args: ['data', 'reload', 'airport'], stderr: airportUsage},
    {args: ['data', 'reload', 'airport', '--force'], stderr: airportUsage},
    {args: ['data', 'reload', 'airport', 'CYYZ', 'extra'], stderr: airportUsage},
    {
      args: ['data', 'reload', 'airport', ' bad '],
      stderr:
        'error [DATA_INVALID_ICAO]: The Airport ICAO is invalid.\n' +
        'Cause: The requested Airport ICAO " bad " is not four ASCII letters.\n' +
        'Action: Provide exactly one four-letter ICAO and retry the Airport reload.\n' +
        'Active data remains unchanged.\n',
    },
  ] as const;

  for (const sample of cases) {
    const capture = captureOutput();
    const evidence = createPrototypeEvidence();

    await expect(
      runPrototype({args: sample.args, evidence, io: capture.io})
    ).resolves.toBe(2);
    expect(capture.output()).toEqual({stderr: sample.stderr, stdout: ''});
    expect(evidence.commandLoads).toEqual([]);
    expect(evidence.commandRuns).toEqual([]);
  }
});

test('accepts --warnings only as the terminal token', async () => {
  const acceptedEvidence = createPrototypeEvidence();
  const rejectedEvidence = createPrototypeEvidence();
  const acceptedCapture = captureOutput();
  const rejectedCapture = captureOutput();

  await expect(
    runPrototype({
      args: ['CYYZ', 'CYOW', '--warnings'],
      evidence: acceptedEvidence,
      io: acceptedCapture.io,
    })
  ).resolves.toBe(0);
  await expect(
    runPrototype({
      args: ['--warnings', 'CYYZ', 'CYOW'],
      evidence: rejectedEvidence,
      io: rejectedCapture.io,
    })
  ).resolves.toBe(2);

  expect(acceptedEvidence.commandLoads).toEqual(['plan-route']);
  expect(rejectedEvidence.commandLoads).toEqual([]);
});

test('preserves command statuses and translates Stricli parsing and routing statuses', async () => {
  for (const exitCode of [0, 1, 2, 130] as const) {
    await expect(
      runPrototype({
        args: ['CYYZ', 'CYOW'],
        evidence: createPrototypeEvidence(),
        io: captureOutput().io,
        requestedExitCode: exitCode,
      })
    ).resolves.toBe(exitCode);
  }

  await expect(
    runPrototype({
      args: ['CYYZ'],
      evidence: createPrototypeEvidence(),
      io: captureOutput().io,
    })
  ).resolves.toBe(2);
  await expect(
    runPrototype({
      args: ['data', 'unknown'],
      evidence: createPrototypeEvidence(),
      io: captureOutput().io,
    })
  ).resolves.toBe(2);
});

test('recognizes interruption silently and removes signal listeners', async () => {
  const controller = new AbortController();
  const capture = captureOutput();
  const evidence = createPrototypeEvidence();
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');
  controller.abort();

  await expect(
    runPrototype({
      args: ['CYYZ', 'CYOW'],
      evidence,
      io: capture.io,
      signal: controller.signal,
    })
  ).resolves.toBe(130);
  expect(capture.output()).toEqual({stderr: '', stdout: ''});
  expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
});

test('rejects explicit invocation of the hidden internal default route before loading', async () => {
  const capture = captureOutput();
  const evidence = createPrototypeEvidence();

  await expect(
    runPrototype({
      args: [INTERNAL_PLAN_ROUTE, 'CYYZ', 'CYOW'],
      evidence,
      io: capture.io,
    })
  ).resolves.toBe(2);
  expect(capture.output()).toEqual({
    stderr:
      'Expected exactly two ICAO airport codes; received 3.\n' +
      'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
      'Example: radial CYYZ CYOW\n',
    stdout: '',
  });
  expect(evidence.commandLoads).toEqual([]);
  expect(evidence.commandRuns).toEqual([]);

  const helpCapture = captureOutput();
  const helpEvidence = createPrototypeEvidence();
  await expect(
    runPrototype({
      args: [INTERNAL_PLAN_ROUTE, '--help'],
      evidence: helpEvidence,
      io: helpCapture.io,
    })
  ).resolves.toBe(2);
  expect(helpCapture.output()).toEqual({
    stderr:
      `Departure must be a four-letter ICAO airport code; received ${JSON.stringify(INTERNAL_PLAN_ROUTE)}.\n` +
      'Usage: radial <departure-icao> <arrival-icao> [--warnings]\n' +
      'Example: radial CYYZ CYOW\n',
    stdout: '',
  });
  expect(helpEvidence).toEqual({commandLoads: [], commandRuns: [], contextLoads: []});
});
