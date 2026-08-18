import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import dataReloadOutput from '#radial/cli/formatDataReload.js';

function formatSuccess(status: RadialApplicationTypes['DataStatusSuccess']): string {
  const lines = [
    'Radial data status\n',
    'Database\n',
    `  Path: ${status.databasePath}\n`,
    `  State: ${status.status}\n`,
    `  Producer Schema version: ${formatProducerSchema(status)}\n`,
    `  Planner contract version: ${status.producerSchema?.plannerContractVersion ?? '—'}\n`,
    `  Checksum manifest version: ${status.producerSchema?.checksumManifestVersion ?? '—'}\n`,
  ];

  if (status.legacyObjects.length === 0) {
    lines.push('  Legacy data: —\n');
  } else {
    lines.push('  Legacy data: inactive\n');
    lines.push(`  Inactive legacy objects: ${status.legacyObjects.join(', ')}\n`);
  }

  lines.push('\nNavaid Snapshot\n');
  if (status.snapshot === null) {
    lines.push('  State: uninitialized\n');
  } else {
    lines.push(...formatSnapshot(status.snapshot));
  }

  lines.push('\nCached Airports\n');
  if (status.cachedAirports.length === 0) {
    lines.push('  —\n');
  } else {
    for (const airport of status.cachedAirports) {
      lines.push(
        `  ${airport.icao}\n`,
        `    OpenAIP ID: ${airport.sourceId}\n`,
        `    Name: ${airport.name}\n`,
        `    Coordinates: ${airport.longitude}, ${airport.latitude}\n`,
        `    Source identity: ${airport.sourceIdentity}\n`,
        `    Record checksum: ${airport.recordChecksum}\n`,
        `    Retrieved: ${airport.retrievedAt}\n`,
        `    Published: ${airport.publishedAt}\n`
      );
    }
  }

  return lines.join('');
}

function formatSnapshot(
  snapshot: NonNullable<RadialApplicationTypes['DataStatusSuccess']['snapshot']>
): readonly string[] {
  const lines = [
    `  Snapshot ID: ${snapshot.snapshotId}\n`,
    `  Checksum: ${snapshot.snapshotChecksum}\n`,
    `  Raw Navaids checksum: ${snapshot.componentChecksums.rawNavaids}\n`,
    `  Planner Navaids checksum: ${snapshot.componentChecksums.plannerNavaids}\n`,
    `  Exclusions checksum: ${snapshot.componentChecksums.exclusions}\n`,
    `  Facility Variation audits checksum: ${snapshot.componentChecksums.facilityVariationAudits}\n`,
    `  Retrieval started: ${snapshot.retrievedAt}\n`,
    `  Retrieval completed: ${snapshot.retrievalCompletedAt}\n`,
    `  Published: ${snapshot.publishedAt}\n`,
    `  Source identity: ${snapshot.sourceIdentity}\n`,
    `  Derivation policy: ${snapshot.derivationPolicyIdentity}\n`,
    `  Matching policy: ${snapshot.matchingPolicyIdentity}\n`,
    '\nMagnetic Data\n',
    `  Model: ${snapshot.magneticModel.model} ${snapshot.magneticModel.version}\n`,
    `  Epoch: ${snapshot.magneticModel.epochYear}\n`,
    `  Reference date: ${snapshot.magneticModel.referenceDate}\n`,
    `  Source: ${snapshot.magneticModel.source}\n`,
    `  Coefficient checksum: ${snapshot.magneticModel.coefficientChecksum}\n`,
    '\nFAA NASR\n',
    `  Cycle: ${snapshot.nasr.cycleId}\n`,
    `  Effective date: ${snapshot.nasr.effectiveDate}\n`,
    `  Archive: ${snapshot.nasr.archiveIdentity}\n`,
    `  Archive checksum: ${snapshot.nasr.archiveChecksum}\n`,
    `  Content checksum: ${snapshot.nasr.contentChecksum}\n`,
    `  Retrieved: ${snapshot.nasr.retrievedAt}\n`,
    `  Source: ${snapshot.nasr.sourceUrl}\n`,
    '\nCounts\n',
    `  Raw records: ${snapshot.rawNavaidCount}\n`,
    `  Planner-ready Navaids: ${snapshot.plannerNavaidCount}\n`,
    `  VOR-family Navaids: ${snapshot.vorFamilyNavaidCount}\n`,
    `  Fallback Navaids: ${snapshot.fallbackNavaidCount}\n`,
    `  Excluded records: ${snapshot.exclusionCount}\n`,
    '  Exclusion counts:\n',
    ...formatCounts(snapshot.exclusionCounts),
    '\nFacility Variation of Record\n',
    `  Present: ${snapshot.facilityVariationPresentCount}\n`,
    `  Missing: ${snapshot.facilityVariationMissingCount}\n`,
    `  Epoch Year missing: ${snapshot.facilityVariationEpochYearMissingCount}\n`,
    '  Missing reasons:\n',
    ...formatCounts(snapshot.facilityVariationMissingReasons),
  ];
  return lines;
}

function formatCounts(
  counts: readonly Readonly<{reason: string; count: number}>[]
): string[] {
  return counts.length === 0
    ? ['    —\n']
    : counts.map(({reason, count}) => `    ${reason}: ${count}\n`);
}

function formatProducerSchema(
  status: RadialApplicationTypes['DataStatusSuccess']
): string {
  const schema = status.producerSchema;
  return schema === null
    ? '—'
    : `${schema.producerSchemaVersion}/${schema.plannerContractVersion}/${schema.checksumManifestVersion}`;
}

export default {
  formatFailure: dataReloadOutput.formatFailure,
  formatSuccess,
};
