---
status: accepted
---

# Concentrate admitted command workflows in deep command modules

Radial will give each Public CLI command one lightweight, framework-neutral entry module that accepts only normalized command input and admitted CLI capabilities, owns the complete request-to-outcome workflow, and returns the final status. A private `buildCliApplication` will retain the generated Stricli catalog, help and rejection compatibility, and normalized dispatch, while `runAdmittedCliCommand` will retain the shared telemetry, runtime, disposal, and close lifecycle; this refines ADR-0002 by moving argument-derived telemetry-metadata assembly from the catalog to the command that consumes the admitted values without moving parser authority or the Public CLI boundary.

The command owns application configuration, request assembly, operational telemetry, interruption and expected-failure mapping, and output. Command modules cannot inspect raw invocation arguments, select runtime command identity, or control application disposal; one frozen environment snapshot supplies telemetry and runtime configuration, and data status remains a deliberately direct, lazy, non-creating reader workflow rather than being forced through the application.

## Considered Options

Framework-neutral inner handlers behind caller-owned wrappers were rejected because they split one command workflow across modules and made tests target an interface the Public CLI did not call. A shared per-command orchestrator, raw arguments in command modules, runtime command identity and disposal capabilities, and forcing data status through an application were rejected because each would leak command policy across the boundary or violate the read-only status contract. Dynamically importing a deep entry module was rejected because the module cannot place its own loading failure inside an admitted lifecycle; the entry modules instead remain eager and import-light while operational dependencies stay lazy.

## Consequences

Command tests exercise the same admission-to-outcome entry points called by Stricli, using local application openers where applicable. Parser compatibility remains tested at `runCli` and `buildCliApplication`, lifecycle ordering at `runAdmittedCliCommand`, and lazy application mechanics at the runtime context; startup module defects are startup defects rather than admitted-command defects.
