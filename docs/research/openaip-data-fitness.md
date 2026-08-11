# OpenAIP data fitness for route planning

Research date: 2026-08-11

## Decision

OpenAIP is fit to supply route-planning candidates only behind a stricter local
database contract. Its response schemas constrain planner fields when they are
present, but do not require those fields and do not promise uniqueness for ICAO
codes or navaid identifiers. The planner must therefore fail ambiguous airport
lookups, key navaid graph nodes by OpenAIP `_id`, and exclude navaids that do not
have a valid point, eligible type, identifier, type-appropriate frequency, and
positive range. Magnetic declination must be nullable and normalized by the data
layer before the planner uses it.

This is a geometric route-planning policy, not a claim that a published range is
an operational service-volume guarantee.

## Evidence

### The API contract makes planner fields optional

The official OpenAIP Core API specification identifies separate airport and
navaid response schemas. Neither response schema declares a top-level `required`
array. Consequently `_id`, `icaoCode`, `geometry`, navaid `type`, `identifier`,
`frequency`, `range`, and `magneticDeclination` are all optional at the API
contract boundary, even when their nested values are constrained if present
([Core API specification](https://api.core.openaip.net/api/system/specs/v1/schema.json),
[airport response schema](https://api.core.openaip.net/api/schemas/response/airport/airport-schema.json),
[navaid response schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json)).

The repository mirrors this accurately: each relevant property is optional in
the [airport Zod schema](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/src/clients/OpenAIP/schemas/OpenAIPAirportSchema.ts)
and [navaid Zod schema](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/src/clients/OpenAIP/schemas/OpenAIPNavaidSchema.ts).
The representative [airport fixture](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/fixtures/OpenAIP/success/airports.json)
and [navaid fixture](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/fixtures/OpenAIP/success/navaids.json)
contain the core lookup and routing fields, but both omit magnetic declination.
Fixtures prove supported shapes, not population-wide completeness.

### Airport ICAO codes are formatted, not guaranteed unique

OpenAIP constrains `icaoCode` to four uppercase letters, but its schema contains
no uniqueness assertion. Its airport-list `search` parameter is case-insensitive
and searches name, ICAO, IATA, and alternate identifier together; it is not an
exact ICAO lookup contract ([Core API specification](https://api.core.openaip.net/api/system/specs/v1/schema.json)).
The local `airports` table makes only `_id` a primary key and has no unique
constraint on `icaoCode`
([DuckDB table definition](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/src/db/duckdb/createDuckDBTables.ts)).

Planner policy:

- Normalize user input to uppercase and require `^[A-Z]{4}$`.
- Query with exact equality on normalized `icaoCode`, never the API's broad
  search semantics.
- Return “airport not found” for zero usable rows and an explicit “ambiguous
  ICAO” data error for more than one usable row. Do not choose by name, country,
  freshness, or row order.
- Preserve OpenAIP `_id` as the record identity. Add a non-unique index on
  normalized ICAO for lookup performance, but do not add a unique constraint
  unless ingestion separately proves and enforces that invariant.

### Coordinates are valid GeoJSON positions only when present

Both official schemas describe `geometry` as a GeoJSON `Point` with exactly two
numeric coordinates: longitude in `[-180, 180]` followed by latitude in
`[-90, 90]`. GeoJSON defines a position's first two elements as longitude and
latitude in that order ([RFC 7946, section 3.1.1](https://www.rfc-editor.org/rfc/rfc7946#section-3.1.1)).
The official field is still optional. The local Zod schemas only enforce an
array of two unknown values, while DuckDB stores `DOUBLE[2]`; therefore the
current application validation is weaker than the upstream response contract.

Planner policy:

- Require `geometry.type = 'Point'`, exactly two finite numeric values, and
  valid longitude/latitude bounds before constructing spatial geometry.
- Reject an airport with missing or invalid coordinates as “unusable airport
  coordinates.” Exclude a navaid with invalid coordinates from the graph and
  report “missing eligible navaid data” if none remain.
- Construct DuckDB points explicitly as `ST_Point(longitude, latitude)`; never
  swap the array order.

### Navaid types are stable integer categories

The official navaid schema defines `0` DME, `1` TACAN, `2` NDB, `3` VOR, `4`
VOR-DME, `5` VORTAC, `6` DVOR, `7` DVOR-DME, and `8` DVORTAC
([navaid response schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json)).

Planner policy:

- VOR-family pass: types `3, 4, 5, 6, 7, 8`.
- Mixed fallback pass: the VOR-family plus type `2` NDB.
- Exclude standalone DME (`0`) and TACAN (`1`). Unknown future type values are
  ineligible until deliberately mapped.

### Identifiers are display labels, not graph identities

The official navaid `identifier` is optional and accepts an uppercase
alphanumeric prefix. The pattern is not an assertion of global uniqueness and
does not supply a uniqueness scope. The local `navaids` table likewise makes
only `_id` unique
([navaid response schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json),
[DuckDB table definition](https://github.com/nsdeschenes/radial/blob/55359097843611796b1dc3d9eccfca09e06a5686/src/db/duckdb/createDuckDBTables.ts)).

Planner policy:

- Require a non-empty identifier matching `^[A-Z0-9]+$` after trimming and
  uppercasing; otherwise exclude the navaid.
- Key nodes and reconstruct paths by `_id`, not identifier.
- Use `(identifier, _id)` as the final deterministic tie-break key so duplicate
  identifiers cannot make output unstable.
- Treat `name` as optional presentation data and print an em dash when absent.

### Frequency is typed, but type/unit compatibility is not enforced

When present, frequency contains a `ddd.ddd` string and unit code `1` for kHz or
`2` for MHz. The official schema permits either unit for every navaid type; it
does not cross-validate NDB versus VOR-family types
([navaid response schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json)).
The representative VOR-DME fixture uses `112.150` with unit `2`.

Planner policy:

- Require unit `2` (MHz) for VOR-family navaids and unit `1` (kHz) for NDBs.
  Exclude mismatches rather than guessing or converting a mislabeled value.
- Parse the value as a finite decimal for validation, but retain its original
  three-decimal string for display. Render the unit explicitly.
- Missing or malformed frequency makes a navaid ineligible because the route
  output must be actionable and include frequencies.

### Published range is nautical miles, but may be absent or zero

When present, range is a non-negative integer and its unit is always code `2`,
documented as nautical miles. Zero is valid according to the response schema,
and the entire field is optional
([navaid response schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json)).
The representative navaid fixture supplies a 130 NM range.

Planner policy:

- Require a finite integer range greater than zero with unit `2`; exclude
  missing, zero, negative, malformed, or differently labeled ranges.
- Use the value only for the agreed geometric edge tests. Label the output and
  documentation as “published range,” not guaranteed reception or certified
  service volume.

### Magnetic declination needs a normalized local contract

OpenAIP exposes optional numeric `magneticDeclination` on both airports and
navaids, but the official response schemas provide no description of units,
sign convention, reference model, or epoch. Both repository fixtures omit the
field. The source contract therefore cannot support silently treating every
value as current degrees-east declination.

Planner/data-layer policy:

- Define the planner input as nullable `magneticDeclinationDegreesEast`, not as
  an uninterpreted OpenAIP field. Ingestion must validate and normalize the
  upstream value against a documented convention before populating it.
- Always compute and display true course. If either endpoint lacks normalized
  declination, display an em dash for the affected magnetic course and emit a
  warning; do not reject an otherwise eligible point or substitute zero.
- Store source and update metadata with the normalized value so freshness can
  be audited later. Determining or refreshing declination from a geomagnetic
  model is outside this route-planning data-fitness decision.

## Required local database contract

The implementation may treat rows as planner-ready only after applying these
predicates:

| Entity          | Required planner fields                                                        | Missing/invalid policy                                     |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Airport         | `_id`, exact normalized ICAO, valid point                                      | Fail request; fail ambiguity if multiple usable rows match |
| VOR-family      | `_id`, type `3`–`8`, identifier, valid point, MHz frequency, positive NM range | Exclude row                                                |
| NDB             | `_id`, type `2`, identifier, valid point, kHz frequency, positive NM range     | Exclude row                                                |
| Any route point | Nullable normalized degrees-east declination                                   | Keep point; omit affected magnetic course and warn         |

These predicates should be centralized in a DuckDB view or candidate-selection
query and covered by synthetic integration records for every rejected case. Raw
OpenAIP objects should remain available for diagnostics, but the path search
must consume only planner-ready records.
