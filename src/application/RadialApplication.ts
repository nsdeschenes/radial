import sharedDuckDBRuntime from '#radial/application/internal/SharedDuckDBRuntime.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import ensureCachedAirport from '#radial/data-producer/internal/AirportDataProducer.js';
import ensureFirstNavaidSnapshot from '#radial/data-producer/internal/BootstrapNavaidSnapshot.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import validation from '#radial/route-planner/internal/validation.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type Application = RadialApplicationTypes['Application'];
type RoutePlanner = RoutePlannerTypes['RoutePlanner'];
type SharedDuckDBRuntime = Awaited<ReturnType<typeof sharedDuckDBRuntime.acquire>>;
type NavaidDataProducerDependencies = NonNullable<Parameters<typeof reloadNavaids>[2]>;
type AirportDataProducerDependencies = NonNullable<
  Parameters<typeof ensureCachedAirport>[3]
>;
type AirportResolutionFailure = Extract<
  Awaited<ReturnType<typeof ensureCachedAirport>>,
  {ok: false}
>['failure'];
type ApplicationDependencies = NavaidDataProducerDependencies &
  AirportDataProducerDependencies &
  Readonly<{
    openAipApiKey?: string;
  }>;
type BootstrapResult = Awaited<ReturnType<typeof ensureFirstNavaidSnapshot>>;

const firstBootstrapByRuntime = new WeakMap<
  SharedDuckDBRuntime,
  Promise<BootstrapResult>
>();

class ActivityGate {
  #activeOperationCount = 0;
  #isAcceptingWork = true;
  #resolveDrain: (() => void) | undefined;

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (!this.#isAcceptingWork) {
      throw new Error(
        'Cannot start work after the Radial application has been disposed.'
      );
    }

    this.#activeOperationCount += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperationCount -= 1;
      if (this.#activeOperationCount === 0) {
        this.#resolveDrain?.();
      }
    }
  }

  async stopAndDrain(): Promise<void> {
    this.#isAcceptingWork = false;
    if (this.#activeOperationCount === 0) {
      return;
    }

    await new Promise<void>(resolve => {
      this.#resolveDrain = resolve;
    });
  }
}

class ApplicationPlanner implements RoutePlanner {
  readonly #activityGate: ActivityGate;
  readonly #airportApiKey: string;
  readonly #airportDataProducerDependencies: AirportDataProducerDependencies;
  readonly #planner: RoutePlannerTypes['RoutePlanner'];
  readonly #runtime: SharedDuckDBRuntime;
  #isDisposed = false;

  constructor(
    activityGate: ActivityGate,
    planner: RoutePlannerTypes['RoutePlanner'],
    runtime: SharedDuckDBRuntime,
    airportApiKey: string,
    airportDataProducerDependencies: AirportDataProducerDependencies
  ) {
    this.#activityGate = activityGate;
    this.#airportApiKey = airportApiKey;
    this.#airportDataProducerDependencies = airportDataProducerDependencies;
    this.#planner = planner;
    this.#runtime = runtime;
  }

  async planRoute(
    request: RoutePlannerTypes['RoutePlanningRequest']
  ): Promise<RoutePlannerTypes['RoutePlanningResult']> {
    if (this.#isDisposed) {
      throw new Error('Cannot plan a route after the Route Planner has been disposed.');
    }
    const validatedRequest = validation.validateRoutePlanningRequest(request);
    if (!validatedRequest.ok) {
      return validatedRequest;
    }
    return this.#activityGate.run(async () => {
      for (const endpoint of [
        {role: 'departure' as const, icao: validatedRequest.value.departureIcao},
        {role: 'arrival' as const, icao: validatedRequest.value.arrivalIcao},
      ]) {
        const resolved = await ensureCachedAirport(
          await this.#runtime.instance(),
          endpoint.icao,
          this.#airportApiKey,
          this.#airportDataProducerDependencies
        );
        if (!resolved.ok) {
          return {
            ok: false,
            failure: mapAirportResolutionFailure(
              endpoint.role,
              endpoint.icao,
              resolved.failure
            ),
          };
        }
      }
      return this.#planner.planRoute(validatedRequest.value);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;
    await this.#planner[Symbol.asyncDispose]();
  }
}

class RadialApplication implements Application {
  readonly databasePath: string;
  readonly dataManagement: RadialApplicationTypes['DataManagementCapability'];
  readonly planning: RadialApplicationTypes['PlanningCapability'];
  readonly #activityGate = new ActivityGate();
  readonly #configuredDatabasePath: string;
  readonly #maxRouteFactor: number;
  readonly #openAipApiKey: string;
  readonly #navaidDataProducerDependencies: NavaidDataProducerDependencies;
  readonly #airportDataProducerDependencies: AirportDataProducerDependencies;
  readonly #runtime: SharedDuckDBRuntime;
  #disposePromise: Promise<void> | undefined;

  constructor(
    runtime: SharedDuckDBRuntime,
    configuredDatabasePath: string,
    maxRouteFactor: number,
    openAipApiKey: string,
    dependencies: ApplicationDependencies
  ) {
    this.#runtime = runtime;
    this.#configuredDatabasePath = configuredDatabasePath;
    this.#maxRouteFactor = maxRouteFactor;
    this.#openAipApiKey = openAipApiKey;
    this.#navaidDataProducerDependencies = dependencies;
    this.#airportDataProducerDependencies = dependencies;
    this.databasePath = runtime.databasePath;
    this.dataManagement = Object.freeze({
      status: () => this.#readDataStatus(),
      reloadNavaids: (request: RadialApplicationTypes['NavaidReloadRequest']) =>
        this.#reloadNavaids(request),
      reloadAirport: (request: RadialApplicationTypes['AirportReloadRequest']) =>
        this.#reloadAirport(request),
    });
    this.planning = Object.freeze({open: () => this.#openPlanning()});
  }

  async #readDataStatus(): Promise<RadialApplicationTypes['DataStatusResult']> {
    return readDataStatus.fromInstance(await this.#runtime.instance(), this.databasePath);
  }

  async #reloadNavaids(
    request: RadialApplicationTypes['NavaidReloadRequest']
  ): Promise<RadialApplicationTypes['NavaidReloadResult']> {
    if (request.openAipApiKey.trim() === '') {
      return {
        ok: false,
        failure: {
          code: 'DATA_CREDENTIALS_MISSING',
          summary: 'OpenAIP credentials are missing.',
          cause: 'OPENAIP_API_KEY is required for an explicit Navaid reload.',
          action: 'Set OPENAIP_API_KEY and retry the Navaid reload.',
          activeDataPreserved: true,
        },
      };
    }
    return this.#activityGate.run(async () =>
      reloadNavaids(
        await this.#runtime.instance(),
        request,
        this.#navaidDataProducerDependencies
      )
    );
  }

  async #reloadAirport(
    request: RadialApplicationTypes['AirportReloadRequest']
  ): Promise<RadialApplicationTypes['AirportReloadResult']> {
    const validatedIcao = validation.validateAirportIcao(request.icao);
    if (!validatedIcao.ok) {
      return {
        ok: false,
        failure: {
          code: 'DATA_INVALID_ICAO',
          summary: 'The Airport ICAO is invalid.',
          cause: `The requested Airport ICAO ${JSON.stringify(request.icao)} is not four ASCII letters.`,
          action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
          activeDataPreserved: true,
        },
      };
    }
    if (request.openAipApiKey.trim() === '') {
      return {
        ok: false,
        failure: {
          code: 'DATA_CREDENTIALS_MISSING',
          summary: 'OpenAIP credentials are missing.',
          cause: 'OPENAIP_API_KEY is required for an explicit Airport reload.',
          action: 'Set OPENAIP_API_KEY and retry the Airport reload.',
          activeDataPreserved: true,
        },
      };
    }

    return this.#activityGate.run(async () => {
      try {
        return await ensureCachedAirport.reloadAirport(
          await this.#runtime.instance(),
          {...request, icao: validatedIcao.value},
          this.#airportDataProducerDependencies
        );
      } catch {
        return {
          ok: false,
          failure: {
            code: 'DATA_DATABASE_UNAVAILABLE',
            summary: 'The configured database is unavailable.',
            cause: 'The database could not be opened for the Airport reload.',
            action: 'Check RADIAL_DATABASE_PATH and retry the Airport reload.',
            activeDataPreserved: true,
          },
        };
      }
    });
  }

  async #openPlanning(): Promise<RadialApplicationTypes['PlanningOpenResult']> {
    return this.#activityGate.run(async () => {
      let bootstrapped: BootstrapResult;
      try {
        bootstrapped = await this.#ensureFirstNavaidSnapshot();
      } catch {
        return {
          ok: false,
          failure: {
            code: 'database-unavailable',
            databasePath: this.#configuredDatabasePath,
          },
        };
      }
      if (!bootstrapped.ok) {
        return bootstrapped;
      }

      const opened = await openRoutePlanner(
        {
          databasePath: this.databasePath,
          maxRouteFactor: this.#maxRouteFactor,
        },
        () => this.#runtime.instance()
      );
      if (opened.ok) {
        return {
          ok: true,
          value: new ApplicationPlanner(
            this.#activityGate,
            opened.value,
            this.#runtime,
            this.#openAipApiKey,
            this.#airportDataProducerDependencies
          ),
        };
      }
      return opened.failure.code === 'database-unavailable'
        ? {
            ok: false,
            failure: {
              ...opened.failure,
              databasePath: this.#configuredDatabasePath,
            },
          }
        : opened;
    });
  }

  async #ensureFirstNavaidSnapshot(): Promise<BootstrapResult> {
    let bootstrap = firstBootstrapByRuntime.get(this.#runtime);
    if (bootstrap === undefined) {
      bootstrap = (async () =>
        ensureFirstNavaidSnapshot(
          await this.#runtime.instance(),
          this.#openAipApiKey,
          this.#navaidDataProducerDependencies
        ))();
      firstBootstrapByRuntime.set(this.#runtime, bootstrap);
    }

    try {
      const result = await bootstrap;
      if (!result.ok) {
        firstBootstrapByRuntime.delete(this.#runtime);
      }
      return result;
    } catch (error) {
      firstBootstrapByRuntime.delete(this.#runtime);
      throw error;
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    await this.#activityGate.stopAndDrain();
    sharedDuckDBRuntime.release(this.#runtime);
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
    const runtime = await sharedDuckDBRuntime.acquire(validatedConfig.value.databasePath);
    return {
      ok: true,
      value: new RadialApplication(
        runtime,
        validatedConfig.value.databasePath,
        validatedConfig.value.maxRouteFactor,
        config.openAipApiKey ?? dependencies.openAipApiKey ?? '',
        dependencies
      ),
    };
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

function mapAirportResolutionFailure(
  role: 'departure' | 'arrival',
  normalizedIcao: string,
  failure: AirportResolutionFailure
): RoutePlannerTypes['RoutePlanningFailure'] {
  switch (failure.reason) {
    case 'not-found':
      return {code: 'airport-not-found', role, normalizedIcao};
    case 'ambiguous':
      return {code: 'airport-ambiguous', role, normalizedIcao};
    case 'cache-corrupt':
      return {code: 'airport-cache-corrupt', role, normalizedIcao};
    case 'database-query':
      return {code: 'database-query-failed', operation: 'resolve-airports'};
    case 'credentials-missing':
    case 'mismatched':
    case 'publication-failed':
    case 'source-invalid':
    case 'source-unavailable':
    case 'unusable':
      return {
        code: 'airport-resolution-failed',
        role,
        normalizedIcao,
        reason: failure.reason,
      };
  }
}

export default openRadialApplication;
