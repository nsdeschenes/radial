import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import diagnostics from '#radial/cli/formatDiagnostics.js';
import formatRoutePlan from '#radial/cli/formatRoutePlan.js';
import formatRoutePlanningWarnings from '#radial/cli/formatRoutePlanningWarnings.js';
import formatRoutePlanningWarningSummary from '#radial/cli/formatRoutePlanningWarningSummary.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';

type PlanRouteInput = Readonly<{
  request: ApplicationTypes['RoutePlanningRequest'];
  warningDetailsRequested: boolean;
}>;

type PlanRouteSuccess = CliCommandResultTypes['Result'] &
  Readonly<{
    kind: 'success';
    request: ApplicationTypes['RoutePlanningRequest'];
    success: ApplicationTypes['RoutePlanningSuccess'];
  }>;

type PlanRouteResult =
  | PlanRouteSuccess
  | Readonly<{kind: 'expected-failure'; status: 1 | 2}>
  | Readonly<{kind: 'interrupted'; status: 130}>;

async function runPlanRoute(
  input: PlanRouteInput,
  runtime: CliRuntimeTypes['Context']
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
              ...input.request,
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
            input.warningDetailsRequested
              ? formatRoutePlanningWarnings(result.value)
              : formatRoutePlanningWarningSummary(result.value)
          );
          return {
            kind: 'success',
            status: 0,
            request: input.request,
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

  return applicationResult.value;
}

export default runPlanRoute;
