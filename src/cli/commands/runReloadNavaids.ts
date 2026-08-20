import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import navaidReloadOutput from '#radial/cli/formatNavaidReload.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';

type ReloadNavaidsInput = Readonly<Record<string, never>>;

async function runReloadNavaids(
  _input: ReloadNavaidsInput,
  runtime: CliRuntimeTypes['Context']
): Promise<CliCommandResultTypes['Result']> {
  if ((runtime.env['RADIAL_DATABASE_PATH'] ?? '').trim() === '') {
    runtime.io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_DATABASE_PATH_MISSING',
        summary: 'Database path is missing.',
        cause: 'RADIAL_DATABASE_PATH is required.',
        action: 'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry.',
        activeDataPreserved: true,
      })
    );
    return {kind: 'expected-failure', status: 1};
  }

  if ((runtime.env['OPENAIP_API_KEY'] ?? '').trim() === '') {
    runtime.io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Navaid reload.',
        action: 'Set OPENAIP_API_KEY and retry the Navaid reload.',
        activeDataPreserved: true,
      })
    );
    return {kind: 'expected-failure', status: 1};
  }

  try {
    return await reloadNavaidsWithApplication(runtime);
  } finally {
    await runtime.disposeApplication();
  }
}

async function reloadNavaidsWithApplication(
  runtime: CliRuntimeTypes['Context']
): Promise<CliCommandResultTypes['Result']> {
  let applicationResult:
    | Readonly<{ok: true; value: CliCommandResultTypes['Result']}>
    | Readonly<{
        ok: false;
        failure: ApplicationTypes['ApplicationOpenFailure'];
      }>;
  try {
    applicationResult = await runtime.withApplication(
      {databasePath: runtime.env['RADIAL_DATABASE_PATH']!},
      async application => {
        let result: ApplicationTypes['NavaidReloadResult'];
        try {
          result = await application.dataManagement.reloadNavaids({
            openAipApiKey: runtime.env['OPENAIP_API_KEY']!,
            onProgress(progress) {
              runtime.io.writeStderr(navaidReloadOutput.formatProgress(progress));
            },
            signal: runtime.signal,
          });
        } catch (error) {
          if (cliInterruption.isCancellation(error, runtime.signal)) {
            return {kind: 'interrupted', status: 130};
          }

          throw error;
        }

        if (!result.ok) {
          runtime.io.writeStderr(navaidReloadOutput.formatFailure(result.failure));
          return {kind: 'expected-failure', status: 1};
        }

        runtime.io.writeStdout(navaidReloadOutput.formatSuccess(result.value));
        return {kind: 'success', status: 0};
      }
    );
  } catch (error) {
    if (cliInterruption.is(error)) {
      return {kind: 'interrupted', status: 130};
    }

    throw error;
  }

  if (!applicationResult.ok) {
    runtime.io.writeStderr(
      navaidReloadOutput.formatFailure({
        code: 'DATA_DATABASE_UNAVAILABLE',
        summary: 'The configured database is unavailable.',
        cause: 'The configured database could not be opened.',
        action: 'Check RADIAL_DATABASE_PATH and retry the Navaid reload.',
        activeDataPreserved: true,
      })
    );
    return {kind: 'expected-failure', status: 1};
  }

  return applicationResult.value;
}

export default runReloadNavaids;
