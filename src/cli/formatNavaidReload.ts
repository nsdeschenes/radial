import type RadialApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import dataReloadOutput from '#radial/cli/formatDataReload.js';

function formatSuccess(success: RadialApplicationTypes['NavaidReloadSuccess']): string {
  const {faaNasr, magneticModel} = success.provenance;
  const exclusionCounts = success.exclusionCounts
    .map(exclusion => `    ${exclusion.reason}: ${exclusion.count}\n`)
    .join('');
  return (
    'Navaid Snapshot replaced\n' +
    `  Snapshot ID: ${success.snapshotId}\n` +
    `  Retrieval started: ${success.retrievedAt}\n` +
    `  Retrieval completed: ${success.retrievalCompletedAt}\n` +
    `  Source: OpenAIP Core API\n` +
    `  Resource: /navaids\n` +
    `  API contract version: 1.1\n` +
    `  Source identity: ${success.provenance.sourceIdentity}\n` +
    `  Derivation policy: ${success.provenance.derivationPolicyIdentity}\n` +
    `  Matching policy: ${success.provenance.matchingPolicyIdentity}\n` +
    `  FAA NASR cycle: ${faaNasr.cycleId}\n` +
    `  FAA NASR effective date: ${faaNasr.effectiveDate}\n` +
    `  FAA NASR published: ${faaNasr.publishedAt}\n` +
    `  FAA NASR archive: ${faaNasr.archiveIdentity}\n` +
    `  FAA NASR archive checksum: ${faaNasr.archiveChecksum}\n` +
    `  FAA NASR content checksum: ${faaNasr.contentChecksum}\n` +
    `  FAA NASR retrieved: ${faaNasr.retrievedAt}\n` +
    `  FAA NASR source: ${faaNasr.sourceUrl}\n` +
    `  Magnetic model: ${magneticModel.model} ${magneticModel.version}\n` +
    `  Magnetic model epoch: ${magneticModel.epochYear}\n` +
    `  Magnetic reference date: ${magneticModel.referenceDate}\n` +
    `  Magnetic model source: ${magneticModel.source}\n` +
    `  Magnetic model checksum: ${magneticModel.coefficientChecksum}\n` +
    `  Checksum: ${success.snapshotChecksum}\n` +
    `  Raw records: ${success.rawNavaidCount}\n` +
    `  VOR-family Navaids: ${success.vorFamilyNavaidCount}\n` +
    `  Fallback Navaids: ${success.fallbackNavaidCount}\n` +
    `  Excluded records: ${success.exclusionCount}\n` +
    exclusionCounts +
    `  Facility Variation of Record present: ${success.facilityVariationPresentCount}\n` +
    `  Facility Variation of Record missing: ${success.facilityVariationMissingCount}\n` +
    `  Facility Variation Epoch Year missing: ${success.facilityVariationEpochYearMissingCount}\n`
  );
}

export default {
  formatFailure: dataReloadOutput.formatFailure,
  formatProgress: dataReloadOutput.formatProgress,
  formatSuccess,
};
