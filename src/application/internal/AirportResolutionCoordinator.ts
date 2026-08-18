import type {DuckDBInstance} from '@duckdb/node-api';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import ensureCachedAirport from '#radial/data-producer/internal/AirportDataProducer.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';

type AirportDataProducerDependencies = NonNullable<
  Parameters<typeof ensureCachedAirport>[3]
>;
type AirportResolutionResult = Awaited<ReturnType<typeof ensureCachedAirport>>;
type AirportReloadRequest = Parameters<typeof ensureCachedAirport.reloadAirport>[1];
type AirportReloadResult = Awaited<ReturnType<typeof ensureCachedAirport.reloadAirport>>;

class AirportResolutionCoordinator {
  readonly #publicationGate: PublicationGate;
  readonly #queues = new Map<string, FifoOperationCoordinator>();
  readonly #ordinaryWork = new Map<string, Promise<AirportResolutionResult>>();
  #isClosed = false;

  constructor(publicationGate: PublicationGate) {
    this.#publicationGate = publicationGate;
  }

  ensure(
    instance: DuckDBInstance,
    normalizedIcao: string,
    openAipApiKey: string,
    dependencies: AirportDataProducerDependencies,
    signal?: AbortSignal
  ): Promise<AirportResolutionResult> {
    if (this.#isClosed) {
      return Promise.reject(new Error('The Airport coordinator has been closed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(abortableOperation.abortError(signal));
    }

    let work = this.#ordinaryWork.get(normalizedIcao);
    if (work === undefined) {
      const createdWork = this.#enqueue(normalizedIcao, () =>
        ensureCachedAirport(instance, normalizedIcao, openAipApiKey, {
          ...dependencies,
          publicationGate: this.#publicationGate,
        })
      );
      this.#ordinaryWork.set(normalizedIcao, createdWork);
      void createdWork.then(
        () => this.#deleteOrdinaryWork(normalizedIcao, createdWork),
        () => this.#deleteOrdinaryWork(normalizedIcao, createdWork)
      );
      work = createdWork;
    }
    return abortableOperation.awaitWithAbort(work, signal);
  }

  reload(
    instance: DuckDBInstance,
    request: AirportReloadRequest,
    dependencies: AirportDataProducerDependencies,
    signal?: AbortSignal
  ): Promise<AirportReloadResult> {
    if (this.#isClosed) {
      return Promise.reject(new Error('The Airport coordinator has been closed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(abortableOperation.abortError(signal));
    }
    const work = this.#enqueue(
      request.icao,
      () =>
        ensureCachedAirport.reloadAirport(instance, request, {
          ...dependencies,
          publicationGate: this.#publicationGate,
        }),
      signal,
      () =>
        request.onProgress?.({
          stage: 'database',
          message: 'Waiting for the active data operation.',
        })
    );
    return work;
  }

  close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    for (const queue of this.#queues.values()) {
      queue.close();
    }
    this.#queues.clear();
    this.#ordinaryWork.clear();
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.#queues.values()].map(queue => queue.whenIdle()));
  }

  #enqueue<Value>(
    normalizedIcao: string,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
    onQueued?: () => void
  ): Promise<Value> {
    let queue = this.#queues.get(normalizedIcao);
    if (queue === undefined) {
      queue = new FifoOperationCoordinator();
      this.#queues.set(normalizedIcao, queue);
    }
    const work = queue.run(operation, signal, onQueued);
    void work.then(
      () => this.#deleteQueue(normalizedIcao, queue),
      () => this.#deleteQueue(normalizedIcao, queue)
    );
    return work;
  }

  #deleteOrdinaryWork(
    normalizedIcao: string,
    work: Promise<AirportResolutionResult>
  ): void {
    if (this.#ordinaryWork.get(normalizedIcao) === work) {
      this.#ordinaryWork.delete(normalizedIcao);
    }
  }

  #deleteQueue(normalizedIcao: string, queue: FifoOperationCoordinator): void {
    if (this.#queues.get(normalizedIcao) === queue) {
      this.#queues.delete(normalizedIcao);
    }
  }
}

export default AirportResolutionCoordinator;
