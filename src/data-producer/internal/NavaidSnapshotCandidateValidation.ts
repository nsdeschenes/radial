import validateNavaidSnapshotCandidateSemantics from '#radial/data-producer/internal/NavaidSnapshotCandidateSemantics.js';
import NavaidSnapshotValidationError from '#radial/data-producer/internal/NavaidSnapshotValidationError.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import type ValidatedNavaidSnapshotCandidate from '#radial/data-producer/internal/ValidatedNavaidSnapshotCandidate.js';

function validateNavaidSnapshotCandidate(
  candidate: NavaidSnapshotCandidate
): ValidatedNavaidSnapshotCandidate {
  try {
    const candidateCopy = structuredClone(candidate);
    validateNavaidSnapshotCandidateSemantics(candidateCopy);
    return deeplyFreeze(candidateCopy) as ValidatedNavaidSnapshotCandidate;
  } catch (error) {
    throw new NavaidSnapshotValidationError(
      error instanceof Error ? error.message : 'Navaid Snapshot candidate is invalid.'
    );
  }
}

function deeplyFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deeplyFreeze(nestedValue);
    }

    Object.freeze(value);
  }

  return value;
}

export default validateNavaidSnapshotCandidate;
