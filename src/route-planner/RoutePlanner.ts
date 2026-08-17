import {stat} from 'node:fs/promises';

import {DuckDBInstance} from '@duckdb/node-api';

import validation from '#radial/route-planner/internal/validation.js';
import type {
  PlannerOpenFailure,
  Result,
  RoutePlanner,
  RoutePlannerConfig,
  RoutePlanningFailure,
  RoutePlanningRequest,
  RoutePlanningSuccess,
} from '#radial/route-planner/types.js';

class DuckDbRoutePlanner implements RoutePlanner {
  readonly #instance: DuckDBInstance;
  #isDisposed = false;

  constructor(instance: DuckDBInstance) {
    this.#instance = instance;
  }

  async planRoute(
    request: RoutePlanningRequest
  ): Promise<Result<RoutePlanningSuccess, RoutePlanningFailure>> {
    const validatedRequest = validation.validateRoutePlanningRequest(request);
    if (!validatedRequest.ok) {
      return validatedRequest;
    }

    if (this.#isDisposed) {
      throw new Error('Cannot plan a route after the Route Planner has been disposed.');
    }

    const connection = await this.#instance.connect();
    try {
      await connection.run('SELECT 1 FROM planner_airports LIMIT 0');
    } catch {
      return {
        ok: false,
        failure: {code: 'database-query-failed', operation: 'resolve-airports'},
      };
    } finally {
      connection.closeSync();
    }

    throw new Error(
      'Route search is not available until the planner-ready adapter is installed.'
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#isDisposed) {
      return;
    }

    this.#isDisposed = true;
    this.#instance.closeSync();
  }
}

async function openRoutePlanner(
  config: RoutePlannerConfig
): Promise<Result<RoutePlanner, PlannerOpenFailure>> {
  const validatedConfig = validation.validatePlannerConfig(config);
  if (!validatedConfig.ok) {
    return validatedConfig;
  }

  try {
    if (validatedConfig.value.databasePath !== ':memory:') {
      const databaseFile = await stat(validatedConfig.value.databasePath);
      if (!databaseFile.isFile()) {
        return databaseUnavailable(validatedConfig.value.databasePath);
      }
    }

    const instance = await DuckDBInstance.create(validatedConfig.value.databasePath);
    return {ok: true, value: new DuckDbRoutePlanner(instance)};
  } catch {
    return databaseUnavailable(validatedConfig.value.databasePath);
  }
}

function databaseUnavailable(databasePath: string) {
  return {
    ok: false,
    failure: {code: 'database-unavailable', databasePath},
  } as const;
}

export default openRoutePlanner;
