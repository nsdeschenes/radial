import sharedDuckDBRuntime from '#radial/application/internal/SharedDuckDBRuntime.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import validation from '#radial/route-planner/internal/validation.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type Application = RadialApplicationTypes['Application'];
type RoutePlanner = RoutePlannerTypes['RoutePlanner'];
type SharedDuckDBRuntime = Awaited<ReturnType<typeof sharedDuckDBRuntime.acquire>>;
type NavaidDataProducerDependencies = NonNullable<Parameters<typeof reloadNavaids>[2]>;

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
  readonly #planner: RoutePlannerTypes['RoutePlanner'];
  #isDisposed = false;

  constructor(activityGate: ActivityGate, planner: RoutePlannerTypes['RoutePlanner']) {
    this.#activityGate = activityGate;
    this.#planner = planner;
  }

  async planRoute(
    request: RoutePlannerTypes['RoutePlanningRequest']
  ): Promise<RoutePlannerTypes['RoutePlanningResult']> {
    if (this.#isDisposed) {
      throw new Error('Cannot plan a route after the Route Planner has been disposed.');
    }
    return this.#activityGate.run(() => this.#planner.planRoute(request));
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
  readonly #navaidDataProducerDependencies: NavaidDataProducerDependencies;
  readonly #runtime: SharedDuckDBRuntime;
  #disposePromise: Promise<void> | undefined;

  constructor(
    runtime: SharedDuckDBRuntime,
    configuredDatabasePath: string,
    maxRouteFactor: number,
    navaidDataProducerDependencies: NavaidDataProducerDependencies
  ) {
    this.#runtime = runtime;
    this.#configuredDatabasePath = configuredDatabasePath;
    this.#maxRouteFactor = maxRouteFactor;
    this.#navaidDataProducerDependencies = navaidDataProducerDependencies;
    this.databasePath = runtime.databasePath;
    this.dataManagement = Object.freeze({
      reloadNavaids: (request: RadialApplicationTypes['NavaidReloadRequest']) =>
        this.#reloadNavaids(request),
    });
    this.planning = Object.freeze({open: () => this.#openPlanning()});
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

  async #openPlanning(): Promise<RoutePlannerTypes['PlannerOpenResult']> {
    return this.#activityGate.run(async () => {
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
          value: new ApplicationPlanner(this.#activityGate, opened.value),
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
  navaidDataProducerDependencies: NavaidDataProducerDependencies = {}
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
        navaidDataProducerDependencies
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

export default openRadialApplication;
