import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

const MANUAL_DISPATCH_PREDICATE = /function is(?:AirportReload|DataStatus|NavaidReload)/;
const OPERATIONAL_STATIC_IMPORT =
  /^import (?!type\b).*from ['"](?:@duckdb|@sentry|#radial\/(?:application|data-producer|instrument(?:\.js)?))/mu;
const BUILD_COMMAND = /buildCommand</g;
const STRICLI_RUN = /\brun\(application,/g;
const RAW_ARGUMENT_TELEMETRY = /\b(?:args|invocation)\b/u;
const INDEX_MODULE = /(?:^|\/)index\.ts$/u;
const INDEX_IMPORT = /from ['"][^'"]*\/index\.js['"]/u;
const FORWARDING_EXPORT = /^export (?:\*|\{[^}]+\}) from /mu;
const LEGACY_LIFECYCLE = /\b(?:cliLogAttributes|createInterruptSignal|logCliResult)\b/u;
const STRICLI_RUNTIME_IMPORT = /^import (?!type\b).*from '@stricli\/core'/mu;

test('pins one Stricli parser authority with import-light eager modules', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const [
    applicationSource,
    contextSource,
    diagnosticSource,
    adapterSource,
    executableSource,
    lifecycleSource,
    runtimeSource,
  ] = await Promise.all([
    readFile('src/cli/buildCliApplication.ts', 'utf8'),
    readFile('src/cli/CliStricliContext.ts', 'utf8'),
    readFile('src/cli/formatCliCompatibilityDiagnostic.ts', 'utf8'),
    readFile('src/cli/runCli.ts', 'utf8'),
    readFile('src/cli/runCliExecutable.ts', 'utf8'),
    readFile('src/cli/runAdmittedCliCommand.ts', 'utf8'),
    readFile('src/cli/runtime/createCliRuntimeContext.ts', 'utf8'),
  ]);
  const eagerSources = [
    applicationSource,
    contextSource,
    diagnosticSource,
    adapterSource,
    executableSource,
    lifecycleSource,
    runtimeSource,
  ];

  expect(packageJson.dependencies['@stricli/core']).toBe('1.3.0');
  expect(applicationSource.match(BUILD_COMMAND)).toHaveLength(4);
  expect(adapterSource.match(STRICLI_RUN)).toHaveLength(1);
  expect(adapterSource).not.toMatch(MANUAL_DISPATCH_PREDICATE);
  expect(lifecycleSource).not.toMatch(RAW_ARGUMENT_TELEMETRY);

  for (const source of eagerSources) {
    expect(source).not.toMatch(OPERATIONAL_STATIC_IMPORT);
  }
});

test('has direct descriptive CLI modules without legacy or forwarding paths', async () => {
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

  expect(relativePaths.filter(path => INDEX_MODULE.test(path))).toEqual([]);
  expect(allSources).not.toMatch(INDEX_IMPORT);
  expect(allSources).not.toMatch(FORWARDING_EXPORT);
  expect(allSources).not.toMatch(MANUAL_DISPATCH_PREDICATE);
  expect(allSources).not.toMatch(LEGACY_LIFECYCLE);

  expect(
    modules
      .filter(module => STRICLI_RUNTIME_IMPORT.test(module.source))
      .map(module => module.path)
      .sort()
  ).toEqual(['buildCliApplication.ts', 'runCli.ts']);
});
