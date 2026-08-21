type NavaidFamily =
  | 'NDB'
  | 'VOR'
  | 'VOR-DME'
  | 'VORTAC'
  | 'DVOR'
  | 'DVOR-DME'
  | 'DVORTAC';

export default interface ProducerSchemaNavaidSnapshotCandidate {
  readonly retrievedAt: string;
  readonly retrievalCompletedAt: string;
  readonly provenance: Readonly<{
    sourceIdentity: string;
    derivationPolicyIdentity: string;
    matchingPolicyIdentity: string;
    magneticModel: Readonly<{
      model: string;
      version: string;
      epochYear: number;
      referenceDate: string;
      source: string;
      coefficientChecksum: string;
    }>;
    faaNasr: Readonly<{
      archiveChecksum: string;
      archiveIdentity: string;
      contentChecksum: string;
      cycleId: string;
      effectiveDate: string;
      publishedAt: string;
      retrievedAt: string;
      sourceUrl: string;
    }>;
  }>;
  readonly rawNavaids: readonly Readonly<{
    sourceRecordId: string;
    canonicalRecord: string;
    recordChecksum: string;
  }>[];
  readonly plannerNavaids: readonly Readonly<{
    sourceRecordId: string;
    databaseId: string;
    identifier: string;
    name: string;
    family: NavaidFamily;
    longitude: number;
    latitude: number;
    frequencyValue: number;
    frequencyUnit: 'kHz' | 'MHz';
    publishedRangeNm: number;
    magneticDeclinationDegEast: number | null;
    facilityVariationDegEast: number | null;
    facilityVariationSource: string | null;
    facilityVariationEffectiveDate: string | null;
  }>[];
  readonly exclusions: readonly Readonly<{
    sourceRecordId: string;
    reason:
      | 'missing-stable-identity'
      | 'unsupported-navaid-type'
      | 'invalid-coordinates'
      | 'missing-identifier'
      | 'invalid-frequency'
      | 'invalid-published-range';
  }>[];
  readonly facilityVariationAudits: readonly Readonly<{
    sourceRecordId: string;
    outcome:
      | 'matched'
      | 'outside-source-coverage'
      | 'no-unique-match'
      | 'unusable-source-value';
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
  }>[];
  readonly componentChecksums: Readonly<{
    rawNavaids: string;
    plannerNavaids: string;
    exclusions: string;
    facilityVariationAudits: string;
  }>;
  readonly snapshotChecksum: string;
}
