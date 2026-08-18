import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import sharedDuckDBRuntime from '#radial/application/internal/SharedDuckDBRuntime.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import ensureCachedAirport from '#radial/data-producer/internal/AirportDataProducer.js';
import ensureFirstNavaidSnapshot from '#radial/data-producer/internal/BootstrapNavaidSnapshot.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import isDuckDBBusyError from '#radial/db/duckdb/isDuckDBBusyError.js';
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
  readonly #airportResolutionCoordinator: SharedDuckDBRuntime['airportResolutionCoordinator'];
  readonly #planner: RoutePlannerTypes['RoutePlanner'];
  readonly #runtime: SharedDuckDBRuntime;
  #isDisposed = false;

  constructor(
    activityGate: ActivityGate,
    planner: RoutePlannerTypes['RoutePlanner'],
    runtime: SharedDuckDBRuntime,
    airportApiKey: string,
    airportDataProducerDependencies: AirportDataProducerDependencies,
    airportResolutionCoordinator: SharedDuckDBRuntime['airportResolutionCoordinator']
  ) {
    this.#activityGate = activityGate;
    this.#airportApiKey = airportApiKey;
    this.#airportDataProducerDependencies = airportDataProducerDependencies;
    this.#airportResolutionCoordinator = airportResolutionCoordinator;
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
      const signal = validatedRequest.value.signal;
      for (const endpoint of [
        {role: 'departure' as const, icao: validatedRequest.value.departureIcao},
        {role: 'arrival' as const, icao: validatedRequest.value.arrivalIcao},
      ]) {
        const resolved = await this.#airportResolutionCoordinator.ensure(
          await this.#runtime.instance(),
          endpoint.icao,
          this.#airportApiKey,
          this.#airportDataProducerDependencies,
          signal
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
      if (signal?.aborted) {
        throw abortableOperation.abortError(signal);
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
    try {
      return readDataStatus.fromInstance(
        await this.#runtime.instance(),
        this.databasePath
      );
    } catch (error) {
      return {
        ok: false,
        failure: databaseFailure(
          error,
          'The committed data status could not be read.',
          'Check database availability and retry.'
        ),
      };
    }
  }

  async #reloadNavaids(
    request: RadialApplicationTypes['NavaidReloadRequest']
  ): Promise<RadialApplicationTypes['NavaidReloadResult']> {
    abortableOperation.throwIfAborted(request.signal);
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
    return this.#activityGate.run(async () => {
      abortableOperation.throwIfAborted(request.signal);
      let instance: Awaited<ReturnType<SharedDuckDBRuntime['instance']>>;
      try {
        instance = await this.#runtime.instance();
      } catch (error) {
        return {
          ok: false,
          failure: databaseFailure(
            error,
            'The database could not be opened for the Navaid reload.',
            'Check RADIAL_DATABASE_PATH and retry the Navaid reload.'
          ),
        };
      }
      abortableOperation.throwIfAborted(request.signal);

      return this.#runtime.navaidOperationCoordinator.run(
        async () =>
          reloadNavaids(instance, request, {
            ...this.#navaidDataProducerDependencies,
            publicationGate: this.#runtime.publicationGate,
          }),
        request.signal,
        () =>
          request.onProgress?.({
            stage: 'database',
            message: 'Waiting for the active data operation.',
          })
      );
    });
  }

  async #reloadAirport(
    request: RadialApplicationTypes['AirportReloadRequest']
  ): Promise<RadialApplicationTypes['AirportReloadResult']> {
    abortableOperation.throwIfAborted(request.signal);
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
      abortableOperation.throwIfAborted(request.signal);
      let instance: Awaited<ReturnType<SharedDuckDBRuntime['instance']>>;
      try {
        instance = await this.#runtime.instance();
      } catch (error) {
        if (request.signal?.aborted) {
          throw abortableOperation.abortError(request.signal);
        }
        return {
          ok: false,
          failure: databaseFailure(
            error,
            'The database could not be opened for the Airport reload.',
            'Check RADIAL_DATABASE_PATH and retry the Airport reload.'
          ),
        };
      }
      abortableOperation.throwIfAborted(request.signal);

      try {
        return await this.#runtime.airportResolutionCoordinator.reload(
          instance,
          {...request, icao: validatedIcao.value},
          this.#airportDataProducerDependencies,
          request.signal
        );
      } catch (error) {
        if (request.signal?.aborted) {
          throw abortableOperation.abortError(request.signal);
        }
        return {
          ok: false,
          failure: databaseFailure(
            error,
            'The database could not be opened for the Airport reload.',
            'Check RADIAL_DATABASE_PATH and retry the Airport reload.'
          ),
        };
      }
    });
  }

  async #openPlanning(): Promise<RadialApplicationTypes['PlanningOpenResult']> {
    return this.#activityGate.run(async () => {
      let bootstrapped: BootstrapResult;
      try {
        bootstrapped = await this.#ensureFirstNavaidSnapshot();
      } catch (error) {
        if (isDuckDBBusyError(error)) {
          return {
            ok: false,
            failure: databaseFailure(
              error,
              'The database could not be opened for planning.',
              'Route the operation through the owning process or obtain exclusive maintenance access.'
            ),
          };
        }
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
            this.#airportDataProducerDependencies,
            this.#runtime.airportResolutionCoordinator
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
    return this.#runtime.navaidOperationCoordinator.run(async () =>
      ensureFirstNavaidSnapshot(await this.#runtime.instance(), this.#openAipApiKey, {
        ...this.#navaidDataProducerDependencies,
        publicationGate: this.#runtime.publicationGate,
      })
    );
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    await this.#activityGate.stopAndDrain();
    await sharedDuckDBRuntime.release(this.#runtime);
  }
}

function databaseFailure(
  error: unknown,
  unavailableCause: string,
  unavailableAction: string
): RadialApplicationTypes['DataFailure'] {
  if (isDuckDBBusyError(error)) {
    return {
      code: 'DATA_DATABASE_BUSY',
      summary: 'The configured database is busy.',
      cause: 'Another process owns the native DuckDB database file.',
      action:
        'Route the operation through the owning process or obtain exclusive maintenance access.',
      activeDataPreserved: true,
    };
  }
  return {
    code: 'DATA_DATABASE_UNAVAILABLE',
    summary: 'The configured database is unavailable.',
    cause: unavailableCause,
    action: unavailableAction,
    activeDataPreserved: true,
  };
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
