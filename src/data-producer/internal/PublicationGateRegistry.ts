import type {DuckDBInstance} from '@duckdb/node-api';

import FifoOperationCoordinator from '#radial/application/internal/FifoOperationCoordinator.js';
import PublicationGate from '#radial/data-producer/internal/PublicationGate.js';

const gates = new WeakMap<DuckDBInstance, PublicationGate>();

function forInstance(instance: DuckDBInstance): PublicationGate {
  let gate = gates.get(instance);
  if (gate === undefined) {
    gate = new PublicationGate(new FifoOperationCoordinator());
    gates.set(instance, gate);
  }
  return gate;
}

export default {forInstance};
