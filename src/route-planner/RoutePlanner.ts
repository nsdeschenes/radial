import {stat} from 'node:fs/promises';

import {DuckDBInstance} from '@duckdb/node-api';
import type {DuckDBConnection} from '@duckdb/node-api';

import validateContract from '#radial/route-planner/internal/duckdb/contract.js';
import PlannerRepository from '#radial/route-planner/internal/duckdb/repository.js';
import navigation from '#radial/route-planner/internal/navigation.js';
import progressiveVorFamilyDiscovery from '#radial/route-planner/internal/progressiveVorFamilyDiscovery.js';
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
type RouteSearchMode = RoutePlannerTypes['RoutePlan']['searchMode'];
type IncrementalRouteGraph = ReturnType<typeof routeSearch.createGraph>;
type SelectedNavaidRoute = ReturnType<IncrementalRouteGraph['selectOptimalRoute']>;
type NdbCandidate = Awaited<
  ReturnType<PlannerRepository['findNewNdbCandidates']>
>[number];
type VorFamilyCandidate = Awaited<
  ReturnType<PlannerRepository['findNewVorFamilyCandidates']>
>[number];
type NavaidCandidate = NdbCandidate | VorFamilyCandidate;
type ProgressiveSearchResult =
  | Readonly<{ok: true; route: SelectedNavaidRoute}>
  | Readonly<{ok: false}>;
type DatabaseQueryOperation =
  | 'validate-contract'
  | 'resolve-airports'
  | 'find-vor-family-route'
  | 'find-ndb-fallback-route';

class DuckDbRoutePlanner implements RoutePlanner {
  readonly #closeInstanceOnDispose: boolean;
  readonly #instance: DuckDBInstance;
  readonly #maxRouteFactor: number;
  readonly #repository: PlannerRepository;
  #isDisposed = false;

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

  async planRoute(request: RoutePlanningRequest): Promise<RoutePlanningResult> {
    const validatedRequest = validation.validateRoutePlanningRequest(request);
    if (!validatedRequest.ok) {
      return validatedRequest;
    }

    if (this.#isDisposed) {
      throw new Error('Cannot plan a route after the Route Planner has been disposed.');
    }

    return this.#repository.withReadTransaction(async connection => {
      const contract = await validateContract(connection);
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

      let directDistanceNm: number;
      try {
        directDistanceNm = await this.#repository.directDistanceNm(
          connection,
          departure.value,
          arrival.value
        );
      } catch {
        return databaseQueryFailed('find-vor-family-route');
      }
      const graph = routeSearch.createGraph();
      const maximumRouteDistanceNm = directDistanceNm * this.#maxRouteFactor;
      const admittedDatabaseIds: string[] = [];
      const vorFamilySearch = await this.#searchProgressively(
        connection,
        directDistanceNm,
        maximumRouteDistanceNm,
        graph,
        admittedDatabaseIds,
        (nextLimitNm, measuredDatabaseIds) =>
          this.#repository.findNewVorFamilyCandidates(
            connection,
            departure.value,
            arrival.value,
            nextLimitNm,
            measuredDatabaseIds
          )
      );
      if (!vorFamilySearch.ok) {
        return databaseQueryFailed('find-vor-family-route');
      }
      let selectedRoute = vorFamilySearch.route;
      let searchMode: RouteSearchMode = 'vor-family';

      if (selectedRoute === undefined) {
        searchMode = 'ndb-fallback';
        const ndbSearch = await this.#searchProgressively(
          connection,
          directDistanceNm,
          maximumRouteDistanceNm,
          graph,
          admittedDatabaseIds,
          (nextLimitNm, measuredDatabaseIds) =>
            this.#repository.findNewNdbCandidates(
              connection,
              departure.value,
              arrival.value,
              nextLimitNm,
              measuredDatabaseIds
            )
        );
        if (!ndbSearch.ok) {
          return databaseQueryFailed('find-ndb-fallback-route');
        }
        selectedRoute = ndbSearch.route;
      }

      if (selectedRoute === undefined) {
        return {
          ok: false,
          failure: {
            code: 'no-route',
            departureIcao: validatedRequest.value.departureIcao,
            arrivalIcao: validatedRequest.value.arrivalIcao,
            maxRouteFactor: this.#maxRouteFactor,
            completedSearchLimits: completedSearchLimits(this.#maxRouteFactor),
          },
        };
      }

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
            magneticReference: contract.magneticReference,
          },
          warnings: deriveWarnings(routeLegs, searchMode),
        },
      };
    });
  }

  async #searchProgressively<Candidate extends NavaidCandidate>(
    connection: DuckDBConnection,
    directDistanceNm: number,
    maximumRouteDistanceNm: number,
    graph: IncrementalRouteGraph,
    admittedDatabaseIds: string[],
    findNewCandidates: (
      nextLimitNm: number,
      measuredDatabaseIds: readonly string[]
    ) => Promise<readonly Candidate[]>
  ): Promise<ProgressiveSearchResult> {
    const discoverySession = progressiveVorFamilyDiscovery.createSession<Candidate>(
      directDistanceNm,
      this.#maxRouteFactor
    );
    let selectedRoute: SelectedNavaidRoute;

    for (;;) {
      const nextLimitNm = discoverySession.nextLimitNm(selectedRoute?.totalDistanceNm);
      if (nextLimitNm === undefined) {
        return {ok: true, route: selectedRoute};
      }

      let measuredCandidates: readonly Candidate[];
      try {
        measuredCandidates = await findNewCandidates(
          nextLimitNm,
          discoverySession.measuredDatabaseIds
        );
      } catch {
        return {ok: false};
      }
      const candidates = discoverySession.admitMeasuredCandidates(
        measuredCandidates,
        nextLimitNm
      );

      let navaidPairDistances: Awaited<
        ReturnType<PlannerRepository['findNewNavaidPairs']>
      >;
      try {
        navaidPairDistances = await this.#repository.findNewNavaidPairs(
          connection,
          candidates,
          admittedDatabaseIds
        );
      } catch {
        return {ok: false};
      }
      graph.admit(candidates, navaidPairDistances);
      admittedDatabaseIds.push(
        ...candidates.map(candidate => candidate.routePoint.databaseId)
      );
      selectedRoute = graph.selectOptimalRoute(maximumRouteDistanceNm);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#isDisposed) {
      return;
    }

    this.#isDisposed = true;
    if (this.#closeInstanceOnDispose) {
      this.#instance.closeSync();
    }
  }
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

    const contract = await validateContract(connection);
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

function completedSearchLimits(maxRouteFactor: number): readonly number[] {
  return progressiveVorFamilyDiscovery.scheduledFactors(maxRouteFactor);
}

function databaseUnavailable(databasePath: string) {
  return {
    ok: false,
    failure: {code: 'database-unavailable', databasePath},
  } as const;
}

export default openRoutePlanner;
