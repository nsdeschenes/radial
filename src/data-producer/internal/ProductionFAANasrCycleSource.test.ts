import {readFile} from 'node:fs/promises';

import {zipSync} from 'fflate';
import {afterEach, expect, test, vi} from 'vitest';

import acquireProductionFAANasrCycle from '#radial/data-producer/internal/ProductionFAANasrCycleSource.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('acquires and parses the applicable official FAA NAV CSV cycle', async () => {
  const csv = await readFile(
    new URL('../../../fixtures/FAA/2607-NAV_BASE.csv', import.meta.url),
    'utf8'
  );
  const archiveBytes = zipSync({'NAV_BASE.csv': new TextEncoder().encode(csv)});
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {status: 503, headers: {'retry-after': '0'}})
    )
    .mockResolvedValueOnce(
      new Response(archiveBytes, {
        status: 200,
        headers: {'last-modified': 'Thu, 25 Jun 2026 13:54:24 GMT'},
      })
    );
  vi.stubGlobal('fetch', fetch);

  const cycles = await acquireProductionFAANasrCycle('2026-07-10T12:00:00.000Z');

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith(
    'https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_NAV_CSV.zip',
    expect.objectContaining({
      headers: {accept: 'application/zip'},
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
  );
  expect(cycles).toHaveLength(1);
  expect(cycles[0]).toMatchObject({
    archiveIdentity: '09_Jul_2026_NAV_CSV.zip',
    cycleId: '2607',
    effectiveDate: '2026-07-09',
    publishedAt: '2026-06-25T13:54:24.000Z',
    sourceUrl: 'https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_NAV_CSV.zip',
    records: [
      {
        EFF_DATE: '2026-07-09',
        NAV_ID: 'YYZ',
        NAV_TYPE: 'VOR/DME',
        LAT_DECIMAL: '43.6589',
        LONG_DECIMAL: '-79.6139',
        FREQ: '112.150',
      },
    ],
  });
  expect(cycles[0]?.archiveChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(cycles[0]?.contentChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
});
