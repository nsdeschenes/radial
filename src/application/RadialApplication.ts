import sharedDuckDBRuntime from '#radial/application/internal/SharedDuckDBRuntime.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import validation from '#radial/route-planner/internal/validation.js';

type Application = RadialApplicationTypes['Application'];
type ApplicationDependencies = NonNullable<
  Parameters<typeof sharedDuckDBRuntime.acquire>[1]
>;
type DuckDBRuntimeLease = Awaited<ReturnType<typeof sharedDuckDBRuntime.acquire>>;

class RadialApplication implements Application {
  readonly databasePath: string;
  readonly dataManagement: RadialApplicationTypes['DataManagementCapability'];
  readonly planning: RadialApplicationTypes['PlanningCapability'];
  readonly #runtime: DuckDBRuntimeLease;

  constructor(runtime: DuckDBRuntimeLease) {
    this.#runtime = runtime;
    this.databasePath = runtime.databasePath;
    this.dataManagement = Object.freeze({
      status: () => runtime.status(),
      reloadNavaids: (request: RadialApplicationTypes['NavaidReloadRequest']) =>
        runtime.reloadNavaids(request),
      reloadAirport: (request: RadialApplicationTypes['AirportReloadRequest']) =>
        runtime.reloadAirport(request),
    });
    this.planning = Object.freeze({open: () => runtime.openPlanning()});
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#runtime[Symbol.asyncDispose]();
  }
}

async function openRadialApplication(
  config: RadialApplicationTypes['ApplicationConfig'],
  dependencies: ApplicationDependencies = {}
): Promise<RadialApplicationTypes['ApplicationOpenResult']> {
  const validatedConfig = validation.validatePlannerConfig(config);
  if (!validatedConfig.ok) {
    return validatedConfig;
  }

  try {
    const runtime = await sharedDuckDBRuntime.acquire(
      {
        configuredDatabasePath: validatedConfig.value.databasePath,
        maxRouteFactor: validatedConfig.value.maxRouteFactor,
        openAipApiKey: config.openAipApiKey ?? dependencies.openAipApiKey ?? '',
      },
      dependencies
    );
    return {ok: true, value: new RadialApplication(runtime)};
  } catch {
    return {
      ok: false,
      failure: {
        code: 'database-unavailable',
        databasePath: validatedConfig.value.databasePath,
      },
    };
  }
}

export default openRadialApplication;
