import {readFile} from 'node:fs/promises';

import {expect, test} from 'vitest';

const MANUAL_DISPATCH_PREDICATE = /function is(?:Airport|Data|Navaid)/;

test('pins one Stricli parser authority with import-light eager modules', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const [applicationSource, contextSource, diagnosticSource, adapterSource] =
    await Promise.all([
      readFile('src/cli/buildCliApplication.ts', 'utf8'),
      readFile('src/cli/CliStricliContext.ts', 'utf8'),
      readFile('src/cli/formatCliCompatibilityDiagnostic.ts', 'utf8'),
      readFile('src/cli/runCli.ts', 'utf8'),
    ]);
  const eagerSources = [
    applicationSource,
    contextSource,
    diagnosticSource,
    adapterSource,
  ];

  expect(packageJson.dependencies['@stricli/core']).toBe('1.3.0');
  expect(applicationSource.match(/buildCommand</g)).toHaveLength(4);
  expect(adapterSource.match(/\brun\(application,/g)).toHaveLength(1);
  expect(adapterSource).not.toMatch(MANUAL_DISPATCH_PREDICATE);

  for (const source of eagerSources) {
    expect(source).not.toContain("from '#radial/application/");
    expect(source).not.toContain("from '#radial/data-producer/");
    expect(source).not.toContain("from '#radial/instrument.js'");
    expect(source).not.toContain("from '@sentry/");
  }
});
