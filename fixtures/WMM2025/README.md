# WMM2025 fixture provenance

Radial embeds the official degree-and-order 12 WMM2025 coefficients in
`src/data-producer/internal/Wmm2025.ts`. The production model and its tests use
the same pinned NOAA release; routine tests never contact NOAA.

## Coefficients

- Source identity: NOAA NCEI and British Geological Survey, World Magnetic
  Model 2025, DOI `10.25921/aqfd-sd83`
- Source URL:
  `https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip`
- Retrieved: 2026-08-17
- Archive SHA-256:
  `2e76569370d081f2cd7919490218bd094ca9afde347b198eff5621e0af460d03`
- Embedded `WMM.COF` SHA-256:
  `dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f`
- Extraction policy: `radial:wmm2025-coefficients:v1` embeds the header, all 90
  coefficient rows, and terminators without changing numeric text. Runtime
  parsing accepts exactly six finite numeric fields per coefficient and exactly
  90 coefficient rows.

## Golden vectors

- Source URL:
  `https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025_TEST_VALUES.txt`
- Retrieved: 2026-08-17
- SHA-256:
  `ae289c94e2200e4deeae2dfdedf543a8a0e93096512b30d6a754199731f570d0`
- Extraction policy: `radial:wmm2025-test-vectors:v1` selects declination
  results at zero-kilometre WGS84 ellipsoid height across northern, equatorial,
  and southern locations and both published epochs. Longitude 240 degrees is
  represented by its equivalent normalized longitude, -120 degrees.

NOAA states that the WMM source code is public domain. The coefficients and
test values are U.S. Government material and are retained only to reproduce and
verify the published model.
