import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import refreshFixtures from '#radial/acceptance/refreshFixtures.js';

test('normalizes a network response into a deterministic review diff without writing by default', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-refresh-'));
  const outputPath = join(temporaryDirectory, 'fixture.json');
  await writeFile(outputPath, '{\n  "b": 2,\n  "a": 1\n}\n');

  try {
    const result = await refreshFixtures.refreshFixture({
      sourceUrl: 'https://example.test/fixture.json',
      outputPath,
      fetcher: async () =>
        new Response('{"a":1,"b":2}', {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    });

    expect(result.changed).toBe(true);
    expect(result.diff).toContain(`--- ${outputPath}`);
    expect(result.diff).toContain('+  "a": 1');
    expect(await readFile(outputPath, 'utf8')).toBe('{\n  "b": 2,\n  "a": 1\n}\n');
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});

test('applies a refreshed fixture only when explicitly requested', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'radial-refresh-'));
  const outputPath = join(temporaryDirectory, 'fixture.csv');

  try {
    await refreshFixtures.refreshFixture({
      sourceUrl: 'https://example.test/fixture.csv',
      outputPath,
      apply: true,
      fetcher: async () => new Response('a,b\r\n1,2', {status: 200}),
    });

    await expect(readFile(outputPath, 'utf8')).resolves.toBe('a,b\n1,2\n');
  } finally {
    await rm(temporaryDirectory, {recursive: true});
  }
});
