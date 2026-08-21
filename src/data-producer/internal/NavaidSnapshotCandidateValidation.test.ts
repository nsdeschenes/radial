import {expect, expectTypeOf, test} from 'vitest';

import validateNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidateValidation.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import type ValidatedNavaidSnapshotCandidate from '#radial/data-producer/internal/ValidatedNavaidSnapshotCandidate.js';
import createSyntheticNavaidSnapshotCandidate from '#radial/test/data-producer/createSyntheticNavaidSnapshotCandidate.js';

test('admits only an opaque validated candidate type', () => {
  const candidate: NavaidSnapshotCandidate = structuredClone(
    createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z')
  );
  const validatedCandidate = validateNavaidSnapshotCandidate(candidate);

  expectTypeOf<NavaidSnapshotCandidate>().not.toMatchTypeOf<ValidatedNavaidSnapshotCandidate>();
  expectTypeOf(validatedCandidate).toMatchTypeOf<ValidatedNavaidSnapshotCandidate>();
});

test('rejects candidate semantics independently of publication', () => {
  const candidate = structuredClone(
    createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z')
  );
  Reflect.set(
    candidate.componentChecksums,
    'rawNavaids',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  );

  expect(() => validateNavaidSnapshotCandidate(candidate)).toThrow(
    'candidate raw Navaid checksum does not reconcile'
  );
});

test('deeply copies and freezes every approved candidate value', () => {
  const callerOwnedCandidate = structuredClone(
    createSyntheticNavaidSnapshotCandidate('2026-08-17T12:00:00.000Z')
  );
  const expectedCandidate = structuredClone(callerOwnedCandidate);
  const validatedCandidate = validateNavaidSnapshotCandidate(callerOwnedCandidate);

  expect(validatedCandidate).not.toBe(callerOwnedCandidate);
  expectDeeplyFrozen(validatedCandidate);

  Reflect.set(callerOwnedCandidate.provenance, 'sourceIdentity', 'mutated');
  Reflect.set(callerOwnedCandidate.provenance.magneticModel, 'model', 'mutated');
  Reflect.set(callerOwnedCandidate.provenance.faaNasr, 'cycleId', 'mutated');
  Reflect.set(callerOwnedCandidate.rawNavaids[0]!, 'sourceRecordId', 'mutated');
  Reflect.set(callerOwnedCandidate.plannerNavaids[0]!, 'identifier', 'mutated');
  Reflect.set(callerOwnedCandidate.exclusions[0]!, 'reason', 'mutated');
  Reflect.set(callerOwnedCandidate.facilityVariationAudits[0]!, 'outcome', 'mutated');
  Reflect.set(callerOwnedCandidate.componentChecksums, 'rawNavaids', 'mutated');
  Reflect.set(callerOwnedCandidate.rawNavaids, 'length', 0);

  expect(validatedCandidate).toEqual(expectedCandidate);
});

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
}
