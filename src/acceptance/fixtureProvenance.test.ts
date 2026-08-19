import {join} from 'node:path';

import {expect, test} from 'vitest';

import fixtureProvenance from '#radial/acceptance/fixtureProvenance.js';

const HTTPS_URL_PATTERN = /^https:\/\//u;
const UTC_TIMESTAMP_PATTERN = /Z$/u;
const SHA256_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
    expect(record.sourceUrl).toMatch(HTTPS_URL_PATTERN);
    expect(record.retrievedAt).toMatch(UTC_TIMESTAMP_PATTERN);
    expect(record.versionOrCycle).not.toBe('');
    expect(record.licenseNote).not.toBe('');
    expect(record.extractionPolicyVersion).not.toBe('');
    expect(record.generatorVersion).not.toBe('');
    expect(record.sha256).toMatch(SHA256_CHECKSUM_PATTERN);
    expect(record.sha256).toBe(fixtureProvenance.checksumFixtureFiles(record.files));
  }
});
