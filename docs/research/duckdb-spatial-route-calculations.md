# DuckDB Spatial support for route calculations

Research for [Establish DuckDB Spatial support for route calculations](https://github.com/nsdeschenes/radial/issues/5), targeting DuckDB 1.5 and the repository's `@duckdb/node-api` 1.5.5 client.

## Decision

Use DuckDB Spatial for WGS84 point construction, coarse spatial candidate reduction, and exact great-circle distance calculations. Persist each airport and navaid as longitude/latitude numeric columns plus a `GEOMETRY('OGC:CRS84')` point column, and R-tree-index the geometry column. Set `geometry_always_xy = true` explicitly when opening DuckDB 1.5 so every point remains `(longitude, latitude)`.

Use `ST_Distance_Sphere` for the planner's accepted great-circle distance model. It consumes WGS84 points and returns meters. Do **not** use `ST_Azimuth` for flight courses: it is a Cartesian azimuth, not a spherical or ellipsoidal initial bearing. Calculate initial and terminal true courses in TypeScript, along with graph search, deterministic tie-breaking, magnetic adjustments, unit conversion, and output formatting.

Use R-tree filters and DuckDB's spatial join operator only as conservative prefilters. A variable radio-range condition such as `distance(a, b) <= range(a) + range(b)` is not an indexable geodesic join in DuckDB 1.5; exact-check the reduced pair set with `ST_Distance_Sphere` and build the graph in TypeScript.

## Capability boundary

| Need                       | DuckDB 1.5 support                                                                                                                                | Planner decision                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WGS84 point storage        | `GEOMETRY` became a core type in 1.5 and can carry `OGC:CRS84`; Spatial still supplies almost all geometry functions.                             | Persist a typed point for indexing and retain numeric longitude/latitude for geodesic calls.                                                                              |
| Great-circle distance      | `ST_Distance_Sphere` supports points, expects WGS84, and returns meters.                                                                          | Use for edge eligibility and leg length; divide by exactly 1,852 for nautical miles.                                                                                      |
| Ellipsoidal distance       | `ST_Distance_Spheroid` uses GeographicLib's WGS84 inverse solution and returns meters, but is documented as the slowest option.                   | Keep as a validation/reference calculation, not the accepted spherical route metric.                                                                                      |
| Initial/final true course  | `ST_Azimuth` returns a Cartesian angle in radians. DuckDB has no documented geodesic azimuth counterpart.                                         | Implement the spherical initial-bearing formula in TypeScript; compute terminal course from the reverse bearing.                                                          |
| Constant-region filtering  | An R-tree can accelerate supported predicates when one side is a planning-time constant.                                                          | Query one or more constant corridor envelopes, then exact-filter candidates.                                                                                              |
| Pairwise spatial filtering | DuckDB has a `SPATIAL_JOIN` operator that builds a temporary R-tree for a single spatial predicate.                                               | Use a conservative envelope-intersection join only if profiling justifies it; keep additional rules outside the join condition and confirm `SPATIAL_JOIN` with `EXPLAIN`. |
| Range-overlap edge test    | Spheroidal/spherical distance functions exist, but R-tree indexes do not accelerate distance predicates and the exact radius varies by both rows. | Generate conservative candidate pairs first, exact-check their distances in DuckDB, and assemble/search the graph in TypeScript.                                          |

The function behavior above comes from DuckDB's [Spatial function reference](https://duckdb.org/docs/stable/core_extensions/spatial/functions), its [geometry type documentation](https://duckdb.org/docs/current/sql/data_types/geometry), the [R-tree limitations](https://duckdb.org/docs/stable/core_extensions/spatial/r-tree_indexes), and DuckDB's description of the [`SPATIAL_JOIN` operator](https://duckdb.org/2025/08/08/spatial-joins).

## Coordinate and measurement contract

DuckDB 1.5 introduces an important transition in axis handling. The geodetic functions historically interpreted inputs as `(latitude, longitude)`. In 1.5, `SET geometry_always_xy = true` opts into the future behavior, where X is longitude and Y is latitude; leaving the setting implicit emits a warning and creates a version-dependent migration hazard. DuckDB plans to require an explicit choice in 2.0 and make XY the default in 2.1. The planner should therefore execute the setting during database initialization and represent every coordinate as `(longitude, latitude)`. See DuckDB's [1.5 Spatial axis-order announcement](https://duckdb.org/2026/03/09/announcing-duckdb-150).

Recommended representation:

```sql
SET geometry_always_xy = true;

-- Conceptual persisted fields prepared during ingestion/migration:
longitude DOUBLE,
latitude DOUBLE,
point GEOMETRY('OGC:CRS84')

-- Construct the indexable geometry with X=longitude, Y=latitude.
ST_SetCRS(ST_Point(longitude, latitude), 'OGC:CRS84')
```

DuckDB documents `OGC:CRS84` specifically as the global CRS whose X coordinate is longitude and Y coordinate is latitude. CRS metadata protects index/filter operations from accidental mixing, but it does not turn planar functions into geodesic ones; DuckDB's execution engine otherwise treats geometries as Cartesian ([geometry CRS documentation](https://duckdb.org/docs/current/sql/data_types/geometry#coordinate-reference-systems)).

For accepted route distances:

```sql
ST_Distance_Sphere(
  ST_Point2D(origin_longitude, origin_latitude),
  ST_Point2D(target_longitude, target_latitude)
) / 1852.0 AS distance_nm
```

`ST_Distance_Sphere` is a haversine/great-circle calculation and returns meters. `ST_Distance_Spheroid` instead returns an ellipsoidal WGS84 distance in meters through GeographicLib. Planar `ST_Distance`, `ST_DWithin`, and `ST_Buffer` operate in the coordinate system's native units; on unprojected longitude/latitude those units are degrees and must not be interpreted as nautical miles. DuckDB explicitly describes `ST_Buffer` as planar and `ST_Distance` as planar in the [Spatial function reference](https://duckdb.org/docs/stable/core_extensions/spatial/functions).

### Why `ST_Azimuth` is not the course calculation

The function reference says only that `ST_Azimuth` returns a clockwise angle from north, and its example reports 90 degrees for `(0, 0)` to `(0, 1)`. It is not among the geodetic functions called out in the 1.5 axis-order transition. Taken together, those official details show that it operates on the Cartesian point ordinates rather than solving the inverse geodesic problem ([`ST_Azimuth` documentation](https://duckdb.org/docs/stable/core_extensions/spatial/functions#st_azimuth), [1.5 geodetic-function list](https://duckdb.org/2026/03/09/announcing-duckdb-150#breaking-change-flipping-of-axis-order)).

A local probe with the repository's `@duckdb/node-api` 1.5.5-r.3 confirms the distinction: JFK to AMS produces 5,847,599.8 m from `ST_Distance_Sphere`, 5,863,418.7 m from `ST_Distance_Spheroid`, and 81.55 degrees from `ST_Azimuth`; the spherical initial course is about 48.97 degrees. The first two values also match DuckDB's documented JFK/AMS spheroid example.

TypeScript should calculate:

1. Initial true course from origin to destination with the standard spherical `atan2` formula, normalized to `[0, 360)`.
2. Terminal true course by calculating the reverse initial course from destination to origin and adding 180 degrees modulo 360.
3. Magnetic course only where the agreed magnetic-declination input exists; otherwise retain true course and emit the specified warning.

Keeping the bearing formula beside pure unit tests avoids pretending the planar SQL function meets the navigation contract. If the project later changes from a spherical to an ellipsoidal course model, adopt a GeographicLib-compatible TypeScript dependency that returns both forward and reverse azimuths from one inverse solution rather than mixing DuckDB's spheroidal distance with a planar azimuth.

## Candidate reduction and edge generation

### Overall route corridor

Create an R-tree over the persisted navaid point geometry:

```sql
CREATE INDEX IF NOT EXISTS navaids_point_rtree
ON navaids USING RTREE (point);
```

R-tree scans support only `GEOMETRY`, only specific intersection-implying predicates, and only when one predicate argument is a planning-time constant. They do not accelerate `ST_Distance_Sphere`, `ST_Distance_Spheroid`, or `ST_DWithin_Spheroid`. These restrictions are explicit in DuckDB's [R-tree documentation](https://duckdb.org/docs/stable/core_extensions/spatial/r-tree_indexes#what-are-the-limitations-of-r-tree-indexes-in-duckdb).

For each progressive widening pass, TypeScript should generate conservative constant longitude/latitude envelope polygons around the permitted corridor and bind them to a query using `ST_Within(point, constant_envelope)`. Split envelopes that cross the antimeridian. The envelope may return false positives, which are harmless; it must never exclude a point that could satisfy the 1.5-times direct-distance bound. Apply the exact admissibility test afterward:

```text
distance(start, candidate) + distance(candidate, destination)
  <= 1.5 * distance(start, destination)
```

All three distances should use `ST_Distance_Sphere`. A longitude/latitude `ST_Buffer` is not a safe corridor because it is planar and its degree radius varies physically with latitude.

### Airport-to-navaid edges

Use the airport's conservative constant bounding envelope to take advantage of the navaid R-tree, then retain only rows satisfying:

```text
great_circle_distance(airport, navaid) <= navaid_range_nm * 1852
```

The exact comparison can run in DuckDB. Return the measured meters with the candidate so TypeScript does not calculate the edge distance again.

### Navaid-to-navaid edges

The accepted radio handoff rule is:

```text
great_circle_distance(a, b) <= (range_nm(a) + range_nm(b)) * 1852
```

Do not express this as an unrestricted all-pairs self-join. DuckDB's persistent R-tree cannot service a row-vs-row distance predicate, and the specialized spatial join accepts a single spatial predicate rather than a compound variable-distance condition. DuckDB documents that a spatial join creates a temporary R-tree on its smaller side and that extra join conditions force a less efficient strategy ([spatial joins](https://duckdb.org/2025/08/08/spatial-joins#advanced-join-conditions)).

Two implementation options remain correct:

- Preferred initial implementation: return the corridor-filtered navaids to TypeScript, place them in a conservative longitude/latitude grid or spatial index using the maximum eligible service range, enumerate nearby unordered pairs, and send pair batches to DuckDB for exact `ST_Distance_Sphere` measurement. This makes correctness and deterministic graph construction explicit.
- Profile-driven SQL implementation: construct conservative per-navaid coverage envelopes and join on one `ST_Intersects`/`ST_Within` predicate so DuckDB can choose `SPATIAL_JOIN`; apply identifiers, navaid-type rules, and the exact range-sum comparison in a surrounding filter/subquery. Use `EXPLAIN` to assert that `SPATIAL_JOIN` survives query planning. Handle antimeridian envelopes explicitly.

The SQL option is an optimization, not part of the functional contract. Keep the exact distance predicate identical in both paths and benchmark it against the two-second continental-route target before adding its complexity.

## `@duckdb/node-api` initialization and lifecycle

The repository pins `@duckdb/node-api` 1.5.5-r.3. DuckDB's maintained Node client is promise-based and exposes `DuckDBInstance.create`, `instance.connect`, and `connection.run(sql)` ([Node Neo overview](https://duckdb.org/docs/lts/clients/node_neo/overview)). Spatial is not autoloadable, so it must be loaded explicitly ([Spatial extension overview](https://duckdb.org/docs/lts/core_extensions/spatial/overview#installing-and-loading)).

Initialize once per application-owned DuckDB instance, before schema/query preparation:

```ts
const instance = await DuckDBInstance.create(databasePath);
const connection = await instance.connect();

// Provisioning/startup step; INSTALL is idempotent once cached.
await connection.run('INSTALL spatial FROM core');

// Required again whenever a DuckDB process/instance is restarted.
await connection.run('LOAD spatial');
await connection.run('SET geometry_always_xy = true');
```

Installation downloads and caches a version/platform-specific extension binary once; loading dynamically attaches it to each restarted DuckDB instance. Extensions cannot be unloaded or reloaded, and an updated binary requires a process restart. These lifecycle constraints come from DuckDB's [extension overview](https://duckdb.org/docs/stable/extensions/overview#installing-more-extensions), [installation documentation](https://duckdb.org/docs/lts/extensions/installing_extensions#limitations), and [binary compatibility documentation](https://duckdb.org/docs/current/extensions/extension_distribution#binary-compatibility).

Operational consequences:

- Do not run `INSTALL` for each route request. Treat it as application bootstrap or deployment provisioning, then `LOAD` once per created instance.
- A production/container deployment that cannot reach DuckDB's extension repository must install the signed, exact-version/platform binary during the image build or configure a controlled extension directory. DuckDB documents both the cache location and explicit-path installation in its [advanced installation guide](https://duckdb.org/docs/current/extensions/advanced_installation_methods).
- Fail initialization with a specific "Spatial extension unavailable" error rather than discovering the missing functions during route search.
- Keep one application-owned instance for the database file. DuckDB's Node docs warn that multiple instances in one process should not attach the same database and offer `DuckDBInstance.fromCache` when instance sharing is needed ([instance cache](https://duckdb.org/docs/lts/clients/node_neo/overview#instance-cache)).
- Close the connection and then the instance at application disposal. The Node API supports explicit synchronous connection disconnect/close and instance close; relying on garbage collection makes tests and file handles nondeterministic ([disconnect](https://duckdb.org/docs/lts/clients/node_neo/overview#disconnect)).

## TypeScript responsibilities

The required TypeScript supplement is intentionally narrow:

- Normalize and validate ICAO input and map query failures to the agreed error taxonomy.
- Generate antimeridian-safe conservative corridor/search envelopes and manage progressive widening.
- Enumerate candidate pairs when the simple TypeScript spatial-grid path is selected.
- Build the graph and run the deterministic two-pass shortest-path search (VOR family first, mixed VOR/NDB only on failure).
- Apply the 1.5-times route-total bound, leg-count and stable-identifier tie breakers.
- Calculate initial and terminal spherical true courses; apply magnetic declination when present.
- Convert meters to nautical miles, round presentation values, and render plain text/table output.

DuckDB remains the source of airport/navaid rows, eligibility filtering, indexed geographic reduction, and canonical great-circle edge distances. This division avoids duplicating Spatial's strong point calculations while keeping graph semantics and the unsupported navigation-bearing calculation testable in ordinary TypeScript.

## Verification requirements exposed by this research

Add focused integration checks before relying on the SQL plan:

1. Assert `geometry_always_xy = true` using a known asymmetric coordinate pair, so an axis swap fails visibly.
2. Compare `ST_Distance_Sphere` with fixed expected meters and the TypeScript initial-course formula with fixed expected degrees for the same pair.
3. Use `EXPLAIN` to verify `RTREE_INDEX_SCAN` for a constant corridor query.
4. If the SQL pair-prefilter option is adopted, use `EXPLAIN` to verify `SPATIAL_JOIN`; fall back to the TypeScript pair generator if additional predicates prevent it.
5. Cover antimeridian and high-latitude candidates, where naive longitude envelopes are most likely to create false negatives.
6. Benchmark the full candidate-to-edge pipeline, not just the final shortest-path algorithm, against the agreed continental-route target.

## Primary sources

- [DuckDB 1.5.0 announcement: Spatial changes and axis-order transition](https://duckdb.org/2026/03/09/announcing-duckdb-150)
- [DuckDB Spatial function reference](https://duckdb.org/docs/stable/core_extensions/spatial/functions)
- [DuckDB geometry data type and CRS metadata](https://duckdb.org/docs/current/sql/data_types/geometry)
- [DuckDB R-tree indexes](https://duckdb.org/docs/stable/core_extensions/spatial/r-tree_indexes)
- [DuckDB spatial join operator](https://duckdb.org/2025/08/08/spatial-joins)
- [DuckDB Node Neo client](https://duckdb.org/docs/lts/clients/node_neo/overview)
- [DuckDB Spatial extension overview](https://duckdb.org/docs/lts/core_extensions/spatial/overview)
- [DuckDB extension lifecycle](https://duckdb.org/docs/stable/extensions/overview)
- [DuckDB extension installation](https://duckdb.org/docs/lts/extensions/installing_extensions)
- [DuckDB extension distribution and binary compatibility](https://duckdb.org/docs/current/extensions/extension_distribution)
