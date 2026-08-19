import {createHash} from 'node:crypto';

import canonicalizeJson from '#radial/data-producer/internal/CanonicalJson.js';

const FACILITY_VARIATION_MAGNITUDE_PATTERN = /^\d{1,2}(?:\.\d+)?$/;
const FOUR_DIGIT_VALUE_PATTERN = /^\d{4}$/;
const DECIMAL_FREQUENCY_PATTERN = /^(\d{1,3})(?:\.(\d{1,6}))?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;

type JsonObject = Readonly<Record<string, unknown>>;

type FAANasrCycleArtifact = Readonly<{
  archiveBytes: Uint8Array;
  archiveChecksum: string;
  archiveIdentity: string;
  contentChecksum: string;
  cycleId: string;
  effectiveDate: string;
  publishedAt: string;
  records: readonly JsonObject[];
  retrievedAt: string;
  sourceUrl: string;
}>;

type VerifiedFAANasrCycle = Omit<FAANasrCycleArtifact, 'archiveBytes'>;

type MatchableOpenAIPNavaid = Readonly<{
  country: string | readonly string[] | undefined;
  family: 'VOR' | 'VOR-DME' | 'VORTAC' | 'DVOR' | 'DVOR-DME' | 'DVORTAC';
  frequencyUnit: 'MHz';
  frequencyValue: number;
  identifier: string;
  latitude: number;
  longitude: number;
  sourceRecordId: string;
}>;

type FacilityVariation = Readonly<{
  degreesEast: number;
  epochYear: number;
  source: string;
}>;

type FacilityVariationOutcome =
  | 'matched'
  | 'outside-source-coverage'
  | 'no-unique-match'
  | 'unusable-source-value';

type FacilityVariationAudit = Readonly<{
  sourceRecordId: string;
  outcome: FacilityVariationOutcome;
  sourceIdentity: string | null;
  nasrSourceUrl: string;
  nasrRetrievedAt: string;
  nasrArchiveIdentity: string;
  nasrArchiveChecksum: string;
  nasrContentChecksum: string;
  nasrCycleId: string;
  nasrEffectiveDate: string;
  faaRecordIdentity: string | null;
  faaFacilityIdentifier: string | null;
  faaFacilityType: string | null;
  faaLongitude: number | null;
  faaLatitude: number | null;
  faaFrequencyHz: number | null;
  rawMagneticVariation: string | null;
  rawMagneticVariationHemisphere: string | null;
  rawMagneticVariationEpochYear: string | null;
  facilityVariationDegEast: number | null;
  facilityVariationEpochYear: number | null;
  openAipIdentifier: string;
  openAipLongitude: number;
  openAipLatitude: number;
  openAipFrequencyHz: number;
  separationNm: number | null;
  matchingPolicyIdentity: string;
}>;

type MatchResult = Readonly<{
  facilityVariation: FacilityVariation | null;
  audit: FacilityVariationAudit;
}>;

const VINCENTY_NUMERICAL_ERROR_METERS = 0.001;

function selectApplicableCycle(
  cycles: readonly FAANasrCycleArtifact[],
  retrievalStartedAt: string
): VerifiedFAANasrCycle {
  validateTimestamp(retrievalStartedAt, 'retrievalStartedAt');
  const retrievalDate = retrievalStartedAt.slice(0, 10);
  const applicable = cycles
    .map(validateCycleMetadata)
    .filter(
      cycle =>
        cycle.effectiveDate <= retrievalDate && cycle.publishedAt <= retrievalStartedAt
    )
    .toSorted((left, right) => compareStrings(left.effectiveDate, right.effectiveDate));
  const selected = applicable.at(-1);

  if (selected === undefined) {
    throw new Error('no published FAA 28-Day NASR cycle is effective by retrieval start');
  }

  if (
    applicable.filter(cycle => cycle.effectiveDate === selected.effectiveDate).length !==
    1
  ) {
    throw new Error('FAA NASR cycle metadata contains a duplicate effective date');
  }

  verifySelectedCycle(selected);
  const {archiveBytes: _, ...verified} = selected;
  return Object.freeze(verified);
}

function match(
  navaid: MatchableOpenAIPNavaid,
  cycle: VerifiedFAANasrCycle,
  matchingPolicyIdentity: string
): MatchResult {
  if (matchingPolicyIdentity.trim() === '') {
    throw new Error('Facility Variation matching policy identity must not be empty');
  }

  const openAipFrequencyHz = decimalFrequencyHz(navaid.frequencyValue.toFixed(6));
  if (openAipFrequencyHz === undefined) {
    throw new Error('OpenAIP VOR-family frequency cannot be normalized exactly');
  }

  const baseAudit = {
    sourceRecordId: navaid.sourceRecordId,
    sourceIdentity: null,
    nasrSourceUrl: cycle.sourceUrl,
    nasrRetrievedAt: cycle.retrievedAt,
    nasrArchiveIdentity: cycle.archiveIdentity,
    nasrArchiveChecksum: cycle.archiveChecksum,
    nasrContentChecksum: cycle.contentChecksum,
    nasrCycleId: cycle.cycleId,
    nasrEffectiveDate: cycle.effectiveDate,
    faaRecordIdentity: null,
    faaFacilityIdentifier: null,
    faaFacilityType: null,
    faaLongitude: null,
    faaLatitude: null,
    faaFrequencyHz: null,
    rawMagneticVariation: null,
    rawMagneticVariationHemisphere: null,
    rawMagneticVariationEpochYear: null,
    facilityVariationDegEast: null,
    facilityVariationEpochYear: null,
    openAipIdentifier: normalizeIdentifier(navaid.identifier),
    openAipLongitude: navaid.longitude,
    openAipLatitude: navaid.latitude,
    openAipFrequencyHz,
    separationNm: null,
    matchingPolicyIdentity,
  } as const;

  if (isOutsideSourceCoverage(navaid.country, cycle.records)) {
    return {
      facilityVariation: null,
      audit: {...baseAudit, outcome: 'outside-source-coverage'},
    };
  }

  const candidates = cycle.records
    .map(record => qualifyingRecord(record, navaid, openAipFrequencyHz))
    .filter(candidate => candidate !== undefined)
    .toSorted((left, right) => compareStrings(left.recordIdentity, right.recordIdentity));
  if (candidates.length !== 1) {
    return {
      facilityVariation: null,
      audit: {...baseAudit, outcome: 'no-unique-match'},
    };
  }

  const candidate = candidates[0]!;
  const sourceDetails = {
    faaRecordIdentity: candidate.recordIdentity,
    faaFacilityIdentifier: candidate.identifier,
    faaFacilityType: candidate.facilityType,
    faaLongitude: candidate.longitude,
    faaLatitude: candidate.latitude,
    faaFrequencyHz: candidate.frequencyHz,
    rawMagneticVariation: stringOrNull(candidate.record['MAG_VARN']),
    rawMagneticVariationHemisphere: stringOrNull(candidate.record['MAG_VARN_HEMIS']),
    rawMagneticVariationEpochYear: stringOrNull(candidate.record['MAG_VARN_YEAR']),
    separationNm: candidate.separationNm,
  } as const;
  const parsedVariation = parseFacilityVariation(candidate.record);
  if (parsedVariation === undefined) {
    return {
      facilityVariation: null,
      audit: {
        ...baseAudit,
        ...sourceDetails,
        outcome: 'unusable-source-value',
      },
    };
  }

  const source = `FAA 28-Day NASR ${cycle.cycleId}`;
  return {
    facilityVariation: {...parsedVariation, source},
    audit: {
      ...baseAudit,
      ...sourceDetails,
      outcome: 'matched',
      sourceIdentity: source,
      facilityVariationDegEast: parsedVariation.degreesEast,
      facilityVariationEpochYear: parsedVariation.epochYear,
    },
  };
}

type QualifyingRecord = Readonly<{
  record: JsonObject;
  recordIdentity: string;
  identifier: string;
  facilityType: string;
  longitude: number;
  latitude: number;
  frequencyHz: number;
  separationNm: number;
}>;

function qualifyingRecord(
  record: JsonObject,
  navaid: MatchableOpenAIPNavaid,
  openAipFrequencyHz: number
): QualifyingRecord | undefined {
  const facilityType = stringOrNull(record['NAV_TYPE'])?.trim().toUpperCase();
  if (!isMatchableFacilityType(facilityType)) {
    return undefined;
  }

  const identifier = normalizeIdentifier(stringOrNull(record['NAV_ID']) ?? '');
  const frequencyHz = decimalFrequencyHz(stringOrNull(record['FREQ']) ?? '');
  const latitude = finiteCoordinate(record['LAT_DECIMAL'], -90, 90);
  const longitude = finiteCoordinate(record['LONG_DECIMAL'], -180, 180);
  if (
    identifier !== normalizeIdentifier(navaid.identifier) ||
    frequencyHz !== openAipFrequencyHz ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return undefined;
  }

  const separationMeters = wgs84DistanceMeters(
    {latitude: navaid.latitude, longitude: navaid.longitude},
    {latitude, longitude}
  );
  if (separationMeters > 1852 + VINCENTY_NUMERICAL_ERROR_METERS) {
    return undefined;
  }

  const separationNm = separationMeters / 1852;
  return {
    record,
    recordIdentity: textChecksum(canonicalizeJson(record)),
    identifier,
    facilityType: facilityType!,
    longitude,
    latitude,
    frequencyHz,
    separationNm,
  };
}

function parseFacilityVariation(
  record: JsonObject
): {degreesEast: number; epochYear: number} | undefined {
  const rawMagnitude = stringOrNull(record['MAG_VARN']);
  const hemisphere = stringOrNull(record['MAG_VARN_HEMIS'])?.trim().toUpperCase();
  const rawEpochYear = stringOrNull(record['MAG_VARN_YEAR']);
  if (
    rawMagnitude === null ||
    !FACILITY_VARIATION_MAGNITUDE_PATTERN.test(rawMagnitude.trim()) ||
    (hemisphere !== 'E' && hemisphere !== 'W') ||
    rawEpochYear === null ||
    !FOUR_DIGIT_VALUE_PATTERN.test(rawEpochYear.trim())
  ) {
    return undefined;
  }

  const magnitude = Number(rawMagnitude);
  const epochYear = Number(rawEpochYear);
  const degreesEast = hemisphere === 'W' ? -magnitude : magnitude;
  if (
    !Number.isFinite(degreesEast) ||
    degreesEast < -180 ||
    degreesEast >= 180 ||
    !Number.isSafeInteger(epochYear) ||
    epochYear <= 0
  ) {
    return undefined;
  }

  return {degreesEast: Object.is(degreesEast, -0) ? 0 : degreesEast, epochYear};
}

function decimalFrequencyHz(value: string): number | undefined {
  const match = DECIMAL_FREQUENCY_PATTERN.exec(value.trim());
  if (match === null) {
    return undefined;
  }

  const hertz = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(hertz) && hertz > 0 ? hertz : undefined;
}

function finiteCoordinate(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : undefined;
}

function isOutsideSourceCoverage(
  country: MatchableOpenAIPNavaid['country'],
  records: readonly JsonObject[]
): boolean {
  const navaidCountryCodes =
    typeof country === 'string' ? [country] : Array.isArray(country) ? country : [];
  if (navaidCountryCodes.length === 0) {
    return false;
  }

  const coveredCountryCodes = new Set(
    records.map(record => {
      const countryCode = stringOrNull(record['COUNTRY_CODE'])?.trim().toUpperCase();
      return countryCode === undefined || countryCode === '' ? 'US' : countryCode;
    })
  );
  return !navaidCountryCodes.some(countryCode =>
    coveredCountryCodes.has(countryCode.trim().toUpperCase())
  );
}

function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase();
}

function isMatchableFacilityType(value: string | undefined): boolean {
  return ['VOR', 'VOR/DME', 'VORTAC'].includes(value ?? '');
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function wgs84DistanceMeters(
  first: Readonly<{latitude: number; longitude: number}>,
  second: Readonly<{latitude: number; longitude: number}>
): number {
  const semiMajorAxis = 6_378_137;
  const flattening = 1 / 298.257_223_563;
  const semiMinorAxis = (1 - flattening) * semiMajorAxis;
  const firstReducedLatitude = Math.atan(
    (1 - flattening) * Math.tan((first.latitude * Math.PI) / 180)
  );
  const secondReducedLatitude = Math.atan(
    (1 - flattening) * Math.tan((second.latitude * Math.PI) / 180)
  );
  const longitudeDifference = ((second.longitude - first.longitude) * Math.PI) / 180;
  let lambda = longitudeDifference;
  let previousLambda = Number.POSITIVE_INFINITY;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSquaredAlpha = 0;
  let cosDoubleSigmaMidpoint = 0;

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const firstTerm = Math.cos(secondReducedLatitude) * sinLambda;
    const secondTerm =
      Math.cos(firstReducedLatitude) * Math.sin(secondReducedLatitude) -
      Math.sin(firstReducedLatitude) * Math.cos(secondReducedLatitude) * cosLambda;
    sinSigma = Math.hypot(firstTerm, secondTerm);
    if (sinSigma === 0) {
      return 0;
    }

    cosSigma =
      Math.sin(firstReducedLatitude) * Math.sin(secondReducedLatitude) +
      Math.cos(firstReducedLatitude) * Math.cos(secondReducedLatitude) * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha =
      (Math.cos(firstReducedLatitude) * Math.cos(secondReducedLatitude) * sinLambda) /
      sinSigma;
    cosSquaredAlpha = 1 - sinAlpha * sinAlpha;
    cosDoubleSigmaMidpoint =
      cosSquaredAlpha === 0
        ? 0
        : cosSigma -
          (2 * Math.sin(firstReducedLatitude) * Math.sin(secondReducedLatitude)) /
            cosSquaredAlpha;
    const coefficient =
      (flattening / 16) * cosSquaredAlpha * (4 + flattening * (4 - 3 * cosSquaredAlpha));
    previousLambda = lambda;
    lambda =
      longitudeDifference +
      (1 - coefficient) *
        flattening *
        sinAlpha *
        (sigma +
          coefficient *
            sinSigma *
            (cosDoubleSigmaMidpoint +
              coefficient *
                cosSigma *
                (-1 + 2 * cosDoubleSigmaMidpoint * cosDoubleSigmaMidpoint)));
    if (Math.abs(lambda - previousLambda) <= 1e-12) {
      break;
    }

    if (iteration === 199) {
      return Number.POSITIVE_INFINITY;
    }
  }

  const squaredU =
    (cosSquaredAlpha * (semiMajorAxis * semiMajorAxis - semiMinorAxis * semiMinorAxis)) /
    (semiMinorAxis * semiMinorAxis);
  const coefficientA =
    1 +
    (squaredU / 16_384) * (4096 + squaredU * (-768 + squaredU * (320 - 175 * squaredU)));
  const coefficientB =
    (squaredU / 1024) * (256 + squaredU * (-128 + squaredU * (74 - 47 * squaredU)));
  const deltaSigma =
    coefficientB *
    sinSigma *
    (cosDoubleSigmaMidpoint +
      (coefficientB / 4) *
        (cosSigma * (-1 + 2 * cosDoubleSigmaMidpoint * cosDoubleSigmaMidpoint) -
          (coefficientB / 6) *
            cosDoubleSigmaMidpoint *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cosDoubleSigmaMidpoint * cosDoubleSigmaMidpoint)));
  return semiMinorAxis * coefficientA * (sigma - deltaSigma);
}

function validateCycleMetadata(cycle: FAANasrCycleArtifact): FAANasrCycleArtifact {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(cycle.sourceUrl);
  } catch {
    throw new Error('FAA NASR source URL must use the official HTTPS origin');
  }

  if (
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname !== 'nfdc.faa.gov' ||
    !sourceUrl.pathname.startsWith('/webContent/28DaySub/')
  ) {
    throw new Error('FAA NASR source URL must use the official HTTPS origin');
  }

  if (!FOUR_DIGIT_VALUE_PATTERN.test(cycle.cycleId)) {
    throw new Error('FAA NASR cycle identity must use the four-digit AIRAC cycle');
  }

  if (cycle.archiveIdentity.trim() === '') {
    throw new Error('FAA NASR archive identity must not be empty');
  }

  if (sourceUrl.pathname.split('/').at(-1) !== cycle.archiveIdentity) {
    throw new Error('FAA NASR archive identity does not match its official URL');
  }

  validateDate(cycle.effectiveDate, 'FAA NASR effectiveDate');
  validateTimestamp(cycle.publishedAt, 'FAA NASR publishedAt');
  validateTimestamp(cycle.retrievedAt, 'FAA NASR retrievedAt');
  validateChecksum(cycle.archiveChecksum, 'FAA NASR archiveChecksum');
  validateChecksum(cycle.contentChecksum, 'FAA NASR contentChecksum');
  return cycle;
}

function verifySelectedCycle(cycle: FAANasrCycleArtifact): void {
  if (bytesChecksum(cycle.archiveBytes) !== cycle.archiveChecksum) {
    throw new Error('FAA NASR archive checksum does not match its content');
  }

  if (cycle.records.length === 0) {
    throw new Error('FAA NASR selected cycle contains no NAV_BASE records');
  }

  const canonicalRecords = cycle.records
    .map(record => canonicalizeJson(record))
    .toSorted(compareStrings)
    .map(record => JSON.parse(record) as JsonObject);
  if (textChecksum(canonicalizeJson(canonicalRecords)) !== cycle.contentChecksum) {
    throw new Error('FAA NASR canonical content checksum does not match its records');
  }

  for (const [index, record] of canonicalRecords.entries()) {
    validateRecordStructure(record, index, cycle.effectiveDate);
  }
}

function validateRecordStructure(
  record: JsonObject,
  index: number,
  effectiveDate: string
): void {
  for (const field of [
    'NAV_ID',
    'NAV_TYPE',
    'EFF_DATE',
    'LAT_DECIMAL',
    'LONG_DECIMAL',
    'FREQ',
  ]) {
    if (typeof record[field] !== 'string') {
      throw new Error(`FAA NASR NAV_BASE record ${index + 1} has invalid ${field}`);
    }
  }

  if (record['EFF_DATE'] !== effectiveDate) {
    throw new Error(
      `FAA NASR NAV_BASE record ${index + 1} effective date does not match its cycle`
    );
  }

  const facilityType = String(record['NAV_TYPE']).trim().toUpperCase();
  if (
    String(record['NAV_ID']).trim() === '' ||
    String(record['NAV_TYPE']).trim() === '' ||
    (isMatchableFacilityType(facilityType) &&
      decimalFrequencyHz(String(record['FREQ'])) === undefined) ||
    finiteCoordinate(record['LAT_DECIMAL'], -90, 90) === undefined ||
    finiteCoordinate(record['LONG_DECIMAL'], -180, 180) === undefined
  ) {
    throw new Error(`FAA NASR NAV_BASE record ${index + 1} has incompatible content`);
  }
}

function validateDate(value: string, name: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !ISO_DATE_PATTERN.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be an ISO date`);
  }
}

function validateTimestamp(value: string, name: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
}

function validateChecksum(value: string, name: string): void {
  if (!SHA256_CHECKSUM_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase prefixed SHA-256 checksum`);
  }
}

function bytesChecksum(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function textChecksum(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export default {match, selectApplicableCycle};
