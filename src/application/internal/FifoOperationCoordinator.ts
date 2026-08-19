import * as Sentry from '@sentry/node';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';

type QueueEntry = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  started: boolean;
  endQueueWait: () => void;
  onAbort: () => void;
};

class FifoOperationCoordinator {
  readonly #queue: QueueEntry[] = [];
  readonly #idleResolvers: (() => void)[] = [];
  #isClosed = false;
  #isRunning = false;

  run<Value>(
    operation: () => Promise<Value>,
    signal?: AbortSignal,
    onQueued?: () => void
  ): Promise<Value> {
    if (this.#isClosed) {
      return Promise.reject(new Error('The operation coordinator has been closed.'));
    }

    if (signal?.aborted) {
      return Promise.reject(abortableOperation.abortError(signal));
    }

    const isWaiting = this.#isRunning || this.#queue.length > 0;
    if (isWaiting) {
      onQueued?.();
    }
    const endQueueWait = createQueueWaitEnd(
      isWaiting,
      this.#queue.length + (this.#isRunning ? 1 : 0)
    );

    return new Promise<Value>((resolve, reject) => {
      const entry = {
        operation: async () => operation(),
        resolve: value => resolve(value as Value),
        reject,
        ...(signal === undefined ? {} : {signal}),
        started: false,
        endQueueWait,
        onAbort: () => {
          if (entry.started) {
            return;
          }

          const index = this.#queue.indexOf(entry);
          if (index === -1) {
            return;
          }

          this.#queue.splice(index, 1);
          entry.endQueueWait();
          if (signal !== undefined) {
            entry.reject(abortableOperation.abortError(signal));
          }

          this.#resolveIdleIfNeeded();
          void this.#drain();
        },
      } satisfies QueueEntry;

      signal?.addEventListener('abort', entry.onAbort, {once: true});
      this.#queue.push(entry);
      void this.#drain();
    });
  }

  close(): void {
    if (this.#isClosed) {
      return;
    }

    this.#isClosed = true;
    const queued = this.#queue.splice(0);
    for (const entry of queued) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.endQueueWait();
      entry.reject(new Error('The operation coordinator has been closed.'));
    }

    this.#resolveIdleIfNeeded();
  }

  async whenIdle(): Promise<void> {
    if (!this.#isRunning && this.#queue.length === 0) {
      return;
    }

    await new Promise<void>(resolve => this.#idleResolvers.push(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#isRunning) {
      return;
    }

    const entry = this.#queue.shift();
    if (entry === undefined) {
      this.#resolveIdleIfNeeded();
      return;
    }

    entry.started = true;
    entry.endQueueWait();
    entry.signal?.removeEventListener('abort', entry.onAbort);
    this.#isRunning = true;
    try {
      entry.resolve(await entry.operation());
    } catch (error) {
      entry.reject(error);
    } finally {
      this.#isRunning = false;
      void this.#drain();
    }
  }

  #resolveIdleIfNeeded(): void {
    if (this.#isRunning || this.#queue.length > 0) {
      return;
    }

    const resolvers = this.#idleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

function createQueueWaitEnd(isWaiting: boolean, queueDepth: number): () => void {
  if (!isWaiting) {
    return () => undefined;
  }

  const span = Sentry.startInactiveSpan({
    name: 'Wait for queued operation',
    op: 'queue.process',
    attributes: {'radial.queue.depth': queueDepth},
  });
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      span.end();
    }
  };
}

export default FifoOperationCoordinator;
