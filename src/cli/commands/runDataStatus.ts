import type CliInputTypes from '#radial/cli/CliInput.js';
import dataStatusOutput from '#radial/cli/formatDataStatus.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type DataStatusInput = Readonly<Record<string, never>>;

async function runDataStatus(
  capabilities: CliInputTypes['Admitted'],
  _input: DataStatusInput
): Promise<number> {
  return runAdmittedCliCommand(capabilities, {
    applicationAccess: false,
    metadata: {id: 'data-status'},
    execute: executeDataStatus,
  });
}

async function executeDataStatus(
  runtime: CliRuntimeTypes['LifecycleContext'],
  telemetry: CliTelemetryTypes['Session']
): Promise<0 | 1 | 130> {
  if (runtime.signal.aborted) {
    return 130;
  }

  const dataStatusModule = await import('#radial/data-producer/internal/DataStatus.js');
  const result = await dataStatusModule.default(
    runtime.env['RADIAL_DATABASE_PATH'] ?? ''
  );
  if (runtime.signal.aborted) {
    return 130;
  }

  if (!result.ok) {
    runtime.io.writeStderr(dataStatusOutput.formatFailure(result.failure));
    telemetry.recordOperation({
      kind: 'data-status-failed',
      activeDataPreserved: result.failure.activeDataPreserved,
      failureCode: result.failure.code,
    });
    return 1;
  }

  runtime.io.writeStdout(dataStatusOutput.formatSuccess(result.value));
  telemetry.recordOperation({
    kind: 'data-status-completed',
    cachedAirportCount: result.value.cachedAirports.length,
    snapshotPresent: result.value.snapshot !== null,
    status: result.value.status,
  });
  return 0;
}

export default runDataStatus;
