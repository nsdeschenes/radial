import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import dataStatusOutput from '#radial/cli/formatDataStatus.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';

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
  if (runtime.signal.aborted) {
    return {kind: 'interrupted', status: 130};
  }

  const result = await readDataStatus(runtime.env['RADIAL_DATABASE_PATH'] ?? '');
  if (runtime.signal.aborted) {
    return {kind: 'interrupted', status: 130};
  }

  if (!result.ok) {
    runtime.io.writeStderr(dataStatusOutput.formatFailure(result.failure));
    telemetry.recordOperation({
      kind: 'data-status-failed',
      activeDataPreserved: result.failure.activeDataPreserved,
      failureCode: result.failure.code,
    });
    return {kind: 'expected-failure', status: 1, failure: result.failure};
  }

  runtime.io.writeStdout(dataStatusOutput.formatSuccess(result.value));
  telemetry.recordOperation({
    kind: 'data-status-completed',
    cachedAirportCount: result.value.cachedAirports.length,
    snapshotPresent: result.value.snapshot !== null,
    status: result.value.status,
  });
  return {kind: 'success', status: 0, success: result.value};
}

export default runDataStatus;
