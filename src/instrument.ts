import * as Sentry from '@sentry/node';
import {nodeProfilingIntegration} from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env['SENTRY_DSN'],
  environment: process.env['SENTRY_ENVIRONMENT'],
  integrations: [nodeProfilingIntegration()],
  release: process.env['SENTRY_RELEASE'],

  // Logs
  enableLogs: true,

  // Trace
  traceLifecycle: 'stream',
  // tracesSampleRate: process.env['NODE_ENV'] === 'development' ? 1 : 0.1,
  tracesSampleRate: 1,

  // Profiling
  // profileSessionSampleRate: process.env['NODE_ENV'] === 'development' ? 1 : 0.1,
  profileSessionSampleRate: 1,
  profileLifecycle: 'trace',
});
