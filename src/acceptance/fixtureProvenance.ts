import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

import {z} from 'zod';

import parseJsonWithUniqueKeys from '#radial/data-producer/internal/JsonWithUniqueKeys.js';

const checksum = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const fixtureFile = z
  .object({
    path: z.string().trim().min(1),
    sha256: checksum,
  })
  .strict();
const fixtureRecord = z
  .object({
    fixtureId: z.string().trim().min(1),
    sourceIdentity: z.string().trim().min(1),
    sourceUrl: z
      .url()
      .refine(value => value.startsWith('https://'), 'Source URL must use HTTPS.'),
    retrievedAt: z.iso.datetime(),
    versionOrCycle: z.string().trim().min(1),
    licenseNote: z.string().trim().min(1),
    sha256: checksum,
    extractionPolicyVersion: z.string().trim().min(1),
    generatorVersion: z.string().trim().min(1),
    files: z.array(fixtureFile).min(1),
  })
  .strict();
const fixtureManifest = z
  .object({
    version: z.literal(1),
    records: z.array(fixtureRecord).min(1),
  })
  .strict();

type FixtureFile = z.infer<typeof fixtureFile>;
type FixtureManifest = z.infer<typeof fixtureManifest>;

async function readFixtureProvenance(manifestPath: string): Promise<FixtureManifest> {
  const contents = await readFile(manifestPath, 'utf8');
  return fixtureManifest.parse(parseJsonWithUniqueKeys(contents));
}

async function verifyFixtureProvenance(
  manifestPath: string,
  repositoryRoot = process.cwd()
): Promise<FixtureManifest> {
  const manifest = await readFixtureProvenance(manifestPath);
  const fixtureIds = new Set<string>();
  const fixturePaths = new Set<string>();

  for (const record of manifest.records) {
    if (fixtureIds.has(record.fixtureId)) {
      throw new Error(`Fixture provenance duplicates ${record.fixtureId}.`);
    }

    fixtureIds.add(record.fixtureId);

    const files = await Promise.all(
      record.files.map(async file => {
        if (fixturePaths.has(file.path)) {
          throw new Error(`Fixture provenance lists ${file.path} more than once.`);
        }

        fixturePaths.add(file.path);
        const path = safeFixturePath(repositoryRoot, file.path);
        const contents = await readFile(path);
        const actualChecksum = checksumBytes(contents);
        if (actualChecksum !== file.sha256) {
          throw new Error(
            `Fixture ${file.path} checksum mismatch: expected ${file.sha256}, received ${actualChecksum}.`
          );
        }

        return file;
      })
    );

    const actualRecordChecksum = checksumFixtureFiles(files);
    if (actualRecordChecksum !== record.sha256) {
      throw new Error(
        `Fixture record ${record.fixtureId} checksum mismatch: expected ${record.sha256}, received ${actualRecordChecksum}.`
      );
    }
  }

  return manifest;
}

function safeFixturePath(repositoryRoot: string, fixturePath: string): string {
  if (isAbsolute(fixturePath)) {
    throw new Error(`Fixture path ${fixturePath} must be relative.`);
  }

  const root = resolve(repositoryRoot);
  const path = resolve(root, fixturePath);
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../')) {
    throw new Error(`Fixture path ${fixturePath} escapes the repository root.`);
  }

  return path;
}

function checksumBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function checksumFixtureFiles(files: readonly FixtureFile[]): string {
  const content = files
    .toSorted((left, right) => compareStrings(left.path, right.path))
    .map(file => `${file.path}\n${file.sha256}\n`)
    .join('');
  return checksumBytes(Buffer.from(content, 'utf8'));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export default {
  checksumBytes,
  checksumFixtureFiles,
  readFixtureProvenance,
  verifyFixtureProvenance,
};
