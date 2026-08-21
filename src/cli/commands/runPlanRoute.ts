import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import formatRoutePlan from '#radial/cli/formatRoutePlan.js';
import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import formatRoutePlanningWarningSummary from '#radial/cli/formatRoutePlanningWarningSummary.js';
import runAdmittedCliCommand from '#radial/cli/runAdmittedCliCommand.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type PlanRouteInput = Readonly<{
  arrivalIcao: string;
  departureIcao: string;
  warningDetailsRequested: boolean;
}>;

type PlanRouteSuccess = Readonly<{
  kind: 'success';
  request: ApplicationTypes['RoutePlanningRequest'];
  status: 0;
  success: ApplicationTypes['RoutePlanningSuccess'];
}>;

type PlanRouteResult =
  | PlanRouteSuccess
  | Readonly<{kind: 'expected-failure'; status: 1 | 2}>
  | Readonly<{kind: 'interrupted'; status: 130}>;

async function runPlanRoute(
  capabilities: CliInputTypes['Admitted'],
  input: PlanRouteInput
): Promise<0 | 1 | 2 | 130> {
  const request: ApplicationTypes['RoutePlanningRequest'] = {
    arrivalIcao: input.arrivalIcao,
    departureIcao: input.departureIcao,
  };
  return runAdmittedCliCommand(capabilities, {
    metadata: {
      id: 'plan-route',
      attributes: {
        'radial.route.arrival_icao': input.arrivalIcao,
        'radial.route.departure_icao': input.departureIcao,
      },
    },
    async execute(runtime, telemetry) {
      const result = await executePlanRoute(
        request,
        input.warningDetailsRequested,
        runtime,
        telemetry
      );
      return result.status;
    },
  });
}

async function executePlanRoute(
  request: ApplicationTypes['RoutePlanningRequest'],
  warningDetailsRequested: boolean,
  runtime: CliRuntimeTypes['Context'],
  telemetry: CliTelemetryTypes['Session']
): Promise<PlanRouteResult> {
  const configuredFactor = runtime.env['RADIAL_MAX_ROUTE_FACTOR'];
  let applicationResult:
    | Readonly<{ok: true; value: PlanRouteResult}>
    | Readonly<{
        ok: false;
        failure: ApplicationTypes['ApplicationOpenFailure'];
      }>;
  try {
    applicationResult = await runtime.withApplication(
      {
        databasePath: runtime.env['RADIAL_DATABASE_PATH'] ?? '',
        ...(configuredFactor === undefined
          ? {}
          : {maxRouteFactor: Number(configuredFactor)}),
        openAipApiKey: runtime.env['OPENAIP_API_KEY'] ?? '',
      },
      async application => {
        const openedPlanner = await application.planning.open();
        if (!openedPlanner.ok) {
          runtime.io.writeStderr(
            diagnostics.formatPlannerOpenDiagnostic(openedPlanner.failure)
          );
          return {kind: 'expected-failure', status: 1};
        }

        try {
          let result: ApplicationTypes['RoutePlanningResult'];
          try {
            result = await openedPlanner.value.planRoute({
              ...request,
              signal: runtime.signal,
            });
          } catch (error) {
            if (cliInterruption.isCancellation(error, runtime.signal)) {
              return {kind: 'interrupted', status: 130};
            }

            throw error;
          }

          if (!result.ok) {
            runtime.io.writeStderr(
              diagnostics.formatRoutePlanningDiagnostic(result.failure)
            );
            return {
              kind: 'expected-failure',
              status: result.failure.code === 'invalid-request' ? 2 : 1,
            };
          }

          runtime.io.writeStdout(formatRoutePlan(result.value.plan));
          runtime.io.writeStderr(
            warningDetailsRequested
              ? formatRoutePlanningWarnings(result.value)
              : formatRoutePlanningWarningSummary(result.value)
          );
          return {
            kind: 'success',
            status: 0,
            request,
            success: result.value,
          };
        } finally {
          await openedPlanner.value[Symbol.asyncDispose]();
        }
      }
    );
  } catch (error) {
    if (cliInterruption.is(error)) {
      return {kind: 'interrupted', status: 130};
    }

    throw error;
  }

  if (!applicationResult.ok) {
    runtime.io.writeStderr(
      diagnostics.formatPlannerOpenDiagnostic(applicationResult.failure)
    );
    return {kind: 'expected-failure', status: 1};
  }

  if (applicationResult.value.kind === 'success') {
    telemetry.recordOperation({
      kind: 'route-plan-completed',
      arrivalIcao: applicationResult.value.request.arrivalIcao,
      departureIcao: applicationResult.value.request.departureIcao,
      routeDistanceNm: applicationResult.value.success.plan.totalDistanceNm,
      routeLegCount: applicationResult.value.success.plan.routeLegs.length,
      warningCodes: applicationResult.value.success.warnings.map(warning => warning.code),
    });
  }

  return applicationResult.value;
}

export default runPlanRoute;
