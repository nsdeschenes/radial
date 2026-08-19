import {readFile} from 'node:fs/promises';

import {z} from 'zod';

import type RoutePlannerAcceptanceTypes from '#radial/acceptance/RoutePlannerAcceptanceTypes.js';

const nonEmptyText = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const finiteNonNegativeNumber = z.number().finite().nonnegative();
const positiveInteger = z.number().int().positive();

const magneticReference = z
  .object({
    model: nonEmptyText,
    version: nonEmptyText,
    epochYear: z.number().finite(),
    referenceDate: z.iso.date(),
    source: nonEmptyText,
  })
  .strict();

const acceptanceBaseline = z
  .object({
    version: z.literal(1),
    snapshot: z
      .object({
        sha256,
        schemaVersion: positiveInteger,
        provenance: z
          .object({source: nonEmptyText, retrievedAt: z.iso.datetime()})
          .strict(),
        recordCounts: z
          .object({
            airports: positiveInteger,
            vorFamilyNavaids: positiveInteger,
            fallbackNavaids: z.number().int().nonnegative(),
          })
          .strict(),
        magneticReference: magneticReference.nullable(),
      })
      .strict(),
    route: z
      .object({
        departureIcao: z.string().regex(/^[A-Z]{4}$/u),
        arrivalIcao: z.string().regex(/^[A-Z]{4}$/u),
        maxRouteFactor: z.number().finite().min(1),
        searchMode: z.enum(['vor-family', 'ndb-fallback']),
        orderedNavaids: z
          .array(z.object({databaseId: nonEmptyText, identifier: nonEmptyText}).strict())
          .min(1),
      })
      .strict(),
    cliOutputSha256: sha256,
    approval: z.object({approvedBy: nonEmptyText, approvedAt: z.iso.datetime()}).strict(),
    benchmark: z
      .object({
        radialRevision: z.string().regex(/^[0-9a-f]{40}$/u),
        representativeMachineId: nonEmptyText,
        machine: z
          .object({
            platform: nonEmptyText,
            architecture: nonEmptyText,
            cpuModel: nonEmptyText,
            logicalCpuCount: positiveInteger,
            totalMemoryBytes: positiveInteger,
          })
          .strict(),
        runtime: z
          .object({nodeVersion: nonEmptyText, duckdbVersion: nonEmptyText})
          .strict(),
        warmupMs: finiteNonNegativeNumber,
        samplesMs: z.tuple([
          finiteNonNegativeNumber,
          finiteNonNegativeNumber,
          finiteNonNegativeNumber,
          finiteNonNegativeNumber,
          finiteNonNegativeNumber,
        ]),
        medianMs: finiteNonNegativeNumber,
        worstMs: finiteNonNegativeNumber,
      })
      .strict(),
  })
  .strict()
  .superRefine((baseline, context) => {
    if (baseline.route.departureIcao === baseline.route.arrivalIcao) {
      context.addIssue({
        code: 'custom',
        message: 'The baseline route airports must be different.',
        path: ['route', 'arrivalIcao'],
      });
    }

    const sortedSamples = baseline.benchmark.samplesMs.toSorted(
      (left, right) => left - right
    );
    if (baseline.benchmark.medianMs !== sortedSamples[2]) {
      context.addIssue({
        code: 'custom',
        message: 'The recorded median must equal the median benchmark sample.',
        path: ['benchmark', 'medianMs'],
      });
    }

    if (baseline.benchmark.worstMs !== Math.max(...baseline.benchmark.samplesMs)) {
      context.addIssue({
        code: 'custom',
        message: 'The recorded worst duration must equal the worst benchmark sample.',
        path: ['benchmark', 'worstMs'],
      });
    }
  });

async function readAcceptanceBaseline(
  baselinePath: string
): Promise<RoutePlannerAcceptanceTypes['AcceptanceBaseline']> {
  const contents = await readFile(baselinePath, 'utf8');
  const parsed: unknown = JSON.parse(contents);
  return acceptanceBaseline.parse(parsed);
}

export default readAcceptanceBaseline;
