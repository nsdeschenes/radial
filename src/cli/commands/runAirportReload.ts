import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import airportReloadOutput from '#radial/cli/formatAirportReload.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';

type AirportReloadInput = Readonly<{icao: string}>;
type CommandStatus = 0 | 1 | 2 | 130;

async function runAirportReload(
  admitted: CliInputTypes['Admitted'],
  input: AirportReloadInput
): Promise<CommandStatus> {
  return runAdmittedCliCommand(admitted, {
    metadata: {
      id: 'reload-airport',
      attributes: {'radial.airport.icao': input.icao},
    },
    execute: runtime => reloadAirport(input, runtime),
  });
}

async function reloadAirport(
  input: AirportReloadInput,
  runtime: CliRuntimeTypes['Context']
): Promise<CommandStatus> {
  const databasePath = runtime.env['RADIAL_DATABASE_PATH'] ?? '';
  if (databasePath.trim() === '') {
    runtime.io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_DATABASE_PATH_MISSING',
        summary: 'Database path is missing.',
        cause: 'RADIAL_DATABASE_PATH is required.',
        action:
          'Set RADIAL_DATABASE_PATH to the DuckDB database file and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  const openAipApiKey = runtime.env['OPENAIP_API_KEY'] ?? '';
  if (openAipApiKey.trim() === '') {
    runtime.io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_CREDENTIALS_MISSING',
        summary: 'OpenAIP credentials are missing.',
        cause: 'OPENAIP_API_KEY is required for an explicit Airport reload.',
        action: 'Set OPENAIP_API_KEY and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  let applicationResult:
    | Readonly<{ok: true; value: CommandStatus}>
    | Readonly<{ok: false; failure: ApplicationTypes['ApplicationOpenFailure']}>;
  try {
    applicationResult = await runtime.withApplication(
      {databasePath},
      async application => {
        let result: ApplicationTypes['AirportReloadResult'];
        try {
          result = await application.dataManagement.reloadAirport({
            icao: input.icao,
            openAipApiKey,
            onProgress(progress) {
              runtime.io.writeStderr(airportReloadOutput.formatProgress(progress));
            },
            signal: runtime.signal,
          });
        } catch (error) {
          if (cliInterruption.isCancellation(error, runtime.signal)) {
            return 130;
          }

          throw error;
        }

        if (!result.ok) {
          runtime.io.writeStderr(airportReloadOutput.formatFailure(result.failure));
          return result.failure.code === 'DATA_INVALID_ICAO' ? 2 : 1;
        }

        runtime.io.writeStdout(airportReloadOutput.formatSuccess(result.value));
        return 0;
      }
    );
  } catch (error) {
    if (cliInterruption.is(error)) {
      return 130;
    }

    throw error;
  }

  if (!applicationResult.ok) {
    runtime.io.writeStderr(
      airportReloadOutput.formatFailure({
        code: 'DATA_DATABASE_UNAVAILABLE',
        summary: 'The configured database is unavailable.',
        cause: 'The configured database could not be opened.',
        action: 'Check RADIAL_DATABASE_PATH and retry the Airport reload.',
        activeDataPreserved: true,
      })
    );
    return 1;
  }

  return applicationResult.value;
}

export default runAirportReload;
