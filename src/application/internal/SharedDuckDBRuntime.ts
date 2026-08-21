import {realpath, stat} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';
import * as Sentry from '@sentry/node';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import AirportResolutionCoordinator from '#radial/application/internal/AirportResolutionCoordinator.js';
import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import ensureCachedAirport from '#radial/data-producer/internal/AirportDataProducer.js';
import ensureFirstNavaidSnapshot from '#radial/data-producer/internal/BootstrapNavaidSnapshot.js';
import readDataStatus from '#radial/data-producer/internal/DataStatus.js';
import reloadNavaids from '#radial/data-producer/internal/NavaidDataProducer.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
import isDuckDBBusyError from '#radial/db/duckdb/isDuckDBBusyError.js';
import validation from '#radial/route-planner/internal/validation.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type AirportDataProducerDependencies = NonNullable<
  Parameters<typeof ensureCachedAirport>[4]
>;
type NavaidDataProducerDependencies = NonNullable<Parameters<typeof reloadNavaids>[3]>;
type ApplicationDependencies = AirportDataProducerDependencies &
  NavaidDataProducerDependencies &
  Readonly<{openAipApiKey?: string}>;
type AirportResolutionFailure = Extract<
  Awaited<ReturnType<typeof ensureCachedAirport>>,
  {ok: false}
>['failure'];
type BootstrapResult = Awaited<ReturnType<typeof ensureFirstNavaidSnapshot>>;
type RoutePlanner = RoutePlannerTypes['RoutePlanner'];
type RuntimeConfig = Readonly<{
  configuredDatabasePath: string;
  maxRouteFactor: number;
  openAipApiKey: string;
}>;
type SharedRuntimeEntry = {
  referenceCount: number;
  runtime: SharedDuckDBRuntime;
  closing: Promise<void> | undefined;
};

const runtimes = new Map<string, SharedRuntimeEntry>();

class ActivityGate {
  #activeOperationCount = 0;
  #isAcceptingWork = true;
  #resolveDrain: (() => void) | undefined;

  run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (!this.#isAcceptingWork) {
      return Promise.reject(
        new Error('Cannot start work after the Radial application has been disposed.')
      );
    }

    this.#activeOperationCount += 1;
    return operation().finally(() => {
      this.#activeOperationCount -= 1;
      if (this.#activeOperationCount === 0) {
        this.#resolveDrain?.();
      }
    });
  }

  stop(): void {
    this.#isAcceptingWork = false;
  }

  async whenIdle(): Promise<void> {
    if (this.#activeOperationCount === 0) {
      return;
    }

    await new Promise<void>(resolve => {
      this.#resolveDrain = resolve;
    });
  }
}

class ApplicationPlanner implements RoutePlanner {
  readonly #plan: (
    request: RoutePlannerTypes['RoutePlanningRequest']
  ) => Promise<RoutePlannerTypes['RoutePlanningResult']>;
  readonly #planner: RoutePlanner;
  readonly #removeFromLease: () => void;
  #disposePromise: Promise<void> | undefined;
  #isDisposed = false;

  constructor(
    planner: RoutePlanner,
    plan: (
      request: RoutePlannerTypes['RoutePlanningRequest']
    ) => Promise<RoutePlannerTypes['RoutePlanningResult']>,
    removeFromLease: () => void
  ) {
    this.#plan = plan;
    this.#planner = planner;
    this.#removeFromLease = removeFromLease;
  }

  planRoute(
    request: RoutePlannerTypes['RoutePlanningRequest']
  ): Promise<RoutePlannerTypes['RoutePlanningResult']> {
    if (this.#isDisposed) {
      return Promise.reject(
        new Error('Cannot plan a route after the Route Planner has been disposed.')
      );
    }

    const validatedRequest = validation.validateRoutePlanningRequest(request);
    return Sentry.startSpan(
      {
        name: 'Plan route',
        op: 'task',
        attributes: {
          'radial.route.arrival_icao': request.arrivalIcao,
          'radial.route.departure_icao': request.departureIcao,
        },
      },
      () =>
        validatedRequest.ok
          ? this.#plan(validatedRequest.value)
          : Promise.resolve(validatedRequest)
    );
  }

  stop(): void {
    this.#isDisposed = true;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.stop();
    try {
      await this.#planner[Symbol.asyncDispose]();
    } finally {
      this.#removeFromLease();
    }
  }
}

class SharedDuckDBRuntime {
  readonly databasePath: string;
  readonly #airportResolutionCoordinator: AirportResolutionCoordinator;
  readonly #navaidOperationCoordinator = new FifoOperationCoordinator();
  readonly #ownershipTransitionCoordinator = new FifoOperationCoordinator();
  readonly #publicationGate = new PublicationGate(new FifoOperationCoordinator());
  #instance: DuckDBInstance | undefined;
  #instancePromise: Promise<DuckDBInstance> | undefined;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.#airportResolutionCoordinator = new AirportResolutionCoordinator(
      this.#publicationGate
    );
  }

  async readDataStatus(): Promise<RadialApplicationTypes['DataStatusResult']> {
    if (this.#instance !== undefined) {
      return readDataStatus.fromInstance(this.#instance, this.databasePath);
    }

    return this.#ownershipTransitionCoordinator.run(() =>
      this.#instance === undefined
        ? this.#readDataStatusWithoutPersistentInstance()
        : readDataStatus.fromInstance(this.#instance, this.databasePath)
    );
  }

  async reloadNavaids(
    request: RadialApplicationTypes['NavaidReloadRequest'],
    dependencies: NavaidDataProducerDependencies
  ): Promise<RadialApplicationTypes['NavaidReloadResult']> {
    const instance = await this.#getInstance();
    return this.#navaidOperationCoordinator.run(
      () => reloadNavaids(instance, request, this.#publicationGate, dependencies),
      request.signal,
      () =>
        request.onProgress?.({
          stage: 'database',
          message: 'Waiting for the active data operation.',
        })
    );
  }

  async reloadAirport(
    request: RadialApplicationTypes['AirportReloadRequest'],
    dependencies: AirportDataProducerDependencies
  ): Promise<RadialApplicationTypes['AirportReloadResult']> {
    return this.#airportResolutionCoordinator.reload(
      await this.#getInstance(),
      request,
      dependencies,
      request.signal
    );
  }

  ensureFirstNavaidSnapshot(
    openAipApiKey: string,
    dependencies: NavaidDataProducerDependencies
  ): Promise<BootstrapResult> {
    return this.#navaidOperationCoordinator.run(async () =>
      ensureFirstNavaidSnapshot(
        await this.#getInstance(),
        openAipApiKey,
        this.#publicationGate,
        dependencies
      )
    );
  }

  async ensureAirport(
    leaseToken: symbol,
    normalizedIcao: string,
    openAipApiKey: string,
    dependencies: AirportDataProducerDependencies,
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<typeof ensureCachedAirport>>> {
    return this.#airportResolutionCoordinator.ensure(
      leaseToken,
      await this.#getInstance(),
      normalizedIcao,
      openAipApiKey,
      dependencies,
      signal
    );
  }

  openRoutePlanner(
    maxRouteFactor: number
  ): Promise<RoutePlannerTypes['PlannerOpenResult']> {
    return openRoutePlanner({databasePath: this.databasePath, maxRouteFactor}, () =>
      this.#getInstance()
    );
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await Promise.all([
        this.#airportResolutionCoordinator.whenIdle(),
        this.#navaidOperationCoordinator.whenIdle(),
        this.#ownershipTransitionCoordinator.whenIdle(),
        this.#publicationGate.whenIdle(),
      ]);
    } catch (error) {
      failures.push(error);
    }

    for (const close of [
      () => this.#airportResolutionCoordinator.close(),
      () => this.#publicationGate.close(),
      () => this.#navaidOperationCoordinator.close(),
      () => this.#ownershipTransitionCoordinator.close(),
      () => this.#instance?.closeSync(),
    ]) {
      try {
        close();
      } catch (error) {
        failures.push(error);
      }
    }

    this.#instance = undefined;
    this.#instancePromise = undefined;
    throwDisposalFailures(failures);
  }

  async #getInstance(): Promise<DuckDBInstance> {
    this.#instancePromise ??= this.#ownershipTransitionCoordinator.run(() =>
      this.#createInstance()
    );
    return this.#instancePromise;
  }

  async #readDataStatusWithoutPersistentInstance(): Promise<
    RadialApplicationTypes['DataStatusResult']
  > {
    if (this.databasePath === ':memory:') {
      return uninitializedDataStatus(this.databasePath);
    }

    let databaseExists: boolean;
    try {
      databaseExists = (await stat(this.databasePath)).isFile();
    } catch (error) {
      if (isMissingPathError(error)) {
        return uninitializedDataStatus(this.databasePath);
      }

      return dataStatusFailure(
        'DATA_DATABASE_UNAVAILABLE',
        'The configured database is unavailable.',
        'The configured database path could not be inspected.',
        'Check RADIAL_DATABASE_PATH and retry.'
      );
    }

    if (!databaseExists) {
      return dataStatusFailure(
        'DATA_DATABASE_UNAVAILABLE',
        'The configured database is unavailable.',
        'The configured database path is not a regular file.',
        'Set RADIAL_DATABASE_PATH to a DuckDB database file and retry.'
      );
    }

    let instance: DuckDBInstance;
    try {
      instance = await DuckDBInstance.create(this.databasePath, {
        access_mode: 'READ_ONLY',
      });
    } catch (error) {
      return isDuckDBBusyError(error)
        ? dataStatusFailure(
            'DATA_DATABASE_BUSY',
            'The configured database is busy.',
            'Another process owns the native DuckDB database file.',
            'Route the operation through the owning process or obtain exclusive maintenance access.'
          )
        : dataStatusFailure(
            'DATA_DATABASE_UNAVAILABLE',
            'The configured database is unavailable.',
            'The existing database could not be opened for read-only inspection.',
            'Check database availability and retry.'
          );
    }

    try {
      return await readDataStatus.fromInstance(instance, this.databasePath);
    } finally {
      instance.closeSync();
    }
  }

  async #createInstance(): Promise<DuckDBInstance> {
    try {
      const instance = await DuckDBInstance.create(this.databasePath);
      this.#instance = instance;
      return instance;
    } catch (error) {
      this.#instancePromise = undefined;
      throw error;
    }
  }
}

class DuckDBRuntimeLease {
  readonly databasePath: string;
  readonly #activityGate = new ActivityGate();
  readonly #airportDataProducerDependencies: AirportDataProducerDependencies;
  readonly #configuredDatabasePath: string;
  readonly #leaseToken = Symbol('DuckDB runtime lease');
  readonly #maxRouteFactor: number;
  readonly #navaidDataProducerDependencies: NavaidDataProducerDependencies;
  readonly #openAipApiKey: string;
  readonly #planners = new Set<ApplicationPlanner>();
  readonly #runtime: SharedDuckDBRuntime;
  #disposePromise: Promise<void> | undefined;

  constructor(
    runtime: SharedDuckDBRuntime,
    config: RuntimeConfig,
    dependencies: ApplicationDependencies
  ) {
    this.#runtime = runtime;
    this.#configuredDatabasePath = config.configuredDatabasePath;
    this.#maxRouteFactor = config.maxRouteFactor;
    this.#openAipApiKey = config.openAipApiKey;
    this.#airportDataProducerDependencies = dependencies;
    this.#navaidDataProducerDependencies = dependencies;
    this.databasePath = runtime.databasePath;
  }

  status(): Promise<RadialApplicationTypes['DataStatusResult']> {
    return this.#activityGate.run(async () => {
      try {
        return await this.#runtime.readDataStatus();
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
    });
  }

  reloadNavaids(
    request: RadialApplicationTypes['NavaidReloadRequest']
  ): Promise<RadialApplicationTypes['NavaidReloadResult']> {
    abortableOperation.throwIfAborted(request.signal);
    if (request.openAipApiKey.trim() === '') {
      return Promise.resolve({
        ok: false,
        failure: {
          code: 'DATA_CREDENTIALS_MISSING',
          summary: 'OpenAIP credentials are missing.',
          cause: 'OPENAIP_API_KEY is required for an explicit Navaid reload.',
          action: 'Set OPENAIP_API_KEY and retry the Navaid reload.',
          activeDataPreserved: true,
        },
      });
    }

    return this.#activityGate.run(async () => {
      abortableOperation.throwIfAborted(request.signal);
      try {
        return await this.#runtime.reloadNavaids(
          request,
          this.#navaidDataProducerDependencies
        );
      } catch (error) {
        if (request.signal?.aborted) {
          throw abortableOperation.abortError(request.signal);
        }

        return {
          ok: false,
          failure: databaseFailure(
            error,
            'The database could not be opened for the Navaid reload.',
            'Check RADIAL_DATABASE_PATH and retry the Navaid reload.'
          ),
        };
      }
    });
  }

  reloadAirport(
    request: RadialApplicationTypes['AirportReloadRequest']
  ): Promise<RadialApplicationTypes['AirportReloadResult']> {
    abortableOperation.throwIfAborted(request.signal);
    const validatedIcao = validation.validateAirportIcao(request.icao);
    if (!validatedIcao.ok) {
      return Promise.resolve({
        ok: false,
        failure: {
          code: 'DATA_INVALID_ICAO',
          summary: 'The Airport ICAO is invalid.',
          cause: `The requested Airport ICAO ${JSON.stringify(request.icao)} is not four ASCII letters.`,
          action: 'Provide exactly one four-letter ICAO and retry the Airport reload.',
          activeDataPreserved: true,
        },
      });
    }

    if (request.openAipApiKey.trim() === '') {
      return Promise.resolve({
        ok: false,
        failure: {
          code: 'DATA_CREDENTIALS_MISSING',
          summary: 'OpenAIP credentials are missing.',
          cause: 'OPENAIP_API_KEY is required for an explicit Airport reload.',
          action: 'Set OPENAIP_API_KEY and retry the Airport reload.',
          activeDataPreserved: true,
        },
      });
    }

    return this.#activityGate.run(async () => {
      abortableOperation.throwIfAborted(request.signal);
      try {
        return await this.#runtime.reloadAirport(
          {...request, icao: validatedIcao.value},
          this.#airportDataProducerDependencies
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

  openPlanning(): Promise<RadialApplicationTypes['PlanningOpenResult']> {
    return this.#activityGate.run(async () => {
      let bootstrapped: BootstrapResult;
      try {
        bootstrapped = await this.#runtime.ensureFirstNavaidSnapshot(
          this.#openAipApiKey,
          this.#navaidDataProducerDependencies
        );
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

      const opened = await this.#runtime.openRoutePlanner(this.#maxRouteFactor);
      if (!opened.ok) {
        return opened.failure.code === 'database-unavailable'
          ? {
              ok: false,
              failure: {
                ...opened.failure,
                databasePath: this.#configuredDatabasePath,
              },
            }
          : opened;
      }

      let planner: ApplicationPlanner;
      planner = new ApplicationPlanner(
        opened.value,
        request => this.#planRoute(opened.value, request),
        () => this.#planners.delete(planner)
      );
      this.#planners.add(planner);
      return {ok: true, value: planner};
    });
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #planRoute(
    planner: RoutePlanner,
    request: RoutePlannerTypes['RoutePlanningRequest']
  ): Promise<RoutePlannerTypes['RoutePlanningResult']> {
    return this.#activityGate.run(async () => {
      const signal = request.signal;
      for (const endpoint of [
        {role: 'departure' as const, icao: request.departureIcao},
        {role: 'arrival' as const, icao: request.arrivalIcao},
      ]) {
        const resolved = await this.#runtime.ensureAirport(
          this.#leaseToken,
          endpoint.icao,
          this.#openAipApiKey,
          this.#airportDataProducerDependencies,
          signal
        );
        if (!resolved.ok) {
          Sentry.logger.error(
            Sentry.logger.fmt`Airport ${endpoint.icao} resolution failed`,
            {
              'radial.airport.icao': endpoint.icao,
              'radial.airport.role': endpoint.role,
              'radial.failure.reason': resolved.failure.reason,
            }
          );
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

      abortableOperation.throwIfAborted(signal);
      return planner.planRoute(request);
    });
  }

  async #dispose(): Promise<void> {
    const failures: unknown[] = [];
    this.#activityGate.stop();
    for (const planner of this.#planners) {
      planner.stop();
    }

    try {
      await this.#activityGate.whenIdle();
    } catch (error) {
      failures.push(error);
    }

    const planners = [...this.#planners];
    for (const planner of planners) {
      planner.stop();
    }

    const plannerDisposals = await Promise.allSettled(
      planners.map(planner => planner[Symbol.asyncDispose]())
    );
    for (const result of plannerDisposals) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }

    try {
      await releaseSharedDuckDBRuntime(this.#runtime);
    } catch (error) {
      failures.push(error);
    }

    throwDisposalFailures(failures);
  }
}

async function acquireSharedDuckDBRuntime(
  config: RuntimeConfig,
  dependencies: ApplicationDependencies = {}
): Promise<DuckDBRuntimeLease> {
  const databasePath = await canonicalizeDatabasePath(config.configuredDatabasePath);
  const current = runtimes.get(databasePath);
  if (current !== undefined) {
    if (current.closing !== undefined) {
      try {
        await current.closing;
      } catch {
        // The disposing lease reports close failures; a later acquisition gets a new core.
      }

      return acquireSharedDuckDBRuntime(config, dependencies);
    }

    current.referenceCount += 1;
    return new DuckDBRuntimeLease(current.runtime, config, dependencies);
  }

  const runtime = new SharedDuckDBRuntime(databasePath);
  runtimes.set(databasePath, {referenceCount: 1, runtime, closing: undefined});
  return new DuckDBRuntimeLease(runtime, config, dependencies);
}

async function releaseSharedDuckDBRuntime(runtime: SharedDuckDBRuntime): Promise<void> {
  const current = runtimes.get(runtime.databasePath);
  if (current === undefined || current.runtime !== runtime) {
    throw new Error('Shared DuckDB runtime ownership invariant failed.');
  }

  current.referenceCount -= 1;
  if (current.referenceCount === 0) {
    current.closing = (async () => {
      try {
        await runtime.close();
      } finally {
        if (runtimes.get(runtime.databasePath)?.runtime === runtime) {
          runtimes.delete(runtime.databasePath);
        }
      }
    })();
  }

  await current.closing;
}

async function canonicalizeDatabasePath(databasePath: string): Promise<string> {
  if (databasePath === ':memory:') {
    return databasePath;
  }

  const absolutePath = resolve(databasePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }

    const parentPath = dirname(absolutePath);
    if (parentPath === absolutePath) {
      throw error;
    }

    return join(await canonicalizeDatabasePath(parentPath), basename(absolutePath));
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

function uninitializedDataStatus(
  databasePath: string
): RadialApplicationTypes['DataStatusResult'] {
  return {
    ok: true,
    value: {
      databasePath,
      status: 'uninitialized',
      legacyObjects: [],
      producerSchema: null,
      snapshot: null,
      cachedAirports: [],
    },
  };
}

function dataStatusFailure(
  code: RadialApplicationTypes['DataFailure']['code'],
  summary: string,
  cause: string,
  action: string
): RadialApplicationTypes['DataStatusResult'] {
  return {
    ok: false,
    failure: {code, summary, cause, action, activeDataPreserved: true},
  };
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

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function throwDisposalFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }

  if (failures.length > 1) {
    throw new AggregateError(failures, 'DuckDB runtime disposal failed.');
  }
}

export default {acquire: acquireSharedDuckDBRuntime};
