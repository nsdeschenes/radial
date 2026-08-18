# Route Planner release procedure

The representative planner-ready DuckDB snapshot stays outside version control.
Its single authoritative baseline is a reviewed JSON file accepted by
`src/acceptance/readAcceptanceBaseline.ts`; procedure text must never copy the
baseline's checksum, route, machine, timing, or output values.
The selected baseline is `docs/acceptance/route-planner-baseline.json`.

## Named manual checks

- `RP-SNAPSHOT-PIN`: confirm the external snapshot's source and retrieval time,
  independently calculate its SHA-256, and confirm the baseline contains that
  checksum, planner-view record counts, magnetic reference, and provenance.
- `RP-REAL-SMOKE`: run the checksum-pinned smoke command and review its successful,
  non-empty Route Plan, normalized airports, Route Search Mode, ordered Navaid
  identities, Navigable Route Legs, distance cap, and deterministic CLI checksum.
- `RP-WARM-BENCHMARK`: run the benchmark on the baseline's representative machine
  ID. Review the warm-up, all five measured durations, median, worst duration,
  machine details, and runtime details. Only the recorded representative machine
  ID whose detected machine details also match the baseline is subject to the
  strict under-two-second median gate.
- `RP-ARCH-REVIEW`: confirm the CLI remains a thin adapter and planner database rows
  remain behind the internal repository boundary.
- `RP-RELEASE-REVIEW`: confirm blocking CI is green and review every row of
  `route-planner-evidence-matrix.md`, including the preceding named manual checks.

## Release execution

1. Obtain the external snapshot and its reviewed baseline JSON. Perform
   `RP-SNAPSHOT-PIN` before any planning command. Both release tools independently
   verify the snapshot checksum before opening DuckDB and refuse a mismatch.
2. Run the deterministic synthetic stress regression:

   ```bash
   nub run acceptance:stress
   ```

3. Run `RP-REAL-SMOKE`:

   ```bash
   nub run acceptance:smoke <baseline.json> <planner.duckdb>
   ```

   The CLI checksum preserves channel boundaries by hashing the JSON encoding of
   `{exitCode, stdout, stderr}`. Timings are not part of smoke output.

4. On the representative machine, run `RP-WARM-BENCHMARK` with the machine ID from
   the baseline:

   ```bash
   RADIAL_BENCHMARK_MACHINE_ID=<id> \
     nub run acceptance:benchmark <baseline.json> <planner.duckdb>
   ```

   The command opens one planner, performs one warm-up, then times five sequential
   `planRoute` calls. Each call gets the planner's normal fresh read session. Smoke
   and benchmark both read the same route from the same baseline.

5. Perform `RP-ARCH-REVIEW` and `RP-RELEASE-REVIEW`. Percentage coverage in CI is
   diagnostic; only deterministic tests and repository checks block acceptance.

## Baseline updates

Treat a baseline change as new acceptance evidence, never as an automatic snapshot
refresh.

1. Copy the previous structured baseline to a candidate file. Update its snapshot
   provenance, independently calculated checksum, record counts, magnetic
   reference, normalized endpoints, route factor, Route Search Mode, ordered
   Navaid database IDs and identifiers, reviewer, and approval time.
2. Review one exact CLI run. Update the candidate's CLI checksum only after the
   rendered stdout, stderr, and status are approved. Then run `RP-REAL-SMOKE` twice
   through the command above.
3. Run the benchmark on the intended representative machine. Copy the emitted
   machine/runtime details, five measured samples, median, and worst duration into
   the candidate baseline. Confirm the stored median and worst values agree with
   the samples.
4. Rerun smoke and benchmark against the candidate, complete the matrix review,
   and commit only the structured baseline. Never commit the DuckDB snapshot.

No release is accepted when its designated baseline is absent, has not been
human-approved, or fails runtime schema validation.
