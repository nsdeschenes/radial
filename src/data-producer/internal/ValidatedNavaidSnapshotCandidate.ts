import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';

declare const VALIDATED_NAVAID_SNAPSHOT_CANDIDATE: unique symbol;

export default interface ValidatedNavaidSnapshotCandidate extends NavaidSnapshotCandidate {
  readonly [VALIDATED_NAVAID_SNAPSHOT_CANDIDATE]: true;
}
