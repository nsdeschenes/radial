import {realpath} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';

type SharedRuntimeEntry = {
  referenceCount: number;
  runtime: SharedDuckDBRuntime;
};

const runtimes = new Map<string, SharedRuntimeEntry>();

class SharedDuckDBRuntime {
  readonly databasePath: string;
  #instance: DuckDBInstance | undefined;
  #instancePromise: Promise<DuckDBInstance> | undefined;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
  }

  async instance(): Promise<DuckDBInstance> {
    this.#instancePromise ??= this.#createInstance();
    return this.#instancePromise;
  }

  close(): void {
    this.#instance?.closeSync();
    this.#instance = undefined;
    this.#instancePromise = undefined;
  }

  async #createInstance(): Promise<DuckDBInstance> {
    try {
      const instance = await DuckDBInstance.create(this.databasePath);
      this.#instance = instance;
      return instance;
    } catch (error) {
      this.#instancePromise = undefined;
      throw error;
    }
  }
}

async function acquireSharedDuckDBRuntime(
  configuredDatabasePath: string
): Promise<SharedDuckDBRuntime> {
  const databasePath = await canonicalizeDatabasePath(configuredDatabasePath);
  const current = runtimes.get(databasePath);
  if (current !== undefined) {
    current.referenceCount += 1;
    return current.runtime;
  }

  const runtime = new SharedDuckDBRuntime(databasePath);
  runtimes.set(databasePath, {referenceCount: 1, runtime});
  return runtime;
}

function releaseSharedDuckDBRuntime(runtime: SharedDuckDBRuntime): void {
  const current = runtimes.get(runtime.databasePath);
  if (current === undefined || current.runtime !== runtime) {
    throw new Error('Shared DuckDB runtime ownership invariant failed.');
  }

  current.referenceCount -= 1;
  if (current.referenceCount === 0) {
    runtimes.delete(runtime.databasePath);
    runtime.close();
  }
}

async function canonicalizeDatabasePath(databasePath: string): Promise<string> {
  if (databasePath === ':memory:') {
    return databasePath;
  }

  const absolutePath = resolve(databasePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }

    const parentPath = dirname(absolutePath);
    if (parentPath === absolutePath) {
      throw error;
    }
    return join(await canonicalizeDatabasePath(parentPath), basename(absolutePath));
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export default {
  acquire: acquireSharedDuckDBRuntime,
  release: releaseSharedDuckDBRuntime,
};
