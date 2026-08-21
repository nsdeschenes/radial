import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';
import faaNasrFacilityVariation from '#radial/data-producer/internal/FAANasrFacilityVariation.js';
import type NavaidSnapshotCandidate from '#radial/data-producer/internal/ProducerSchemaNavaidSnapshotCandidate.js';
import Wmm2025 from '#radial/data-producer/internal/Wmm2025.js';

const {localMagneticDeclinationFromWmm2025, wmm2025Provenance} = Wmm2025;
const FREQUENCY_VALUE_PATTERN = /^\d{3}\.\d{3}$/;

type FAANasrCycleArtifact = Parameters<
  typeof faaNasrFacilityVariation.selectApplicableCycle
>[0][number];
type FacilityVariationAudit = NavaidSnapshotCandidate['facilityVariationAudits'][number];
type NavaidFamily = NavaidSnapshotCandidate['plannerNavaids'][number]['family'];

const FAMILY_BY_TYPE = new Map<number, NavaidFamily>([
  [2, 'NDB'],
  [3, 'VOR'],
  [4, 'VOR-DME'],
  [5, 'VORTAC'],
  [6, 'DVOR'],
  [7, 'DVOR-DME'],
  [8, 'DVORTAC'],
]);
const DEFAULT_PUBLISHED_RANGE_NM = 90;

type JsonObject = Readonly<Record<string, unknown>>;

type CandidateInputProvenance = Readonly<{
  sourceIdentity: string;
  derivationPolicyIdentity: string;
  matchingPolicyIdentity: string;
}>;

type CandidateProvenance = NavaidSnapshotCandidate['provenance'];
type PlannerNavaid = NavaidSnapshotCandidate['plannerNavaids'][number];
type NavaidExclusion = NavaidSnapshotCandidate['exclusions'][number];

type BuildCandidateRequest = Readonly<{
  faaNasrCycles: readonly FAANasrCycleArtifact[];
  rawNavaids: readonly unknown[];
  provenance: CandidateInputProvenance;
  retrievedAt: string;
  retrievalCompletedAt: string;
}>;

type IdentifiedRecord = Readonly<{
  sourceRecordId: string;
  canonicalRecord: string;
  record: JsonObject;
}>;

function buildNavaidSnapshotCandidate(
  request: BuildCandidateRequest
): NavaidSnapshotCandidate {
  validateTimestamp(request.retrievedAt, 'retrievedAt');
  validateTimestamp(request.retrievalCompletedAt, 'retrievalCompletedAt');
  if (request.retrievalCompletedAt < request.retrievedAt) {
    throw new Error('retrievalCompletedAt must not precede retrievedAt.');
  }

  validateInputProvenance(request.provenance);
  const selectedNasrCycle = faaNasrFacilityVariation.selectApplicableCycle(
    request.faaNasrCycles,
    request.retrievedAt
  );
  if (
    selectedNasrCycle.retrievedAt < request.retrievedAt ||
    selectedNasrCycle.retrievedAt > request.retrievalCompletedAt
  ) {
    throw new Error('FAA NASR retrieval time must fall within snapshot retrieval');
  }

  const {records: _, ...faaNasr} = selectedNasrCycle;
  const provenance = Object.freeze({
    ...request.provenance,
    magneticModel: wmm2025Provenance(request.retrievedAt.slice(0, 10)),
    faaNasr,
  });

  const identifiedRecords = identifyRecords(request.rawNavaids);
  const rawNavaids = identifiedRecords.map(({sourceRecordId, canonicalRecord}) => ({
    sourceRecordId,
    canonicalRecord,
    recordChecksum: checksum(canonicalRecord),
  }));
  const plannerNavaids: PlannerNavaid[] = [];
  const exclusions: NavaidExclusion[] = [];
  const facilityVariationAudits: FacilityVariationAudit[] = [];

  for (const identified of identifiedRecords) {
    const derived = deriveNavaid(identified, provenance.magneticModel.referenceDate);
    if ('reason' in derived) {
      exclusions.push(derived);
    } else {
      if (isVorFamily(derived.family)) {
        const match = faaNasrFacilityVariation.match(
          {
            country: countryFrom(identified.record['country']),
            family: derived.family,
            frequencyUnit: 'MHz',
            frequencyValue: derived.frequencyValue,
            identifier: derived.identifier,
            latitude: derived.latitude,
            longitude: derived.longitude,
            sourceRecordId: derived.sourceRecordId,
          },
          selectedNasrCycle,
          request.provenance.matchingPolicyIdentity
        );
        plannerNavaids.push({
          ...derived,
          facilityVariationDegEast: match.facilityVariation?.degreesEast ?? null,
          facilityVariationSource: match.facilityVariation?.source ?? null,
        });
        facilityVariationAudits.push(match.audit);
      } else {
        plannerNavaids.push(derived);
      }
    }
  }

  const componentChecksums = Object.freeze({
    rawNavaids: checksum(canonicalizeJson(rawNavaids)),
    plannerNavaids: checksum(canonicalizeJson(plannerNavaids)),
    exclusions: checksum(canonicalizeJson(exclusions)),
    facilityVariationAudits: checksum(
      canonicalizeJson(facilityVariationAudits.map(checksumFacilityVariationAudit))
    ),
  });
  const snapshotChecksum = checksum(
    canonicalizeJson({
      manifestVersion: 1,
      provenance: checksumProvenance(provenance),
      componentChecksums,
      counts: {
        rawNavaids: rawNavaids.length,
        plannerNavaids: plannerNavaids.length,
        exclusions: exclusions.length,
      },
    })
  );

  return Object.freeze({
    retrievedAt: request.retrievedAt,
    retrievalCompletedAt: request.retrievalCompletedAt,
    provenance,
    rawNavaids: Object.freeze(rawNavaids),
    plannerNavaids: Object.freeze(plannerNavaids),
    exclusions: Object.freeze(exclusions),
    facilityVariationAudits: Object.freeze(facilityVariationAudits),
    componentChecksums,
    snapshotChecksum,
  });
}

function checksumProvenance(provenance: CandidateProvenance) {
  const {retrievedAt: _, ...faaNasr} = provenance.faaNasr;
  return {...provenance, faaNasr};
}

function checksumFacilityVariationAudit(audit: FacilityVariationAudit) {
  const {nasrRetrievedAt: _, ...checksumAudit} = audit;
  return checksumAudit;
}

function identifyRecords(rawNavaids: readonly unknown[]): IdentifiedRecord[] {
  const prepared = rawNavaids.map((value, index) => {
    if (!isJsonObject(value)) {
      throw new Error(`raw Navaid ${index + 1} must be a JSON object.`);
    }

    try {
      return {record: value, canonicalRecord: canonicalizeJson(value)};
    } catch {
      throw new Error(`raw Navaid ${index + 1} is not RFC 8785 canonicalizable.`);
    }
  });
  const seenIds = new Set<string>();
  for (const {record} of prepared) {
    const sourceId = nonEmptyString(record['_id']);
    if (sourceId !== undefined) {
      if (seenIds.has(sourceId)) {
        throw new Error(`duplicate non-null OpenAIP source identity ${sourceId}`);
      }

      seenIds.add(sourceId);
    }
  }

  const generatedOrdinals = new Map<string, number>();
  return prepared
    .toSorted((left, right) =>
      compareStrings(left.canonicalRecord, right.canonicalRecord)
    )
    .map(({record, canonicalRecord}) => {
      const providedId = nonEmptyString(record['_id']);
      if (providedId !== undefined) {
        return {sourceRecordId: providedId, canonicalRecord, record};
      }

      const contentChecksum = checksum(canonicalRecord);
      const ordinal = (generatedOrdinals.get(contentChecksum) ?? 0) + 1;
      generatedOrdinals.set(contentChecksum, ordinal);
      return {
        sourceRecordId: `generated:${contentChecksum}:${ordinal}`,
        canonicalRecord,
        record,
      };
    })
    .toSorted((left, right) => compareStrings(left.sourceRecordId, right.sourceRecordId));
}

function deriveNavaid(
  identified: IdentifiedRecord,
  magneticReferenceDate: string
): PlannerNavaid | NavaidExclusion {
  const {record, sourceRecordId} = identified;
  if (sourceRecordId === '') {
    return {sourceRecordId, reason: 'missing-stable-identity'};
  }

  const family =
    typeof record['type'] === 'number' ? FAMILY_BY_TYPE.get(record['type']) : undefined;
  if (family === undefined) {
    return {sourceRecordId, reason: 'unsupported-navaid-type'};
  }

  const coordinates = coordinatesFrom(record['geometry']);
  if (coordinates === undefined) {
    return {sourceRecordId, reason: 'invalid-coordinates'};
  }

  const identifier = nonEmptyString(record['identifier']);
  if (identifier === undefined) {
    return {sourceRecordId, reason: 'missing-identifier'};
  }

  const frequency = frequencyFrom(record['frequency'], family);
  if (frequency === undefined) {
    return {sourceRecordId, reason: 'invalid-frequency'};
  }

  const publishedRangeNm = rangeFrom(record['range']);
  if (publishedRangeNm === undefined) {
    return {sourceRecordId, reason: 'invalid-published-range'};
  }

  return {
    sourceRecordId,
    databaseId: `openaip:${sourceRecordId}`,
    identifier,
    name: nonEmptyString(record['name']) ?? identifier,
    family,
    longitude: coordinates.longitude,
    latitude: coordinates.latitude,
    frequencyValue: frequency.value,
    frequencyUnit: frequency.unit,
    publishedRangeNm,
    magneticDeclinationDegEast: localMagneticDeclinationFromWmm2025({
      referenceDate: magneticReferenceDate,
      longitude: coordinates.longitude,
      latitude: coordinates.latitude,
    }),
    facilityVariationDegEast: null,
    facilityVariationSource: null,
    facilityVariationEffectiveDate: null,
  };
}

function coordinatesFrom(
  value: unknown
): {longitude: number; latitude: number} | undefined {
  if (!isJsonObject(value) || value['type'] !== 'Point') {
    return undefined;
  }

  const coordinates = value['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return undefined;
  }

  const [longitude, latitude] = coordinates;
  if (
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    return undefined;
  }

  return {longitude, latitude};
}

function frequencyFrom(
  value: unknown,
  family: string
): {value: number; unit: 'kHz' | 'MHz'} | undefined {
  if (!isJsonObject(value) || typeof value['value'] !== 'string') {
    return undefined;
  }

  const expectedUnit = family === 'NDB' ? 1 : 2;
  if (value['unit'] !== expectedUnit || !FREQUENCY_VALUE_PATTERN.test(value['value'])) {
    return undefined;
  }

  const numericValue = Number(value['value']);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }

  return {value: numericValue, unit: expectedUnit === 1 ? 'kHz' : 'MHz'};
}

function rangeFrom(value: unknown): number | undefined {
  if (value === undefined) {
    return DEFAULT_PUBLISHED_RANGE_NM;
  }

  if (!isJsonObject(value) || value['unit'] !== 2) {
    return undefined;
  }

  const range = value['value'];
  return typeof range === 'number' && Number.isFinite(range) && range > 0
    ? range
    : undefined;
}

function validateInputProvenance(provenance: CandidateInputProvenance): void {
  for (const [name, value] of [
    ['sourceIdentity', provenance.sourceIdentity],
    ['derivationPolicyIdentity', provenance.derivationPolicyIdentity],
    ['matchingPolicyIdentity', provenance.matchingPolicyIdentity],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`${name} must not be empty.`);
    }
  }
}

function isVorFamily(family: NavaidFamily): family is Exclude<NavaidFamily, 'NDB'> {
  return family !== 'NDB';
}

function countryFrom(value: unknown): string | readonly string[] | undefined {
  if (typeof value === 'string') {
    return value;
  }

  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp.`);
  }
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export default buildNavaidSnapshotCandidate;
