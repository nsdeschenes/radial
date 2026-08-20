import type CliCommandResultTypes from '#radial/cli/commands/CliCommandResult.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

type TelemetryAttributes = Record<string, boolean | number | string>;

type TelemetryClient = Readonly<{
  captureException(error: unknown): void;
  close(): Promise<unknown>;
  flush(timeout: number): Promise<unknown>;
  logError(message: string, attributes: TelemetryAttributes): void;
  logInfo(message: string, attributes: TelemetryAttributes): void;
  logWarn(message: string, attributes: TelemetryAttributes): void;
  recordCommand(attributes: Readonly<{command: string; outcome: string}>): void;
  recordDistribution(
    name: string,
    value: number,
    attributes?: Readonly<Record<string, string>>
  ): void;
  startSpan<Value>(
    options: Readonly<{
      attributes: Readonly<Record<string, string>>;
      name: string;
      op: string;
    }>,
    operation: () => Promise<Value>
  ): Promise<Value>;
}>;

function createCliTelemetrySession(
  client: TelemetryClient
): CliTelemetryTypes['Session'] {
  return {
    async execute(metadata, operation) {
      const commandAttributes = {
        ...metadata.attributes,
        'radial.cli.command': metadata.id,
      };
      return client.startSpan(
        {attributes: commandAttributes, name: 'radial cli', op: 'cli'},
        async () => {
          try {
            const result = await operation();
            recordResult(client, metadata.id, commandAttributes, result);
            return result;
          } catch (error) {
            client.captureException(error);
            throw error;
          }
        }
      );
    },
    recordOperation(event) {
      recordOperation(client, event);
    },
    async close() {
      try {
        await client.flush(2_000);
      } catch {
        // Telemetry shutdown is best-effort and must not replace the CLI outcome.
      }

      try {
        await client.close();
      } catch {
        // Telemetry shutdown is best-effort and must not replace the CLI outcome.
      }
    },
  };
}

function recordOperation(
  client: TelemetryClient,
  event: CliTelemetryTypes['OperationEvent']
): void {
  if (event.kind === 'data-status-failed') {
    client.logError('Data status read failed', {
      'radial.data.active_preserved': event.activeDataPreserved,
      'radial.failure.code': event.failureCode,
    });
    return;
  }

  if (event.kind === 'data-status-completed') {
    client.logInfo('Data status read completed', {
      'radial.airport.cached_count': event.cachedAirportCount,
      'radial.data.snapshot_present': event.snapshotPresent,
      'radial.data.status': event.status,
    });
    return;
  }

  client.recordDistribution('total_route_legs', event.routeLegCount);
  client.recordDistribution('total_route_distance', event.routeDistanceNm, {
    arrival_icao: event.arrivalIcao,
    departure_icao: event.departureIcao,
  });
  if (event.warningCodes.length === 0) {
    return;
  }

  const attributes: TelemetryAttributes = {
    'radial.route.arrival_icao': event.arrivalIcao,
    'radial.route.departure_icao': event.departureIcao,
    'radial.route.warning_count': event.warningCodes.length,
  };
  for (const warningCode of event.warningCodes) {
    const countAttribute = `radial.route.warning.${warningCode}.count`;
    const currentCount = attributes[countAttribute];
    attributes[countAttribute] = typeof currentCount === 'number' ? currentCount + 1 : 1;
  }

  client.logWarn(
    `Route plan ${event.departureIcao} to ${event.arrivalIcao} completed with warnings`,
    attributes
  );
}

function recordResult(
  client: TelemetryClient,
  commandId: string,
  commandAttributes: Readonly<Record<string, string>>,
  result: CliCommandResultTypes['Result']
): void {
  const outcome = result.status === 0 ? 'success' : 'failure';
  client.recordCommand({command: commandId, outcome});
  const attributes: TelemetryAttributes = {
    ...commandAttributes,
    'radial.cli.exit_code': result.status,
  };
  if (result.status === 0) {
    client.logInfo(`CLI command ${commandId} completed`, attributes);
    return;
  }

  client.logError(`CLI command ${commandId} failed`, attributes);
}

export default createCliTelemetrySession;
