import {access, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, expectTypeOf, test} from 'vitest';

import type runCli from '#radial/cli/runCli.js';
import type CliTelemetryTypes from '#radial/cli/telemetry/CliTelemetry.js';

const MANUAL_DISPATCH_PREDICATE = /function is(?:AirportReload|DataStatus|NavaidReload)/;
const OPERATIONAL_STATIC_IMPORT =
  /^import (?!type\b).*from ['"](?:@duckdb|@sentry|#radial\/(?:application|data-producer|instrument(?:\.js)?))/mu;
const BUILD_COMMAND = /buildCommand</g;
const BUILD_ROUTE_MAP = /buildRouteMap\(/g;
const BUILD_CLI_APPLICATION = /function buildCliApplication\(/g;
const STRICLI_RUN = /\brun\(cliApplication\.application,/g;
const RAW_INVOCATION_ADMISSION =
  /\bparseRoutePlanInvocation\b|\bthis\.invocation\b|\binvocation:\s*input\.args\b/u;
const PRE_ADMISSION_ARGUMENT_TRANSFORMATION =
  /\binput\.args\.(?:filter|flatMap|map|reduce|slice)\b|\badaptStricliToken\b/u;
const DISPATCH_CAPABLE_RETRY =
  /\b(?:hasTerminalWarnings|includeOperationalFlags|initialApplication|operationalFlagApplication)\b/u;
const MANUAL_ROUTE_HIERARCHY =
  /\brouteToken\(|const\s+(?:data|reload|root)\s*=\s*buildRouteMap\(/u;
const RAW_ARGUMENT_TELEMETRY = /\b(?:args|invocation)\b/u;
const INDEX_MODULE = /(?:^|\/)index\.ts$/u;
const INDEX_IMPORT = /from ['"][^'"]*\/index\.js['"]/u;
const FORWARDING_EXPORT = /^export (?:\*|\{[^}]+\}) from /mu;
const LEGACY_LIFECYCLE = /\b(?:cliLogAttributes|createInterruptSignal|logCliResult)\b/u;
const STRICLI_RUNTIME_IMPORT = /^import(?! type\b)(?:.|\n)*?from '@stricli\/core'/mu;
const OBSOLETE_MODULES = [
  'src/cli/CliStricliContext.ts',
  'src/cli/formatCliCompatibilityDiagnostic.ts',
] as const;

type ExpectedCommandMetadata =
  | Readonly<{
      id: 'plan-route';
      attributes: Readonly<{
        'radial.route.arrival_icao': string;
        'radial.route.departure_icao': string;
      }>;
    }>
  | Readonly<{id: 'data-status'}>
  | Readonly<{id: 'reload-navaids'}>
  | Readonly<{
      id: 'reload-airport';
      attributes: Readonly<{'radial.airport.icao': string}>;
    }>;
type CliCommandTypes = NonNullable<(typeof runCli)['commandTypes']>;

test('pins one private Stricli parser authority with import-light eager modules', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const [
    adapterSource,
    builderSource,
    dataStatusSource,
    executableSource,
    lifecycleSource,
    navaidReloadSource,
    routePlanSource,
    runtimeSource,
  ] = await Promise.all([
    readFile('src/cli/runCli.ts', 'utf8'),
    readFile('src/cli/buildCliApplication.ts', 'utf8'),
    readFile('src/cli/commands/runDataStatus.ts', 'utf8'),
    readFile('src/cli/runCliExecutable.ts', 'utf8'),
    readFile('src/cli/runAdmittedCliCommand.ts', 'utf8'),
    readFile('src/cli/commands/runReloadNavaids.ts', 'utf8'),
    readFile('src/cli/commands/runPlanRoute.ts', 'utf8'),
    readFile('src/cli/runtime/createCliRuntimeContext.ts', 'utf8'),
  ]);
  const eagerSources = [
    adapterSource,
    builderSource,
    dataStatusSource,
    executableSource,
    lifecycleSource,
    navaidReloadSource,
    routePlanSource,
    runtimeSource,
  ];

  expect(packageJson.dependencies['@stricli/core']).toBe('1.3.0');
  expect(builderSource.match(BUILD_COMMAND)).toHaveLength(1);
  expect(builderSource.match(BUILD_ROUTE_MAP)).toHaveLength(1);
  expect(builderSource.match(BUILD_CLI_APPLICATION)).toHaveLength(1);
  expect(adapterSource.match(STRICLI_RUN)).toHaveLength(1);
  expect(builderSource).not.toMatch(MANUAL_DISPATCH_PREDICATE);
  expect(builderSource).not.toMatch(MANUAL_ROUTE_HIERARCHY);
  expect(builderSource).not.toMatch(RAW_INVOCATION_ADMISSION);
  expect(builderSource).not.toMatch(PRE_ADMISSION_ARGUMENT_TRANSFORMATION);
  expect(builderSource).not.toMatch(DISPATCH_CAPABLE_RETRY);
  expect(builderSource).toContain(
    'buildCatalogRouteMap(commandDescriptions, commandFor)'
  );
  expect(adapterSource).toContain(
    'await run(cliApplication.application, input.args, context)'
  );
  expect(builderSource).toContain('inferEmpty: true');
  expect(builderSource).toContain('parse: parseTerminalWarnings');
  expect(builderSource).not.toContain("aliases: ['h']");
  expect(lifecycleSource).not.toMatch(RAW_ARGUMENT_TELEMETRY);
  expect(dataStatusSource).toContain(
    "await import('#radial/data-producer/internal/DataStatus.js')"
  );

  for (const source of eagerSources) {
    expect(source).not.toMatch(OPERATIONAL_STATIC_IMPORT);
  }
});

test('keeps catalog-derived identities and admitted metadata exact', () => {
  expectTypeOf<CliCommandTypes['id']>().toEqualTypeOf<
    'plan-route' | 'data-status' | 'reload-navaids' | 'reload-airport'
  >();
  expectTypeOf<
    CliTelemetryTypes['CommandMetadata']
  >().toEqualTypeOf<ExpectedCommandMetadata>();
});

test('has one private generated builder without obsolete or forwarding paths', async () => {
  const relativePaths = (await readdir('src/cli', {recursive: true})).filter(
    path => path.endsWith('.ts') && !path.endsWith('.test.ts')
  );
  const modules = await Promise.all(
    relativePaths.map(async path => ({
      path,
      source: await readFile(join('src/cli', path), 'utf8'),
    }))
  );
  const allSources = modules.map(module => module.source).join('\n');

  await Promise.all(
    OBSOLETE_MODULES.map(async path => {
      await expect(access(path)).rejects.toThrow();
    })
  );
  expect(relativePaths.filter(path => INDEX_MODULE.test(path))).toEqual([]);
  expect(allSources).not.toMatch(INDEX_IMPORT);
  expect(allSources).not.toMatch(FORWARDING_EXPORT);
  expect(allSources).not.toMatch(MANUAL_DISPATCH_PREDICATE);
  expect(allSources).not.toMatch(LEGACY_LIFECYCLE);

  expect(
    modules
      .filter(module => STRICLI_RUNTIME_IMPORT.test(module.source))
      .map(module => module.path)
  ).toEqual(['buildCliApplication.ts', 'runCli.ts']);
});
