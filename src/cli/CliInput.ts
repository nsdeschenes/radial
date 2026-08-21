import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type AdmittedCliInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  io: CliRuntimeTypes['Io'];
  loadTelemetry?: CliTelemetryTypes['Loader'];
  openApplication?: CliRuntimeTypes['ApplicationOpener'];
  signal?: AbortSignal;
}>;

type CliInput = AdmittedCliInput & Readonly<{args: readonly string[]}>;

export default interface CliInputTypes {
  Admitted: AdmittedCliInput;
  Input: CliInput;
}
