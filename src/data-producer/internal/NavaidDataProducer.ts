import type {DuckDBInstance} from '@duckdb/node-api';
import * as Sentry from '@sentry/node';

import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import FAANasrCycleSourceError from '#radial/data-producer/internal/FAANasrCycleSourceError.js';
import faaNasrFacilityVariation from '#radial/data-producer/internal/FAANasrFacilityVariation.js';
import buildNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidate.js';
import validateNavaidSnapshotCandidate from '#radial/data-producer/internal/NavaidSnapshotCandidateValidation.js';
import NavaidSnapshotPublicationError from '#radial/data-producer/internal/NavaidSnapshotPublicationError.js';
import NavaidSnapshotValidationError from '#radial/data-producer/internal/NavaidSnapshotValidationError.js';
import captureOpenAIPNavaids from '#radial/data-producer/internal/OpenAIPNavaidCapture.js';
import OpenAIPNavaidCaptureError from '#radial/data-producer/internal/OpenAIPNavaidCaptureError.js';
import type OpenAIPNavaidTransport from '#radial/data-producer/internal/OpenAIPNavaidTransport.js';
import producerSchema from '#radial/data-producer/internal/ProducerSchema.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import acquireProductionFAANasrCycle from '#radial/data-producer/internal/ProductionFAANasrCycleSource.js';
import createProductionOpenAIPNavaidTransport from '#radial/data-producer/internal/ProductionOpenAIPNavaidTransport.js';
import type PublicationGate from '#radial/data-producer/internal/PublicationGate.js';

type FAANasrCycles = Parameters<typeof buildNavaidSnapshotCandidate>[0]['faaNasrCycles'];
type ReloadResult = RadialApplicationTypes['NavaidReloadResult'];
type ReloadRequest = RadialApplicationTypes['NavaidReloadRequest'];

type NavaidDataProducerDependencies = Readonly<{
  acquireFAANasrCycles?: (
    retrievalStartedAt: string,
    signal?: AbortSignal
  ) => Promise<FAANasrCycles>;
  createOpenAIPTransport?: (apiKey: string) => OpenAIPNavaidTransport;
  now?: () => Date;
  beforeNavaidCommit?: () => void | Promise<void>;
}>;

async function reloadNavaids(
  instance: DuckDBInstance,
  request: ReloadRequest,
  publicationGate: PublicationGate,
  dependencies: NavaidDataProducerDependencies = {}
): Promise<ReloadResult> {
  if (request.openAipApiKey.trim() === '') {
    return failure(
      'DATA_CREDENTIALS_MISSING',
      'OpenAIP credentials are missing.',
      'OPENAIP_API_KEY is required for an explicit Navaid reload.',
      'Set OPENAIP_API_KEY and retry the Navaid reload.',
      true
    );
  }

  abortableOperation.throwIfAborted(request.signal);

  request.onProgress?.({stage: 'database', message: 'Preparing Producer Schema.'});
  try {
    await Sentry.startSpan(
      {
        name: 'Prepare Producer Schema',
        op: 'db.query',
        attributes: {
          'db.operation.name': 'initialize',
          'db.query.summary': 'producer schema',
          'db.system.name': 'duckdb',
        },
      },
      () => publicationGate.run(() => producerSchema.prepare(instance), request.signal)
    );
    abortableOperation.throwIfAborted(request.signal);
  } catch (error) {
    rethrowIfInterrupted(error, request.signal);
    return failure(
      'DATA_DATABASE_INVALID',
      'The configured database is invalid.',
      'The Producer Schema could not be prepared safely.',
      'Inspect the configured database and retry with a valid Radial database.',
      true
    );
  }

  const now = dependencies.now ?? (() => new Date());
  abortableOperation.throwIfAborted(request.signal);
  let captured: Awaited<ReturnType<typeof captureOpenAIPNavaids>>;
  request.onProgress?.({stage: 'openaip', message: 'Acquiring OpenAIP Navaids.'});
  Sentry.logger.info('OpenAIP Navaid acquisition started', {
    'radial.data.source': 'openaip',
  });
  try {
    captured = await Sentry.startSpan({name: 'Acquire OpenAIP Navaids', op: 'task'}, () =>
      captureOpenAIPNavaids({
        transport: (
          dependencies.createOpenAIPTransport ?? createProductionOpenAIPNavaidTransport
        )(request.openAipApiKey),
        now,
        onProgress(progress) {
          Sentry.logger.debug('OpenAIP Navaid page acquired', {
            'radial.data.source': 'openaip',
            'radial.navaid.cumulative_record_count': progress.cumulativeRecordCount,
            'radial.navaid.page': progress.page,
            'radial.navaid.total_pages': progress.totalPages,
          });
          request.onProgress?.({
            stage: 'openaip',
            message:
              `fetching Navaids page ${progress.page}/${progress.totalPages} ` +
              `(${progress.cumulativeRecordCount} records)`,
          });
        },
        ...(request.signal === undefined ? {} : {signal: request.signal}),
      })
    );
    Sentry.logger.info('OpenAIP Navaid acquisition completed', {
      'radial.data.source': 'openaip',
      'radial.navaid.raw_count': captured.rawNavaids.length,
    });
    Sentry.metrics.distribution(
      'radial.integration.records_acquired',
      captured.rawNavaids.length,
      {attributes: {record_type: 'navaid', source: 'openaip'}}
    );
  } catch (error) {
    rethrowIfInterrupted(error, request.signal);
    const code: RadialApplicationTypes['DataFailure']['code'] =
      error instanceof OpenAIPNavaidCaptureError
        ? (
            {
              auth: 'DATA_OPENAIP_AUTH',
              forbidden: 'DATA_OPENAIP_FORBIDDEN',
              unavailable: 'DATA_OPENAIP_UNAVAILABLE',
              'invalid-response': 'DATA_OPENAIP_INVALID_RESPONSE',
              'snapshot-drift': 'DATA_SNAPSHOT_DRIFT',
            } as const
          )[error.code]
        : 'DATA_OPENAIP_UNAVAILABLE';
    Sentry.logger.error('OpenAIP Navaid acquisition failed', {
      'radial.data.source': 'openaip',
      'radial.failure.code': code,
    });
    return failure(
      code,
      'OpenAIP Navaid acquisition failed.',
      'OpenAIP Navaid acquisition did not complete.',
      'Check OpenAIP availability and credentials, then retry.',
      true
    );
  }

  let faaNasrCycles: FAANasrCycles;
  abortableOperation.throwIfAborted(request.signal);
  request.onProgress?.({stage: 'nasr', message: 'Acquiring FAA NASR data.'});
  Sentry.logger.info('FAA NASR acquisition started', {
    'radial.data.source': 'faa-nasr',
  });
  try {
    faaNasrCycles = await Sentry.startSpan(
      {name: 'Acquire FAA NASR cycle', op: 'task'},
      () =>
        (dependencies.acquireFAANasrCycles ?? acquireProductionFAANasrCycle)(
          captured.retrievedAt,
          request.signal
        )
    );
  } catch (error) {
    rethrowIfInterrupted(error, request.signal);
    const code =
      error instanceof FAANasrCycleSourceError && error.code === 'invalid-response'
        ? 'DATA_NASR_INVALID_RESPONSE'
        : 'DATA_NASR_UNAVAILABLE';
    Sentry.logger.error('FAA NASR acquisition failed', {
      'radial.data.source': 'faa-nasr',
      'radial.failure.code': code,
    });
    return failure(
      code,
      'FAA NASR acquisition failed.',
      error instanceof FAANasrCycleSourceError && error.code === 'invalid-response'
        ? 'The applicable FAA NASR archive response is invalid.'
        : 'The applicable FAA NASR archive is unavailable.',
      'Check FAA NASR availability and source compatibility, then retry.',
      true
    );
  }

  try {
    abortableOperation.throwIfAborted(request.signal);
    const selectedCycle = faaNasrFacilityVariation.selectApplicableCycle(
      faaNasrCycles,
      captured.retrievedAt
    );
    Sentry.logger.info('FAA NASR acquisition completed', {
      'radial.data.source': 'faa-nasr',
      'radial.nasr.cycle_id': selectedCycle.cycleId,
      'radial.nasr.effective_date': selectedCycle.effectiveDate,
      'radial.nasr.record_count': selectedCycle.records.length,
    });
    Sentry.metrics.distribution(
      'radial.integration.records_acquired',
      selectedCycle.records.length,
      {attributes: {record_type: 'navaid', source: 'faa-nasr'}}
    );
  } catch (error) {
    rethrowIfInterrupted(error, request.signal);
    Sentry.logger.error('FAA NASR source validation failed', {
      'radial.data.source': 'faa-nasr',
      'radial.failure.code': 'DATA_NASR_INVALID_RESPONSE',
    });
    return failure(
      'DATA_NASR_INVALID_RESPONSE',
      'FAA NASR source validation failed.',
      'The applicable FAA NASR archive or metadata is invalid.',
      'Retry after the FAA NASR source is corrected.',
      true
    );
  }

  request.onProgress?.({stage: 'derive', message: 'validating raw records'});
  request.onProgress?.({stage: 'derive', message: 'deriving planner-ready data'});
  request.onProgress?.({stage: 'derive', message: 'calculating magnetic data'});
  let candidate: NavaidSnapshotCandidate;
  try {
    candidate = Sentry.startSpan(
      {name: 'Derive Navaid Snapshot candidate', op: 'function'},
      () =>
        buildNavaidSnapshotCandidate({
          faaNasrCycles,
          rawNavaids: captured.rawNavaids,
          provenance: {
            sourceIdentity:
              'openaip-core-api:/navaids:contract-1.1:limit-1000:sort-_id-ascending',
            derivationPolicyIdentity: 'radial:navaid-derivation:v1',
            matchingPolicyIdentity: 'radial:faa-nasr-match:v1',
          },
          retrievedAt: captured.retrievedAt,
          retrievalCompletedAt: now().toISOString(),
        })
    );
    Sentry.logger.info('Navaid Snapshot candidate derived', {
      'radial.navaid.exclusion_count': candidate.exclusions.length,
      'radial.navaid.planner_count': candidate.plannerNavaids.length,
      'radial.navaid.raw_count': candidate.rawNavaids.length,
    });
  } catch (error) {
    rethrowIfInterrupted(error, request.signal);
    if (error instanceof Error && error.message.startsWith('WMM2025 ')) {
      Sentry.logger.error('Navaid Snapshot magnetic derivation failed', {
        'radial.failure.code': 'DATA_MAGNETIC_MODEL_INVALID',
      });
      return failure(
        'DATA_MAGNETIC_MODEL_INVALID',
        'Local Magnetic Declination calculation failed.',
        'The pinned WMM2025 model could not produce valid magnetic data.',
        'Retry with a supported magnetic reference date or corrected model artifact.',
        true
      );
    }

    Sentry.logger.error('Navaid Snapshot derivation failed', {
      'radial.failure.code': 'DATA_DERIVATION_FAILED',
    });
    return failure(
      'DATA_DERIVATION_FAILED',
      'Navaid Snapshot derivation failed.',
      'The acquired sources could not produce a valid Navaid Snapshot candidate.',
      'Retry after verifying OpenAIP, FAA NASR, and magnetic-model source compatibility.',
      true
    );
  }

  abortableOperation.throwIfAborted(request.signal);
  request.onProgress?.({stage: 'publish', message: 'publishing Navaid Snapshot'});
  try {
    const validatedCandidate = validateNavaidSnapshotCandidate(candidate);
    const published = await Sentry.startSpan(
      {
        name: 'Publish Navaid Snapshot',
        op: 'db.query',
        attributes: {
          'db.operation.name': 'publish',
          'db.query.summary': 'Navaid Snapshot',
          'db.system.name': 'duckdb',
        },
      },
      () =>
        producerSchema.publishNavaidSnapshot(
          instance,
          validatedCandidate,
          publicationGate,
          {
            ...(dependencies.beforeNavaidCommit === undefined
              ? {}
              : {beforeCommit: dependencies.beforeNavaidCommit}),
            ...(request.signal === undefined ? {} : {signal: request.signal}),
          }
        )
    );
    request.onProgress?.({stage: 'complete', message: 'Navaid Snapshot committed.'});
    Sentry.logger.info('Navaid Snapshot published', {
      'radial.navaid.exclusion_count': validatedCandidate.exclusions.length,
      'radial.navaid.planner_count': validatedCandidate.plannerNavaids.length,
      'radial.navaid.snapshot_id': published.snapshotId,
    });
    for (const [kind, count] of [
      ['excluded', validatedCandidate.exclusions.length],
      ['planner', validatedCandidate.plannerNavaids.length],
      ['raw', validatedCandidate.rawNavaids.length],
    ] as const) {
      Sentry.metrics.gauge('radial.product.navaid_records', count, {
        attributes: {kind},
      });
    }

    return {
      ok: true,
      value: {
        snapshotId: published.snapshotId,
        snapshotChecksum: published.snapshotChecksum,
        rawNavaidCount: published.rawNavaidCount,
        plannerNavaidCount: published.plannerNavaidCount,
        vorFamilyNavaidCount: published.vorFamilyNavaidCount,
        fallbackNavaidCount: published.fallbackNavaidCount,
        exclusionCount: published.exclusionCount,
        exclusionCounts: published.exclusionCounts,
        facilityVariationPresentCount: published.facilityVariationPresentCount,
        facilityVariationMissingCount: published.facilityVariationMissingCount,
        facilityVariationEpochYearMissingCount:
          published.facilityVariationEpochYearMissingCount,
        retrievedAt: validatedCandidate.retrievedAt,
        retrievalCompletedAt: validatedCandidate.retrievalCompletedAt,
        provenance: validatedCandidate.provenance,
      },
    };
  } catch (error) {
    if (
      !(error instanceof NavaidSnapshotPublicationError && !error.activeDataPreserved)
    ) {
      rethrowIfInterrupted(error, request.signal);
    }

    if (error instanceof NavaidSnapshotValidationError) {
      Sentry.logger.error('Navaid Snapshot publication validation failed', {
        'radial.failure.code': 'DATA_VALIDATION_FAILED',
      });
      return failure(
        'DATA_VALIDATION_FAILED',
        'Navaid Snapshot validation failed.',
        'The derived candidate did not satisfy the publication invariants.',
        'Retry after the source-data incompatibility is corrected.',
        true
      );
    }

    Sentry.logger.error('Navaid Snapshot publication failed', {
      'radial.data.active_preserved':
        error instanceof NavaidSnapshotPublicationError
          ? error.activeDataPreserved
          : false,
      'radial.failure.code': 'DATA_PUBLICATION_FAILED',
    });
    return failure(
      'DATA_PUBLICATION_FAILED',
      'Navaid Snapshot publication failed.',
      'The Navaid Snapshot could not be committed.',
      'Inspect database availability and retry the reload.',
      error instanceof NavaidSnapshotPublicationError ? error.activeDataPreserved : false
    );
  }
}

function failure(
  code: RadialApplicationTypes['DataFailure']['code'],
  summary: string,
  cause: string,
  action: string,
  activeDataPreserved: boolean
): ReloadResult {
  return {
    ok: false,
    failure: {code, summary, cause, action, activeDataPreserved},
  };
}

function rethrowIfInterrupted(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortableOperation.abortError(signal);
  }

  if (abortableOperation.isAbortError(error)) {
    throw error;
  }
}

export default reloadNavaids;
