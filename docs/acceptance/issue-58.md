# Issue 58 acceptance evidence

The `radial data status` command is local and read-only. It never creates or
migrates Producer Schema objects and does not require credentials or network
access.

## Output order

Successful output always uses this section and field order:

1. `Database`: path, readiness state, Producer Schema versions, then inactive
   legacy objects.
2. `Navaid Snapshot`: active identity, snapshot and component checksums,
   retrieval/publication provenance, source and policy identities.
3. `Magnetic Data`: model, epoch, reference date, source, and coefficient
   checksum.
4. `FAA NASR`: cycle, effective date, archive identity and checksums,
   retrieval time, and source URL.
5. `Counts`: raw, planner-ready, VOR-family, Fallback, excluded, and sorted
   exclusion-reason counts.
6. `Facility Variation of Record`: present, missing, missing-reason counts,
   and missing epoch-year counts.
7. `Cached Airports`: sorted by ICAO, with source identity, location,
   checksum, retrieval, and publication fields.

Unavailable optional values use an em dash. Repeated reason fields are sorted
lexically. Timestamps are rendered as UTC ISO-8601 values.

## Evidence

| Promise                                                                                                        | Automated evidence                                                                                                                       | Implementation evidence                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A nonexistent database is reported as uninitialized without creating a file or adjacent artifacts.             | `reports a missing database as uninitialized without creating a file or artifacts`; the equivalent CLI case in `src/cli/runCli.test.ts`  | `src/data-producer/internal/DataStatus.ts` checks existence before opening DuckDB and uses read-only access for existing files. |
| Legacy-only storage is inactive and uninitialized, while malformed Producer Schema state is invalid.           | `reports legacy-only storage as inactive and uninitialized`; `distinguishes an invalid Producer Schema from ordinary uninitialized data` | `ProducerSchema.inspect` classifies the schema without initialization or migration.                                             |
| Ready status reports snapshot, provenance, checksums, counts, Facility Variation reasons, and Cached Airports. | `reports the active snapshot provenance, counts, and Facility Variation reasons`; the inactive Cached Airport case                       | `src/data-producer/internal/DataStatus.ts`; `src/cli/formatDataStatus.ts`.                                                      |
| Command help and unsupported options have deterministic, script-safe behavior.                                 | `provides data status help and rejects unsupported options`                                                                              | `src/cli/runCli.ts`.                                                                                                            |
| Repository checks and tests pass.                                                                              | `nub run check`; `nub run test`                                                                                                          | CI/release check.                                                                                                               |
