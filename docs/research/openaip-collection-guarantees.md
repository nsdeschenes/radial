# OpenAIP collection and lookup guarantees

Research captured 2026-08-17 for [Establish OpenAIP collection and lookup guarantees](https://github.com/nsdeschenes/radial/issues/30).

## Finding

The current OpenAIP Core API can supply a worldwide Navaid collection through a paginated list endpoint and candidate airports through a case-insensitive search endpoint. It does **not** document a coherent read boundary across pages. Radial can therefore produce a deterministic, checksummed `Navaid Snapshot` from the exact records it captured, but the API alone cannot guarantee that those records all represent one upstream instant or that the same collection can be fetched again later.

The authoritative live contract is OpenAIP's [Core API OpenAPI schema](https://api.core.openaip.net/api/system/specs/v1/schema.json), currently advertising OpenAPI 3.0.3 and contract version 1.1. OpenAIP's [official documentation repository](https://github.com/openAIP/openaip-api-documentation) loads this live schema into Swagger UI.

## Navaid collection

OpenAIP documents `GET /navaids` with these pagination controls:

- `page` is one-based and defaults to 1.
- `limit` is the maximum number of returned items per page. Its default depends on the service and is “usually” 1000. No maximum accepted value is published.
- The [Navaid list response schema](https://api.core.openaip.net/api/schemas/response/navaid/list-schema.json) requires `page`, `limit`, `totalCount`, `totalPages`, and `items`; `nextPage` is present only when another page exists.
- `sortBy` requests ordering by a named field, ascending unless `sortDesc=true`. The docs do not define the default ordering, restrict the accepted sort fields, promise a stable tie-breaker, or promise that an explicit ordering remains stable while the collection changes.

For the most deterministic API traversal available, Radial should request every page with an explicit constant `limit`, `sortBy=_id`, and `sortDesc=false`. `_id` is OpenAIP's documented internal record identifier in the [Navaid record schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json). Radial should not rely on the endpoint's unspecified default order or page size.

The list contract provides no cursor, snapshot token, ETag for the result collection, collection revision, or `asOf` parameter. It makes no cross-request isolation or multi-page consistency promise. `updatedAfter` accepts an encoded UTC timestamp, but it does not solve full-snapshot coherence: the contract gives it no fixed read boundary, and it does not document deletion/tombstone behavior. Per-record `createdAt` and `updatedAt` fields describe individual documents, not the collection as a whole.

Consequently, an importer should treat drift checks as detection, not as proof of coherence:

1. Record the first response's `totalCount`, `totalPages`, and returned `limit`.
2. Follow page numbers through the declared end, checking each echoed `page`, `limit`, `totalCount`, and `totalPages` against the initial envelope.
3. Reject duplicate `_id` values and require the final unique count to equal the initial `totalCount`.
4. Abort the entire candidate import and retry from page 1 if any invariant changes.
5. Validate and canonically order the captured records before computing the deterministic checksum and atomically publishing the `Navaid Snapshot`.

These checks detect many insert, delete, and page-shift races, but an equal-count replacement or mutation can pass them. A specification requiring a provably coherent worldwide upstream collection needs a different acquisition contract. OpenAIP also publishes daily exports intended for programmatic use, but its maintainer describes them as country/type files rather than a documented worldwide atomic bundle; see the official [daily exports discussion](https://github.com/openAIP/openaip/issues/292).

## Exact airport-by-ICAO lookup

`GET /airports` has no exact ICAO parameter or `/airports/{icaoCode}` endpoint. Its `search` parameter is case-insensitive across `name`, `icaoCode`, `iataCode`, and `altIdentifier`, according to the [Core API OpenAPI schema](https://api.core.openaip.net/api/system/specs/v1/schema.json). The separate `GET /airports/{id}` endpoint takes OpenAIP's internal document ID, not an ICAO code.

The safe lookup contract is therefore:

1. Normalize the requested ICAO to uppercase and validate it as exactly four ASCII letters, matching the [Airport record schema](https://api.core.openaip.net/api/schemas/response/airport/airport-schema.json).
2. Query `GET /airports?search=<normalized ICAO>` with an explicit page and limit.
3. Ignore search ranking and client-filter all returned candidates to `icaoCode === normalized`.
4. Accept exactly one structurally valid exact match. Treat zero as a miss and multiple exact matches as ambiguous upstream data, not as a successful lookup.
5. If the search response is paginated, inspect all pages before concluding miss or uniqueness because the API does not promise that an exact ICAO match ranks first.

The docs say `searchOptLwc=true` enables leading-wildcard/contains behavior, while also describing the default with nearly identical “leading wildcard” wording. This ambiguity is another reason never to interpret the server's search match as exact. Exactness belongs to Radial's post-filter.

## Rate limits and retries

The Core API description says that several endpoints are rate limited and asks clients to cache responses. It publishes no numeric quota, window, concurrency limit, rate-limit response headers, or reset mechanism. The documented responses for both list endpoints are 200, 400, 401, 403, 404, 500, and 504; 429 and `Retry-After` are not part of the published endpoint contract.

Radial must therefore own a conservative bounded retry policy rather than infer an OpenAIP guarantee:

- Retry network failures and transient HTTP 429/500/502/503/504 responses with exponential backoff and jitter, honoring `Retry-After` if one happens to be supplied.
- Do not retry 400/401/403/404 automatically.
- Cap attempts and elapsed time; exhaustion fails the reload while preserving the active `Navaid Snapshot` or `Cached Airport`.
- Fetch pages serially unless later operational evidence justifies bounded concurrency. No published numeric rate permits a safe higher default.
- A whole-snapshot consistency failure restarts at page 1; it must not retry only the shifted page and then publish a mixed candidate.

This is a Radial reliability policy, not a guarantee claimed by OpenAIP.

## Source identity, timestamps, and reproducibility

Persist these separately:

- Source identity: `OpenAIP Core API`, base URL `https://api.core.openaip.net/api`, resource `/navaids` or `/airports`, and OpenAPI contract version 1.1 observed at retrieval.
- Retrieval provenance: started-at and completed-at timestamps, exact non-secret query parameters, record count, and deterministic checksum of the canonical captured records.
- Record provenance: OpenAIP `_id`, `createdAt`, and `updatedAt` when present.

The contract version is not a dataset version, and record timestamps are not a worldwide collection timestamp. Do not label either as the `Navaid Snapshot`'s upstream version. The snapshot's reproducibility promise is instead: the stored raw records plus canonicalization rules reproduce the same planner-ready data and checksum. It cannot promise that OpenAIP will reproduce the same records in a future fetch.

## Planning consequence

The API path is acceptable only if the producer specification explicitly defines a best-effort, drift-detecting capture and acknowledges the residual equal-count mutation race. If the destination requires a coherent upstream cut, a follow-on decision must choose and verify another acquisition shape, such as assembling versioned country exports under a manifest or obtaining a snapshot-capable contract from OpenAIP.
