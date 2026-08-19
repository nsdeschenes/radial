import * as Sentry from '@sentry/node';

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
      status: async () => {
        const result = await Sentry.startSpan(
          {name: 'Read data status', op: 'task'},
          () => runtime.status()
        );
        logDataStatusResult(result);
        return result;
      },
      reloadNavaids: async (request: RadialApplicationTypes['NavaidReloadRequest']) => {
        const result = await Sentry.startSpan(
          {name: 'Reload Navaid data', op: 'task'},
          () => runtime.reloadNavaids(request)
        );
        logNavaidReloadResult(result);
        return result;
      },
      reloadAirport: async (request: RadialApplicationTypes['AirportReloadRequest']) => {
        const result = await Sentry.startSpan(
          {
            name: 'Reload Airport data',
            op: 'task',
            attributes: {'radial.airport.icao': request.icao.trim().toUpperCase()},
          },
          () => runtime.reloadAirport(request)
        );
        logAirportReloadResult(request.icao, result);
        return result;
      },
    });
    this.planning = Object.freeze({
      open: async () => {
        const result = await Sentry.startSpan(
          {name: 'Open route planner', op: 'task'},
          () => runtime.openPlanning()
        );
        logPlannerOpenResult(result);
        return result;
      },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#runtime[Symbol.asyncDispose]();
    Sentry.logger.info('Radial application closed');
  }
}

async function openRadialApplication(
  config: RadialApplicationTypes['ApplicationConfig'],
  dependencies: ApplicationDependencies = {}
): Promise<RadialApplicationTypes['ApplicationOpenResult']> {
  const validatedConfig = validation.validatePlannerConfig(config);
  if (!validatedConfig.ok) {
    Sentry.logger.warn('Radial application configuration rejected', {
      'radial.failure.code': validatedConfig.failure.code,
      'radial.failure.field': validatedConfig.failure.field,
      'radial.failure.reason': validatedConfig.failure.reason,
    });
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
    Sentry.logger.info('Radial application opened', {
      'radial.database.kind':
        validatedConfig.value.databasePath === ':memory:' ? 'memory' : 'file',
      'radial.route.max_factor': validatedConfig.value.maxRouteFactor,
    });
    return {ok: true, value: new RadialApplication(runtime)};
  } catch {
    Sentry.logger.error('Radial application failed to open', {
      'radial.database.kind':
        validatedConfig.value.databasePath === ':memory:' ? 'memory' : 'file',
      'radial.failure.code': 'database-unavailable',
    });
    return {
      ok: false,
      failure: {
        code: 'database-unavailable',
        databasePath: validatedConfig.value.databasePath,
      },
    };
  }
}

function logDataStatusResult(result: RadialApplicationTypes['DataStatusResult']): void {
  recordDataOperation('status', result);
  if (!result.ok) {
    logDataFailure('Data status read failed', result.failure);
    return;
  }

  Sentry.logger.info('Data status read completed', {
    'radial.airport.cached_count': result.value.cachedAirports.length,
    'radial.data.snapshot_present': result.value.snapshot !== null,
    'radial.data.status': result.value.status,
  });
  Sentry.metrics.gauge(
    'radial.product.cached_airports',
    result.value.cachedAirports.length
  );
  Sentry.metrics.gauge(
    'radial.product.data_ready',
    result.value.status === 'ready' ? 1 : 0
  );
}

function logNavaidReloadResult(
  result: RadialApplicationTypes['NavaidReloadResult']
): void {
  recordDataOperation('reload-navaids', result);
  if (!result.ok) {
    logDataFailure('Navaid reload failed', result.failure);
    return;
  }

  Sentry.logger.info('Navaid reload completed', {
    'radial.navaid.exclusion_count': result.value.exclusionCount,
    'radial.navaid.planner_count': result.value.plannerNavaidCount,
    'radial.navaid.raw_count': result.value.rawNavaidCount,
    'radial.navaid.snapshot_id': result.value.snapshotId,
  });
}

function logAirportReloadResult(
  requestedIcao: string,
  result: RadialApplicationTypes['AirportReloadResult']
): void {
  recordDataOperation('reload-airport', result);
  if (!result.ok) {
    logDataFailure('Airport reload failed', result.failure, {
      'radial.airport.icao': requestedIcao.trim().toUpperCase(),
    });
    return;
  }

  Sentry.logger.info(Sentry.logger.fmt`Airport ${result.value.icao} reload completed`, {
    'radial.airport.icao': result.value.icao,
    'radial.airport.reload_status': result.value.status,
  });
}

function logPlannerOpenResult(
  result: RadialApplicationTypes['PlanningOpenResult']
): void {
  Sentry.metrics.count('radial.product.data_operation', 1, {
    attributes: {
      operation: 'open-planner',
      outcome: result.ok ? 'success' : 'failure',
      ...(result.ok ? {} : {failure_code: result.failure.code}),
    },
  });
  if (result.ok) {
    Sentry.logger.info('Route planner opened');
    return;
  }

  const attributes = {'radial.failure.code': result.failure.code};
  if (result.failure.code === 'invalid-configuration') {
    Sentry.logger.warn('Route planner failed to open', attributes);
    return;
  }

  Sentry.logger.error('Route planner failed to open', attributes);
}

function recordDataOperation(
  operation: 'reload-airport' | 'reload-navaids' | 'status',
  result:
    | RadialApplicationTypes['AirportReloadResult']
    | RadialApplicationTypes['DataStatusResult']
    | RadialApplicationTypes['NavaidReloadResult']
): void {
  Sentry.metrics.count('radial.product.data_operation', 1, {
    attributes: {
      operation,
      outcome: result.ok ? 'success' : 'failure',
      ...(result.ok ? {} : {failure_code: result.failure.code}),
    },
  });
}

function logDataFailure(
  message: string,
  failure: RadialApplicationTypes['DataFailure'],
  attributes: Record<string, string | number | boolean> = {}
): void {
  Sentry.logger.error(message, {
    ...attributes,
    'radial.data.active_preserved': failure.activeDataPreserved,
    'radial.failure.code': failure.code,
  });
}

export default openRadialApplication;
