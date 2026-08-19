import {stat} from 'node:fs/promises';

import {DuckDBInstance} from '@duckdb/node-api';
import * as Sentry from '@sentry/node';

import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';
import PlannerRepository from '#radial/route-planner/internal/duckdb/repository.js';
import navigation from '#radial/route-planner/internal/navigation.js';
import routeSearch from '#radial/route-planner/internal/routeSearch.js';
import validation from '#radial/route-planner/internal/validation.js';
import deriveWarnings from '#radial/route-planner/internal/warnings.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type AirportRoutePoint = RoutePlannerTypes['AirportRoutePoint'];
type RoutePlanner = RoutePlannerTypes['RoutePlanner'];
type RoutePlannerConfig = RoutePlannerTypes['RoutePlannerConfig'];
type RoutePlanningFailure = RoutePlannerTypes['RoutePlanningFailure'];
type RoutePlanningRequest = RoutePlannerTypes['RoutePlanningRequest'];
type RoutePlanningResult = RoutePlannerTypes['RoutePlanningResult'];
type DatabaseQueryOperation =
  | 'validate-contract'
  | 'resolve-airports'
  | 'find-vor-family-route'
  | 'find-ndb-fallback-route';

class DuckDbRoutePlanner implements RoutePlanner {
  readonly #activePlanning = new Set<Promise<RoutePlanningResult>>();
  readonly #closeInstanceOnDispose: boolean;
  readonly #instance: DuckDBInstance;
  readonly #maxRouteFactor: number;
  readonly #repository: PlannerRepository;
  #lifecycleState: 'open' | 'closing' | 'disposed' = 'open';
  #disposePromise: Promise<void> | undefined;

  constructor(
    instance: DuckDBInstance,
    maxRouteFactor: number,
    repository: PlannerRepository,
    closeInstanceOnDispose: boolean
  ) {
    this.#closeInstanceOnDispose = closeInstanceOnDispose;
    this.#instance = instance;
    this.#maxRouteFactor = maxRouteFactor;
    this.#repository = repository;
  }

  planRoute(request: RoutePlanningRequest): Promise<RoutePlanningResult> {
    if (this.#lifecycleState !== 'open') {
      Sentry.logger.error('Route planning rejected by planner lifecycle', {
        'radial.planner.lifecycle_state': this.#lifecycleState,
      });
      return Promise.reject(
        new Error('Cannot plan a route while the Route Planner is closing or disposed.')
      );
    }

    const planning = this.#planRoute(request);
    this.#activePlanning.add(planning);
    void planning.then(
      () => this.#activePlanning.delete(planning),
      () => this.#activePlanning.delete(planning)
    );
    return planning;
  }

  async #planRoute(request: RoutePlanningRequest): Promise<RoutePlanningResult> {
    const validatedRequest = validation.validateRoutePlanningRequest(request);
    if (!validatedRequest.ok) {
      logRoutePlanningResult(request, validatedRequest);
      return validatedRequest;
    }

    const result = await this.#repository.withReadTransaction(async connection => {
      const contract = await Sentry.startSpan(
        {
          name: 'Validate planner database contract',
          op: 'db.query',
          attributes: {
            'db.operation.name': 'validate',
            'db.query.summary': 'planner contract',
            'db.system.name': 'duckdb',
          },
        },
        () => plannerDatabaseContract.validate(connection)
      );
      if (!contract.ok) {
        return databaseQueryFailed('validate-contract');
      }

      let airportResolution;
      try {
        airportResolution = await this.#repository.resolveAirports(
          connection,
          validatedRequest.value.departureIcao,
          validatedRequest.value.arrivalIcao
        );
      } catch {
        return databaseQueryFailed('resolve-airports');
      }

      const departure = resolveAirport(
        airportResolution.departure,
        'departure',
        validatedRequest.value.departureIcao
      );
      if (!departure.ok) {
        return departure;
      }

      const arrival = resolveAirport(
        airportResolution.arrival,
        'arrival',
        validatedRequest.value.arrivalIcao
      );
      if (!arrival.ok) {
        return arrival;
      }

      const searchResult = await routeSearch.findRoute(
        this.#repository.createRouteSearchDataSource(
          connection,
          departure.value,
          arrival.value
        ),
        this.#maxRouteFactor
      );
      if (searchResult.status === 'failed') {
        return databaseQueryFailed(
          searchResult.phase === 'vor-family'
            ? 'find-vor-family-route'
            : 'find-ndb-fallback-route'
        );
      }

      if (searchResult.status === 'exhausted') {
        return {
          ok: false,
          failure: {
            code: 'no-route',
            departureIcao: validatedRequest.value.departureIcao,
            arrivalIcao: validatedRequest.value.arrivalIcao,
            maxRouteFactor: this.#maxRouteFactor,
            completedSearchLimits: searchResult.completedSearchFactors,
          },
        } satisfies RoutePlanningResult;
      }

      const {route: selectedRoute, searchMode} = searchResult;
      const routePoints = [departure.value, ...selectedRoute.navaids, arrival.value];
      const routeLegs = selectedRoute.legDistancesNm.map((distanceNm, index) => {
        const legDeparture = routePoints[index];
        const legArrival = routePoints[index + 1];
        if (legDeparture === undefined || legArrival === undefined) {
          throw new Error('Selected Route Plan continuity invariant failed.');
        }

        return navigation.createRouteLeg(legDeparture, legArrival, distanceNm);
      });

      return {
        ok: true,
        value: {
          plan: {
            totalDistanceNm: selectedRoute.totalDistanceNm,
            searchMode,
            routePoints,
            routeLegs,
            magneticReference: contract.metadata,
          },
          warnings: deriveWarnings(routeLegs, searchMode),
        },
      } satisfies RoutePlanningResult;
    });
    logRoutePlanningResult(validatedRequest.value, result);
    return result;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#lifecycleState = 'closing';
    await Promise.allSettled(this.#activePlanning);
    try {
      if (this.#closeInstanceOnDispose) {
        this.#instance.closeSync();
      }
    } finally {
      this.#lifecycleState = 'disposed';
    }
  }
}

function logRoutePlanningResult(
  request: RoutePlanningRequest,
  result: RoutePlanningResult
): void {
  const routeAttributes: Record<string, string | number | boolean> = {
    'radial.route.arrival_icao': request.arrivalIcao,
    'radial.route.departure_icao': request.departureIcao,
  };

  if (result.ok) {
    Sentry.metrics.count('radial.product.route_plan', 1, {
      attributes: {
        has_warnings: result.value.warnings.length > 0,
        outcome: 'success',
        search_mode: result.value.plan.searchMode,
      },
    });
    if (result.value.warnings.length > 0) {
      return;
    }

    Sentry.logger.info(
      Sentry.logger
        .fmt`Route plan ${request.departureIcao} to ${request.arrivalIcao} completed`,
      {
        ...routeAttributes,
        'radial.route.distance_nm': result.value.plan.totalDistanceNm,
        'radial.route.leg_count': result.value.plan.routeLegs.length,
        'radial.route.search_mode': result.value.plan.searchMode,
        'radial.route.warning_count': result.value.warnings.length,
      }
    );
    return;
  }

  const attributes = {
    ...routeAttributes,
    'radial.failure.code': result.failure.code,
  };
  Sentry.metrics.count('radial.product.route_plan', 1, {
    attributes: {
      failure_code: result.failure.code,
      outcome: 'failure',
    },
  });
  const message = Sentry.logger
    .fmt`Route plan ${request.departureIcao} to ${request.arrivalIcao} failed`;
  if (
    result.failure.code === 'database-query-failed' ||
    result.failure.code === 'airport-resolution-failed' ||
    result.failure.code === 'airport-cache-corrupt'
  ) {
    Sentry.logger.error(message, attributes);
    return;
  }

  Sentry.logger.warn(message, attributes);
}

async function openRoutePlanner(
  config: RoutePlannerConfig,
  sharedInstance?: () => Promise<DuckDBInstance>
): Promise<RoutePlannerTypes['PlannerOpenResult']> {
  const validatedConfig = validation.validatePlannerConfig(config);
  if (!validatedConfig.ok) {
    return validatedConfig;
  }

  if (validatedConfig.value.databasePath !== ':memory:') {
    try {
      const databaseFile = await stat(validatedConfig.value.databasePath);
      if (!databaseFile.isFile()) {
        return databaseUnavailable(validatedConfig.value.databasePath);
      }
    } catch {
      return databaseUnavailable(validatedConfig.value.databasePath);
    }
  }

  let instance: DuckDBInstance;
  try {
    instance =
      sharedInstance === undefined
        ? await DuckDBInstance.create(validatedConfig.value.databasePath)
        : await sharedInstance();
  } catch {
    return databaseUnavailable(validatedConfig.value.databasePath);
  }

  let connection: Awaited<ReturnType<DuckDBInstance['connect']>> | undefined;
  let keepInstanceOpen = false;
  try {
    connection = await instance.connect();
    await connection.run('LOAD spatial');
    await connection.run('SET geometry_always_xy = true');
    const spatialProbe = await connection.runAndReadAll(`
      SELECT
        (SELECT loaded FROM duckdb_extensions()
          WHERE extension_name = 'spatial') AS loaded,
        ST_Distance_Sphere(ST_Point(0, 0), ST_Point(0, 1)) AS distance_metres
    `);
    const probe = spatialProbe.getRowObjectsJS()[0];
    if (
      probe?.['loaded'] !== true ||
      typeof probe['distance_metres'] !== 'number' ||
      !Number.isFinite(probe['distance_metres']) ||
      probe['distance_metres'] <= 0
    ) {
      throw new Error('DuckDB Spatial validation failed.');
    }

    const contract = await plannerDatabaseContract.validate(connection);
    if (!contract.ok) {
      return {
        ok: false,
        failure: {code: 'database-contract-invalid', violations: contract.violations},
      };
    }

    const repository = new PlannerRepository(instance);
    keepInstanceOpen = true;
    return {
      ok: true,
      value: new DuckDbRoutePlanner(
        instance,
        validatedConfig.value.maxRouteFactor,
        repository,
        sharedInstance === undefined
      ),
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: 'database-contract-invalid',
        violations: [
          error instanceof Error ? error.message : 'Database validation failed',
        ],
      },
    };
  } finally {
    connection?.closeSync();
    if (!keepInstanceOpen && sharedInstance === undefined) {
      instance.closeSync();
    }
  }
}

function resolveAirport(
  matches: readonly AirportRoutePoint[],
  role: 'departure' | 'arrival',
  normalizedIcao: string
): {ok: true; value: AirportRoutePoint} | {ok: false; failure: RoutePlanningFailure} {
  if (matches.length === 0) {
    return {ok: false, failure: {code: 'airport-not-found', role, normalizedIcao}};
  }

  if (matches.length > 1) {
    return {ok: false, failure: {code: 'airport-ambiguous', role, normalizedIcao}};
  }

  const airport = matches[0];
  if (airport === undefined) {
    throw new Error('Airport resolution invariant failed.');
  }

  return {ok: true, value: airport};
}

function databaseQueryFailed(operation: DatabaseQueryOperation): RoutePlanningResult {
  return {ok: false, failure: {code: 'database-query-failed', operation}};
}

function databaseUnavailable(databasePath: string) {
  return {
    ok: false,
    failure: {code: 'database-unavailable', databasePath},
  } as const;
}

export default openRoutePlanner;
