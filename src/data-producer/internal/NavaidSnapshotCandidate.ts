import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';

const FAMILY_BY_TYPE = new Map<number, string>([
  [2, 'NDB'],
  [3, 'VOR'],
  [4, 'VOR-DME'],
  [5, 'VORTAC'],
  [6, 'DVOR'],
  [7, 'DVOR-DME'],
  [8, 'DVORTAC'],
]);

type JsonObject = Readonly<Record<string, unknown>>;

type MagneticModelProvenance = Readonly<{
  model: string;
  version: string;
  epochYear: number;
  referenceDate: string;
  source: string;
  coefficientChecksum: string;
}>;

type CandidateProvenance = Readonly<{
  sourceIdentity: string;
  derivationPolicyIdentity: string;
  matchingPolicyIdentity: string;
  magneticModel: MagneticModelProvenance;
}>;

type RawNavaid = Readonly<{
  sourceRecordId: string;
  canonicalRecord: string;
  recordChecksum: string;
}>;

type PlannerNavaid = Readonly<{
  sourceRecordId: string;
  databaseId: string;
  identifier: string;
  name: string;
  family: string;
  longitude: number;
  latitude: number;
  frequencyValue: number;
  frequencyUnit: 'kHz' | 'MHz';
  publishedRangeNm: number;
  magneticDeclinationDegEast: number | null;
  facilityVariationDegEast: number | null;
  facilityVariationSource: string | null;
  facilityVariationEffectiveDate: string | null;
}>;

type NavaidExclusionReason =
  | 'missing-stable-identity'
  | 'unsupported-navaid-type'
  | 'invalid-coordinates'
  | 'missing-identifier'
  | 'invalid-frequency'
  | 'invalid-published-range';

type NavaidExclusion = Readonly<{
  sourceRecordId: string;
  reason: NavaidExclusionReason;
}>;

type FacilityVariationAudit = Readonly<{
  sourceRecordId: string;
  outcome: 'outside-source-coverage';
  sourceIdentity: null;
}>;

type ComponentChecksums = Readonly<{
  rawNavaids: string;
  plannerNavaids: string;
  exclusions: string;
  facilityVariationAudits: string;
}>;

type NavaidSnapshotCandidate = Readonly<{
  retrievedAt: string;
  retrievalCompletedAt: string;
  provenance: CandidateProvenance;
  rawNavaids: readonly RawNavaid[];
  plannerNavaids: readonly PlannerNavaid[];
  exclusions: readonly NavaidExclusion[];
  facilityVariationAudits: readonly FacilityVariationAudit[];
  componentChecksums: ComponentChecksums;
  snapshotChecksum: string;
}>;

type BuildCandidateRequest = Readonly<{
  rawNavaids: readonly unknown[];
  provenance: CandidateProvenance;
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
  validateProvenance(request.provenance);
  validateTimestamp(request.retrievedAt, 'retrievedAt');
  validateTimestamp(request.retrievalCompletedAt, 'retrievalCompletedAt');
  if (request.retrievalCompletedAt < request.retrievedAt) {
    throw new Error('retrievalCompletedAt must not precede retrievedAt.');
  }

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
    const derived = deriveNavaid(identified);
    if ('reason' in derived) {
      exclusions.push(derived);
    } else {
      plannerNavaids.push(derived);
      facilityVariationAudits.push({
        sourceRecordId: identified.sourceRecordId,
        outcome: 'outside-source-coverage',
        sourceIdentity: null,
      });
    }
  }

  const componentChecksums = Object.freeze({
    rawNavaids: checksum(canonicalizeJson(rawNavaids)),
    plannerNavaids: checksum(canonicalizeJson(plannerNavaids)),
    exclusions: checksum(canonicalizeJson(exclusions)),
    facilityVariationAudits: checksum(canonicalizeJson(facilityVariationAudits)),
  });
  const snapshotChecksum = checksum(
    canonicalizeJson({
      manifestVersion: 1,
      provenance: request.provenance,
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
    provenance: request.provenance,
    rawNavaids: Object.freeze(rawNavaids),
    plannerNavaids: Object.freeze(plannerNavaids),
    exclusions: Object.freeze(exclusions),
    facilityVariationAudits: Object.freeze(facilityVariationAudits),
    componentChecksums,
    snapshotChecksum,
  });
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

function deriveNavaid(identified: IdentifiedRecord): PlannerNavaid | NavaidExclusion {
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
    magneticDeclinationDegEast: null,
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
  if (value['unit'] !== expectedUnit || !/^\d{3}\.\d{3}$/.test(value['value'])) {
    return undefined;
  }
  const numericValue = Number(value['value']);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }
  return {value: numericValue, unit: expectedUnit === 1 ? 'kHz' : 'MHz'};
}

function rangeFrom(value: unknown): number | undefined {
  if (!isJsonObject(value) || value['unit'] !== 2) {
    return undefined;
  }
  const range = value['value'];
  return typeof range === 'number' && Number.isFinite(range) && range > 0
    ? range
    : undefined;
}

function validateProvenance(provenance: CandidateProvenance): void {
  for (const [name, value] of [
    ['sourceIdentity', provenance.sourceIdentity],
    ['derivationPolicyIdentity', provenance.derivationPolicyIdentity],
    ['matchingPolicyIdentity', provenance.matchingPolicyIdentity],
    ['magneticModel.model', provenance.magneticModel.model],
    ['magneticModel.version', provenance.magneticModel.version],
    ['magneticModel.source', provenance.magneticModel.source],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`${name} must not be empty.`);
    }
  }
  if (
    !Number.isFinite(provenance.magneticModel.epochYear) ||
    provenance.magneticModel.epochYear <= 0
  ) {
    throw new Error('magneticModel.epochYear must be finite and positive.');
  }
  validateChecksum(
    provenance.magneticModel.coefficientChecksum,
    'magneticModel.coefficientChecksum'
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(provenance.magneticModel.referenceDate)) {
    throw new Error('magneticModel.referenceDate must be an ISO date.');
  }
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp.`);
  }
}

function validateChecksum(value: string, name: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase prefixed SHA-256 checksum.`);
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
