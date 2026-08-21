import {resolve} from 'node:path';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import dataStatusOutput from '#radial/cli/formatDataStatus.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type DataStatusInput = Readonly<Record<string, never>>;

async function runDataStatus(
  capabilities: CliInputTypes['Admitted'],
  _input: DataStatusInput
): Promise<number> {
  return runAdmittedCliCommand(capabilities, {
    metadata: {id: 'data-status'},
    execute: executeDataStatus,
  });
}

async function executeDataStatus(
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
): Promise<0 | 1 | 130> {
  if (runtime.signal.aborted) {
    return 130;
  }

  const databasePath = runtime.env['RADIAL_DATABASE_PATH'] ?? '';
  if (databasePath.trim() === '') {
    return reportFailure(
      {
        code: 'DATA_DATABASE_PATH_MISSING',
        summary: 'Database path is missing.',
        cause: 'RADIAL_DATABASE_PATH is required for data status.',
        action: 'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.',
        activeDataPreserved: true,
      },
      runtime,
      telemetry
    );
  }

  let applicationResult:
    | Readonly<{ok: true; value: ApplicationTypes['DataStatusResult']}>
    | Readonly<{ok: false; failure: ApplicationTypes['ApplicationOpenFailure']}>;
  try {
    applicationResult = await runtime.withApplication({databasePath}, application =>
      application.dataManagement.status()
    );
  } catch (error) {
    if (cliInterruption.is(error)) {
      return 130;
    }

    throw error;
  }

  if (runtime.signal.aborted) {
    return 130;
  }

  if (!applicationResult.ok) {
    return reportFailure(
      {
        code: 'DATA_DATABASE_UNAVAILABLE',
        summary: 'The configured database is unavailable.',
        cause: 'The configured database path could not be inspected.',
        action: 'Check RADIAL_DATABASE_PATH and retry.',
        activeDataPreserved: true,
      },
      runtime,
      telemetry
    );
  }

  const result = applicationResult.value;
  if (!result.ok) {
    return reportFailure(result.failure, runtime, telemetry);
  }

  const displayStatus = {
    ...result.value,
    databasePath: databasePath === ':memory:' ? databasePath : resolve(databasePath),
  };
  runtime.io.writeStdout(dataStatusOutput.formatSuccess(displayStatus));
  telemetry.recordOperation({
    kind: 'data-status-completed',
    cachedAirportCount: result.value.cachedAirports.length,
    snapshotPresent: result.value.snapshot !== null,
    status: result.value.status,
  });
  return 0;
}

function reportFailure(
  failure: ApplicationTypes['DataFailure'],
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
): 1 {
  runtime.io.writeStderr(dataStatusOutput.formatFailure(failure));
  telemetry.recordOperation({
    kind: 'data-status-failed',
    activeDataPreserved: failure.activeDataPreserved,
    failureCode: failure.code,
  });
  return 1;
}

export default runDataStatus;
