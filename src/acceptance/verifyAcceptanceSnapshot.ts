import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

import readAcceptanceBaseline from '#radial/acceptance/readAcceptanceBaseline.js';

async function verifyAcceptanceSnapshot(baselinePath: string, snapshotPath: string) {
  const baseline = await readAcceptanceBaseline(baselinePath);
  const snapshotHash = createHash('sha256');
  for await (const chunk of createReadStream(snapshotPath)) {
    snapshotHash.update(chunk);
  }
  const snapshotSha256 = snapshotHash.digest('hex');

  if (snapshotSha256 !== baseline.snapshot.sha256) {
    throw new Error(
      `Snapshot checksum mismatch: expected ${baseline.snapshot.sha256}, received ${snapshotSha256}.`
    );
  }

  return {baseline, snapshotSha256};
}

export default verifyAcceptanceSnapshot;
