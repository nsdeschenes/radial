# Issue 27 acceptance evidence

The single authoritative real-data record is
`docs/acceptance/route-planner-baseline.json`. All snapshot, Route Plan,
approval, deterministic-output, machine, runtime, and performance values are
read from that record and are intentionally not repeated here.

| Promise                                                                                                                            | Evidence                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The external planner-ready snapshot is checksum-pinned and described completely.                                                   | `RP-SNAPSHOT-PIN`; the authoritative baseline                                                |
| The continental Route Plan is successful, non-empty, deterministic, within its cap, and composed entirely of Navigable Route Legs. | `RP-REAL-SMOKE`; `nub run acceptance:smoke`                                                  |
| A human approved the exact Route Plan for plausibility.                                                                            | The authoritative baseline's approval record                                                 |
| One warm-up and five measured calls satisfy the representative-machine median gate.                                                | `RP-WARM-BENCHMARK`; `nub run acceptance:benchmark`                                          |
| The database remains external while the evidence stays reproducible.                                                               | The authoritative baseline's checksum and provenance; the repository contains no DuckDB file |
| Repository checks and tests pass.                                                                                                  | `nub run check`; `nub run test`                                                              |
