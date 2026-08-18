# Issue 61 acceptance evidence

The release gate is deterministic and hermetic. It runs the real-DuckDB,
application, CLI, Producer Schema, route-planner contract, checksum,
publication, concurrency, and WAL recovery suites together:

```bash
nub run test:acceptance
```

The command never invokes a live source. OpenAIP, FAA, and NOAA behavior is
covered by committed fixtures, the manifest at `fixtures/provenance.json`, and
deterministic injected transports. `fixtureProvenance.test.ts` verifies every
manifest field and recomputes every listed SHA-256 before the rest of the gate
runs.

Fixture refresh is intentionally separate and requires an explicit network
acknowledgement. It prints a stable content diff and does not modify a target
unless `--apply` is supplied:

```bash
nub run acceptance:refresh-fixtures -- --network \
  --url <https-url> --output <fixture-path>
```

Live OpenAIP and FAA compatibility probes are also separate, manual, and
non-gating:

```bash
OPENAIP_API_KEY=<key> nub run acceptance:compatibility
```

The release gate's exact outputs, checksums, invariants, transaction outcomes,
and recovery states remain the acceptance oracles; compatibility probes only
detect upstream contract drift and inform a reviewed fixture refresh.
