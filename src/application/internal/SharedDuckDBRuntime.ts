import {realpath} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';

import {DuckDBInstance} from '@duckdb/node-api';

import AirportResolutionCoordinator from '#radial/application/internal/AirportResolutionCoordinator.js';
import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';
type SharedRuntimeEntry = {
  referenceCount: number;
  runtime: SharedDuckDBRuntime;
  closing: Promise<void> | undefined;
};

const runtimes = new Map<string, SharedRuntimeEntry>();

class SharedDuckDBRuntime {
  readonly databasePath: string;
  readonly airportResolutionCoordinator: AirportResolutionCoordinator;
  readonly navaidOperationCoordinator: FifoOperationCoordinator;
  readonly publicationGate: PublicationGate;
  #instance: DuckDBInstance | undefined;
  #instancePromise: Promise<DuckDBInstance> | undefined;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.navaidOperationCoordinator = new FifoOperationCoordinator();
    this.publicationGate = new PublicationGate(new FifoOperationCoordinator());
    this.airportResolutionCoordinator = new AirportResolutionCoordinator(
      this.publicationGate
    );
  }

  async whenIdle(): Promise<void> {
    await Promise.all([
      this.airportResolutionCoordinator.whenIdle(),
      this.navaidOperationCoordinator.whenIdle(),
      this.publicationGate.whenIdle(),
    ]);
  }

  async instance(): Promise<DuckDBInstance> {
    this.#instancePromise ??= this.#createInstance();
    return this.#instancePromise;
  }

  close(): void {
    this.airportResolutionCoordinator.close();
    this.publicationGate.close();
    this.navaidOperationCoordinator.close();
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
    if (current.closing !== undefined) {
      await current.closing;
      return acquireSharedDuckDBRuntime(configuredDatabasePath);
    }
    current.referenceCount += 1;
    return current.runtime;
  }

  const runtime = new SharedDuckDBRuntime(databasePath);
  runtimes.set(databasePath, {referenceCount: 1, runtime, closing: undefined});
  return runtime;
}

async function releaseSharedDuckDBRuntime(runtime: SharedDuckDBRuntime): Promise<void> {
  const current = runtimes.get(runtime.databasePath);
  if (current === undefined || current.runtime !== runtime) {
    throw new Error('Shared DuckDB runtime ownership invariant failed.');
  }

  current.referenceCount -= 1;
  if (current.referenceCount === 0) {
    current.closing = (async () => {
      await runtime.whenIdle();
      if (runtimes.get(runtime.databasePath)?.runtime === runtime) {
        runtimes.delete(runtime.databasePath);
      }
      runtime.close();
    })();
  }
  await current.closing;
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
