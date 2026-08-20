import * as Sentry from '@sentry/node';
import {nodeProfilingIntegration} from '@sentry/profiling-node';

import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';
import createCliTelemetrySession from '#radial/cli/telemetry/createCliTelemetrySession.js';

async function loadSentryCliTelemetry(
  env: Readonly<Record<string, string | undefined>>
): Promise<CliTelemetryTypes['Session']> {
  Sentry.init({
    dsn: env['SENTRY_DSN'],
    enableLogs: true,
    environment: env['SENTRY_ENVIRONMENT'],
    integrations: [nodeProfilingIntegration()],
    profileLifecycle: 'trace',
    profileSessionSampleRate: 1,
    release: env['SENTRY_RELEASE'],
    traceLifecycle: 'stream',
    tracesSampleRate: 1,
  });

  return createCliTelemetrySession({
    captureException(error) {
      Sentry.captureException(error);
    },
    close() {
      return Sentry.close();
    },
    flush(timeout) {
      return Sentry.flush(timeout);
    },
    logError(message, attributes) {
      Sentry.logger.error(message, attributes);
    },
    logInfo(message, attributes) {
      Sentry.logger.info(message, attributes);
    },
    logWarn(message, attributes) {
      Sentry.logger.warn(message, attributes);
    },
    recordCommand(attributes) {
      Sentry.metrics.count('radial.product.cli_command', 1, {attributes});
    },
    recordDistribution(name, value, attributes) {
      Sentry.metrics.distribution(name, value, {attributes});
    },
    startSpan(options, operation) {
      return Sentry.startSpan(options, operation);
    },
  });
}

export default loadSentryCliTelemetry;
