import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import parseJsonWithUniqueKeys from '#radial/data-producer/internal/JsonWithUniqueKeys.js';

const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;

type RefreshFixtureRequest = Readonly<{
  sourceUrl: string;
  outputPath: string;
  apply?: boolean;
  fetcher?: typeof fetch;
  headers?: RequestInit['headers'];
}>;

type RefreshFixtureResult = Readonly<{
  outputPath: string;
  sourceUrl: string;
  changed: boolean;
  checksum: string;
  diff: string;
}>;

async function refreshFixture(
  request: RefreshFixtureRequest
): Promise<RefreshFixtureResult> {
  const sourceUrl = new URL(request.sourceUrl);
  if (sourceUrl.protocol !== 'https:') {
    throw new Error('Fixture refresh sources must use HTTPS.');
  }

  if (sourceUrl.username !== '' || sourceUrl.password !== '') {
    throw new Error('Fixture refresh URLs must not contain credentials.');
  }

  const response = await (request.fetcher ?? fetch)(sourceUrl, {
    redirect: 'manual',
    ...(request.headers === undefined ? {} : {headers: request.headers}),
  });
  if (!response.ok) {
    throw new Error(`Fixture refresh source returned HTTP ${response.status}.`);
  }

  const responseBytes = new Uint8Array(await response.arrayBuffer());
  if (responseBytes.byteLength > MAX_FIXTURE_BYTES) {
    throw new Error('Fixture refresh response exceeded 64 MiB.');
  }

  const refreshedContents = formatFixtureContents(
    new TextDecoder('utf-8', {fatal: true}).decode(responseBytes),
    request.outputPath,
    response.headers.get('content-type')
  );
  const outputPath = resolve(request.outputPath);
  const existingContents = await readExistingContents(outputPath);
  const changed = existingContents !== refreshedContents;
  if (request.apply && changed) {
    await writeFile(outputPath, refreshedContents, 'utf8');
  }

  return {
    outputPath,
    sourceUrl: sourceUrl.toString(),
    changed,
    checksum: checksumText(refreshedContents),
    diff: createFixtureDiff(request.outputPath, existingContents, refreshedContents),
  };
}

function formatFixtureContents(
  contents: string,
  outputPath: string,
  contentType: string | null
): string {
  const isJson = outputPath.endsWith('.json') || contentType?.includes('json') === true;
  if (isJson) {
    const parsed = parseJsonWithUniqueKeys(contents);
    return `${JSON.stringify(sortJsonKeys(parsed), undefined, 2)}\n`;
  }

  const normalized = contents.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized === '' || normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sortJsonKeys(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, nested]) => [key, sortJsonKeys(nested)])
    );
  }

  return value;
}

async function readExistingContents(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return '';
    }

    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function createFixtureDiff(
  outputPath: string,
  existingContents: string,
  refreshedContents: string
): string {
  if (existingContents === refreshedContents) {
    return `No changes for ${outputPath}.\n`;
  }

  const before = diffLines(existingContents);
  const after = diffLines(refreshedContents);
  return [
    `--- ${outputPath}`,
    `+++ ${outputPath} (refreshed)`,
    '@@',
    ...before.map(line => `-${line}`),
    ...after.map(line => `+${line}`),
    '',
  ].join('\n');
}

function diffLines(contents: string): string[] {
  const lines = contents === '' ? [] : contents.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checksumText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

type ParsedArguments = Readonly<{
  sourceUrl: string;
  outputPath: string;
  apply: boolean;
}>;

function parseArguments(args: readonly string[]): ParsedArguments | 'help' | undefined {
  const normalizedArguments = args[0] === '--' ? args.slice(1) : args;
  let networkAcknowledged = false;
  let sourceUrl: string | undefined;
  let outputPath: string | undefined;
  let apply = false;

  for (let index = 0; index < normalizedArguments.length; index += 1) {
    const argument = normalizedArguments[index];
    if (argument === '--network') {
      networkAcknowledged = true;
    } else if (argument === '--apply') {
      apply = true;
    } else if (argument === '--url') {
      sourceUrl = normalizedArguments[++index];
    } else if (argument === '--output') {
      outputPath = normalizedArguments[++index];
    } else if (argument === '--help') {
      return 'help';
    } else {
      throw new Error(`Unknown fixture refresh argument ${JSON.stringify(argument)}.`);
    }
  }

  if (!networkAcknowledged || sourceUrl === undefined || outputPath === undefined) {
    return undefined;
  }

  return {sourceUrl, outputPath, apply};
}

function usage(): string {
  return 'Usage: nub run acceptance:refresh-fixtures -- --network --url <https-url> --output <fixture-path> [--apply]\n';
}

function headersForSource(sourceUrl: string): RequestInit['headers'] {
  const hostname = new URL(sourceUrl).hostname;
  if (hostname === 'api.core.openaip.net') {
    const apiKey = process.env['OPENAIP_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error('OPENAIP_API_KEY is required to refresh OpenAIP fixtures.');
    }

    return {'x-openaip-api-key': apiKey};
  }

  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed === 'help') {
      process.stdout.write(usage());
    } else if (parsed === undefined) {
      process.stderr.write(usage());
      process.exitCode = 2;
    } else {
      const result = await refreshFixture({
        ...parsed,
        headers: headersForSource(parsed.sourceUrl),
      });
      process.stdout.write(`Source URL: ${result.sourceUrl}\n`);
      process.stdout.write(`Target: ${result.outputPath}\n`);
      process.stdout.write(`SHA-256: ${result.checksum}\n`);
      process.stdout.write(`Changed: ${result.changed ? 'yes' : 'no'}\n`);
      process.stdout.write(result.diff);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Fixture refresh failed.'}\n`
    );
    process.exitCode = 1;
  }
}

export default {createFixtureDiff, formatFixtureContents, refreshFixture};
