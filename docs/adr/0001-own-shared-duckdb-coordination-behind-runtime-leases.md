# Own shared DuckDB coordination behind runtime leases

Radial applications acquire per-application DuckDB runtime leases backed by one registry-owned core for each canonical database identity. The lease exposes operation-shaped application capabilities and owns its child planners; the shared core exclusively owns lazy, retryable instance creation, Navaid FIFO ordering, per-ICAO Airport ordering, publication exclusion, reference counting, and final drain order, so raw DuckDB instances and coordination primitives never cross the runtime seam.

This boundary preserves concurrent reads, concurrent acquisition of different Airports, end-to-end Navaid serialization, and global exclusion between Airport and Navaid publication. Ordinary Airport resolution is deduplicated per lease and ICAO while the FIFO remains shared per ICAO, preventing one lease's credentials or source dependencies from governing another lease's failed attempt.

Disposing a lease stops new top-level work, drains admitted operations and child planners, then releases the shared core. The final release permits downstream coordination created by admitted work, drains all shared queues, closes the coordination primitives and DuckDB instance, and removes the core from the registry; cleanup attempts every stage before reporting one or more disposal failures.

## Considered Options

A generic instance callback was rejected because callers would still choose ordering and publication rules. A single global FIFO was rejected because it would unnecessarily serialize reads and unrelated Airport acquisition, and an instance-keyed publication-gate registry was rejected because it would create a second ownership path outside the runtime.
