# Pinned fixture provenance

`provenance.json` is the authoritative manifest for committed source
fixtures. Each record carries its source identity and URL, retrieval time,
version or cycle, license note, extraction policy, generator version, and a
SHA-256 digest derived from the listed files. The acceptance suite verifies the
manifest and every listed file before running release evidence.

Routine and acceptance commands use these committed files or deterministic
in-memory fixtures. They never contact OpenAIP, FAA, or NOAA. To inspect an
upstream change, use the explicitly networked refresh command:

```bash
OPENAIP_API_KEY=<key> \
nub run acceptance:refresh-fixtures -- --network \
  --url 'https://api.core.openaip.net/api/navaids?page=1&limit=1000&sortBy=_id&sortDesc=false' \
  --output fixtures/OpenAIP/success/navaids.json
```

The command prints a deterministic review diff and only changes the target
when `--apply` is supplied. Update `provenance.json` in the same review when a
fixture is intentionally refreshed. Live source compatibility is a separate,
manual, non-gating command:

```bash
OPENAIP_API_KEY=<key> nub run acceptance:compatibility
```
