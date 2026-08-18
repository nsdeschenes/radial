import {AsyncLocalStorage} from 'node:async_hooks';

import type FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';

type Coordinator = InstanceType<typeof FifoOperationCoordinator>;

class PublicationGate {
  readonly #context = new AsyncLocalStorage<symbol>();
  readonly #coordinator: Coordinator;
  #activeToken: symbol | undefined;

  constructor(coordinator: Coordinator) {
    this.#coordinator = coordinator;
  }

  run<Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    const activeToken = this.#context.getStore();
    if (activeToken !== undefined && activeToken === this.#activeToken) {
      return Promise.reject(new Error('The publication gate is non-reentrant.'));
    }

    const token = Symbol('publication');
    return this.#coordinator.run(async () => {
      this.#activeToken = token;
      try {
        return await this.#context.run(token, operation);
      } finally {
        if (this.#activeToken === token) {
          this.#activeToken = undefined;
        }
      }
    }, signal);
  }

  close(): void {
    this.#coordinator.close();
  }

  whenIdle(): Promise<void> {
    return this.#coordinator.whenIdle();
  }
}

export default PublicationGate;
