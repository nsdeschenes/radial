import {join} from 'node:path';

import {expect, test} from 'vitest';

import fixtureProvenance from '#radial/acceptance/fixtureProvenance.js';

test('verifies complete provenance and checksums for every committed source fixture', async () => {
  const manifest = await fixtureProvenance.verifyFixtureProvenance(
    join(process.cwd(), 'fixtures/provenance.json')
  );

  expect(manifest.version).toBe(1);
  expect(manifest.records.map(record => record.fixtureId)).toEqual([
    'openaip-api-contract',
    'wmm2025-test-vectors',
    'faa-nasr-2607-nav-base',
  ]);

  for (const record of manifest.records) {
    expect(record.sourceIdentity).not.toBe('');
    expect(record.sourceUrl).toMatch(/^https:\/\//u);
    expect(record.retrievedAt).toMatch(/Z$/u);
    expect(record.versionOrCycle).not.toBe('');
    expect(record.licenseNote).not.toBe('');
    expect(record.extractionPolicyVersion).not.toBe('');
    expect(record.generatorVersion).not.toBe('');
    expect(record.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(record.sha256).toBe(fixtureProvenance.checksumFixtureFiles(record.files));
  }
});
