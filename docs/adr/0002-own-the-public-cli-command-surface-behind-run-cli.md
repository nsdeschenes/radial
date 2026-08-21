---
status: accepted
---

# Own the Public CLI Command Surface behind runCli

Radial will concentrate accepted command forms, help and rejected-input bytes, command identities, and argument-derived admission metadata behind `runCli`. A private Radial-specific command catalog will generate the Stricli application, help rendering, and rejection-only compatibility classification; Stricli remains the sole admission parser and is not exposed through the module interface. Runtime and telemetry may depend on the catalog-derived command identity type, while result-derived operational telemetry remains beside command execution.

The rejection classifier may inspect raw arguments only after Stricli rejects an invocation and may never admit or dispatch a command. Keeping a separate diagnostic parser, exposing the command catalog, and leaking Stricli application types were rejected because each would create another public or semantic seam that a command change would have to cross.
