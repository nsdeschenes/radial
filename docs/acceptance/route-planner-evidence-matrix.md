# Route Planner acceptance-evidence matrix

This is the named acceptance-evidence matrix for the public promises in issue #4.
Automated entries run in the blocking `Deterministic acceptance evidence` CI job.
`RP-REAL-SMOKE`, `RP-WARM-BENCHMARK`, `RP-SNAPSHOT-PIN`, `RP-ARCH-REVIEW`,
and `RP-RELEASE-REVIEW` are the named manual checks defined in
`docs/acceptance/route-planner-release.md`. Percentage coverage is diagnostic and
is not evidence of acceptance.

| Promise                                                        | Evidence                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Plan between two airports                                   | `plans a complete two-leg Route Plan using a VOR-family Navaid from a fresh synthetic database`                                        |
| 2. Trim and case-normalize ICAOs                               | `writes a complete normal Route Plan to stdout and exits 0`; `RP-REAL-SMOKE`                                                           |
| 3. Reject malformed ICAOs                                      | `reports malformed command input on stderr and exits 2`                                                                                |
| 4. Reject identical normalized airports                        | `reports identical normalized airports on stderr and exits 2`                                                                          |
| 5. Identify an unknown endpoint                                | `writes no partial Route Plan for a missing airport lookup failure and exits 1`                                                        |
| 6. Reject ambiguous airport matches                            | `writes no partial Route Plan for an ambiguous airport lookup failure and exits 1`                                                     |
| 7. Operate worldwide                                           | `discovers a VOR-family candidate across the antimeridian`; `RP-REAL-SMOKE`                                                            |
| 8. Admit all six VOR-family types                              | `admits an eligible … facility into a Route Plan using VOR-family Navaids` (six cases)                                                 |
| 9. Exclude standalone DME and TACAN                            | `filters ineligible facilities and never creates an airport-to-airport Route Leg`                                                      |
| 10. Exclude unusable Navaid records                            | `filters ineligible facilities and never creates an airport-to-airport Route Leg`                                                      |
| 11. Enforce airport–Navaid coverage                            | `makes an airport–VOR-family Navaid Route Leg navigable within inclusive published coverage`; `RP-REAL-SMOKE`                          |
| 12. Enforce Navaid–Navaid overlap                              | `makes a Navaid–Navaid Route Leg navigable within their inclusive combined published coverage`; `RP-REAL-SMOKE`                        |
| 13. Include exact coverage boundaries                          | The two inclusive boundary suites in `src/route-planner/internal/coverage.test.ts`                                                     |
| 14. Never create a direct airport leg                          | `filters ineligible facilities and never creates an airport-to-airport Route Leg`; `RP-REAL-SMOKE`                                     |
| 15. Minimize full-precision distance                           | `selects the shorter Route Plan even when it contains more Route Legs`; generated reference-solver suite                               |
| 16. Prefer shorter distance over fewer legs                    | `selects the shorter Route Plan even when it contains more Route Legs`                                                                 |
| 17. Prefer fewer legs on an exact distance tie                 | `uses exact Float64 distance, then Route Leg count, then stable Navaid identity sequence`                                              |
| 18. Resolve remaining ties by stable Navaid identity           | The exact Float64 ordering suite and ten deterministic input permutations                                                              |
| 19. Prefer VOR-family over a shorter NDB route                 | `keeps the completed VOR-family Route Plan when an NDB Route Plan would be shorter`                                                    |
| 20. Admit NDB only after VOR-family exhaustion                 | `returns a successful NDB-fallback Route Plan only after VOR-family exhaustion`                                                        |
| 21. Report Route Search Mode                                   | Normal and degraded exact CLI suites; `RP-REAL-SMOKE`                                                                                  |
| 22. Warn on NDB fallback                                       | `writes a degraded NDB Route Plan to stdout, ordered warnings to stderr, and exits 0`                                                  |
| 23. Enforce the configured distance cap                        | Generated reference-solver suite; `RP-REAL-SMOKE`                                                                                      |
| 24. Default the cap to 1.5                                     | Default configuration cases in `src/route-planner/RoutePlanner.test.ts`                                                                |
| 25. Validate configured route factors                          | `rejects invalid planner configuration as a structured failure`; CLI invalid-factor case                                               |
| 26. Complete discovery beyond a provisional route              | `replaces an early provisional Route Plan after completing its improving ellipse`                                                      |
| 27. Discover across the antimeridian                           | `discovers a VOR-family candidate across the antimeridian`                                                                             |
| 28. Return exhaustive no-route                                 | `exhausts the mixed graph after excluding ineligible facilities`; exact CLI no-route case                                              |
| 29. Report Route Leg nautical miles                            | Complete structured-result and exact formatter suites                                                                                  |
| 30. Retain distinct endpoint true courses                      | `calculates independently worked endpoint courses without rounding`                                                                    |
| 31. Calculate magnetic courses from Local Magnetic Declination | Magnetic-adjustment cases in `src/route-planner/internal/navigation.test.ts`                                                           |
| 32. Calculate VOR Guidance from Facility Variation of Record   | Complete Route Plan and navigation cases documented in `docs/acceptance/issue-23.md`                                                   |
| 33. Omit VOR Guidance for airports and NDBs                    | Complete Route Plan and degraded NDB exact CLI suites                                                                                  |
| 34. Preserve true navigation without magnetic references       | `preserves true-course routing and deterministically warns for unavailable magnetic references`                                        |
| 35. Render unavailable magnetic values and warnings            | Degraded exact CLI suite and warning formatter suite                                                                                   |
| 36. Warn when Facility Variation has no effective date         | Warning-order case documented in `docs/acceptance/issue-23.md`                                                                         |
| 37. Normalize courses and round only for display               | Navigation normalization and complete formatter suites                                                                                 |
| 38. Render the Route Plan summary                              | `renders the complete Route Plan with display-only rounding and calculated alignment`                                                  |
| 39. Wrap long Route Point sequences deterministically          | `wraps long Route Point sequences at 100 characters only between points`                                                               |
| 40. Render one aligned row per Route Leg                       | Complete formatter and exact CLI suites                                                                                                |
| 41. Render Navaid identity, family, frequency, and range       | `renders each used Navaid once with its exact type and conventional frequency unit`                                                    |
| 42. Use conventional frequency units                           | Exact Navaid formatter cases for VOR-family and NDB                                                                                    |
| 43. Calculate totals before display rounding                   | Complete structured-result and display-rounding suites                                                                                 |
| 44. Separate success and warning channels                      | Normal/degraded exact CLI suites; `RP-REAL-SMOKE` hashes channel-preserving CLI evidence                                               |
| 45. Exit 2 with usage for invalid command input                | Argument-count, malformed-ICAO, and identical-airport CLI cases                                                                        |
| 46. Exit 1 without a partial plan for operational failures     | Initialization, lookup, query, contract, and no-route exact CLI cases                                                                  |
| 47. Reuse and asynchronously dispose a planner                 | Route Planner lifecycle suite and application lifecycle suite                                                                          |
| 48. Return presentation-neutral structured outcomes            | Complete public Route Planner result and structured failure suites                                                                     |
| 49. Isolate concurrent read sessions on one snapshot           | `returns independent structured results from concurrent planning calls`; `each planning call observes one committed database snapshot` |
| 50. Drain disposal and reject new work                         | `disposal drains active planning and deterministically rejects later calls`                                                            |
| 51. Enforce strict planner-ready views                         | Route Planner contract suite                                                                                                           |
| 52. Reject incoherent planner metadata and contracts           | Missing, duplicate, partial, type, geometry, and metadata contract cases                                                               |
| 53. Require an all-or-nothing magnetic bundle                  | `requires complete magnetic metadata when any Local Magnetic Declination exists`                                                       |
| 54. Keep Facility Variation provenance separate                | Facility-variation contract and navigation cases in `docs/acceptance/issue-23.md`                                                      |
| 55. Contain database rows at the repository boundary           | `RP-ARCH-REVIEW`; public synthetic-DuckDB suites                                                                                       |
| 56. Ignore database and candidate order                        | Ten-permutation public and pure suites; 1,000-case generated reference-solver suite                                                    |
| 57. Trace every public promise                                 | This matrix, reviewed by `RP-RELEASE-REVIEW`                                                                                           |
| 58. Warm continental median under two seconds                  | `RP-WARM-BENCHMARK`; benchmark acceptance suite verifies one warm-up and five measurements                                             |
| 59. Pin real-data identities and deterministic CLI output      | `RP-REAL-SMOKE`; smoke acceptance suite verifies checksum refusal and repeated output                                                  |
| 60. Keep the real snapshot external and record provenance      | `RP-SNAPSHOT-PIN`; runtime baseline-schema validation                                                                                  |

The generated stress regression is
`keeps the committed synthetic stress corpus Route Plan deterministic`; it fixes
two airports and 148 VOR-family candidates, including a qualifying route and
isolated decoys.
