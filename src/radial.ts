import * as Sentry from '@sentry/node';

import runCli from '#radial/cli/main.js';

const args = process.argv.slice(2);

try {
  process.exitCode = await Sentry.startSpan({name: 'radial cli', op: 'cli'}, async () => {
    const exitCode = await runCli({
      args,
      env: process.env,
      io: {
        writeStdout(text) {
          process.stdout.write(text);
        },
        writeStderr(text) {
          process.stderr.write(text);
        },
      },
    });

    logCliResult(args, exitCode);
    return exitCode;
  });
} catch (error) {
  Sentry.captureException(error);
  throw error;
} finally {
  await Sentry.flush(2_000);
  await Sentry.close();
}

function logCliResult(args: readonly string[], exitCode: number): void {
  const attributes = cliLogAttributes(args, exitCode);
  if (attributes === undefined) {
    return;
  }

  const command = attributes['radial.cli.command'];
  Sentry.metrics.count('radial.product.cli_command', 1, {
    attributes: {
      command,
      outcome: exitCode === 0 ? 'success' : 'failure',
    },
  });
  if (exitCode === 0) {
    Sentry.logger.info(Sentry.logger.fmt`CLI command ${command} completed`, attributes);
    return;
  }

  Sentry.logger.error(Sentry.logger.fmt`CLI command ${command} failed`, attributes);
}

function cliLogAttributes(
  args: readonly string[],
  exitCode: number
): Record<string, string | number> | undefined {
  if (exitCode === 2 || args.includes('--help')) {
    return undefined;
  }

  const baseAttributes = {'radial.cli.exit_code': exitCode};

  if (args[0] !== 'data') {
    return {
      ...baseAttributes,
      'radial.cli.command': 'plan-route',
      'radial.route.arrival_icao': args[1] ?? '',
      'radial.route.departure_icao': args[0] ?? '',
    };
  }

  if (args[1] === 'status') {
    return {...baseAttributes, 'radial.cli.command': 'data-status'};
  }

  if (args[2] === 'navaids') {
    return {...baseAttributes, 'radial.cli.command': 'reload-navaids'};
  }

  if (args[2] === 'airport') {
    return {
      ...baseAttributes,
      'radial.airport.icao': args[3] ?? '',
      'radial.cli.command': 'reload-airport',
    };
  }

  return undefined;
}
