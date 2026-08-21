import {resolve} from 'node:path';

import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import dataStatusOutput from '#radial/cli/formatDataStatus.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type DataStatusInput = Readonly<Record<string, never>>;

type DataStatusSuccess = CliCommandResultTypes['Result'] &
  Readonly<{
    kind: 'success';
    success: ApplicationTypes['DataStatusSuccess'];
  }>;

type DataStatusFailure = CliCommandResultTypes['Result'] &
  Readonly<{
    kind: 'expected-failure';
    status: 1;
    failure: ApplicationTypes['DataFailure'];
  }>;

type DataStatusResult =
  | DataStatusSuccess
  | DataStatusFailure
  | Readonly<{kind: 'interrupted'; status: 130}>;

async function runDataStatus(
  _input: DataStatusInput,
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
): Promise<DataStatusResult> {
  try {
    if (runtime.signal.aborted) {
      return {kind: 'interrupted', status: 130};
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
        return {kind: 'interrupted', status: 130};
      }

      throw error;
    }

    if (runtime.signal.aborted) {
      return {kind: 'interrupted', status: 130};
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
    return {kind: 'success', status: 0, success: result.value};
  } finally {
    await runtime.disposeApplication();
  }
}

function reportFailure(
  failure: ApplicationTypes['DataFailure'],
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
): DataStatusFailure {
  runtime.io.writeStderr(dataStatusOutput.formatFailure(failure));
  telemetry.recordOperation({
    kind: 'data-status-failed',
    activeDataPreserved: failure.activeDataPreserved,
    failureCode: failure.code,
  });
  return {kind: 'expected-failure', status: 1, failure};
}

export default runDataStatus;
