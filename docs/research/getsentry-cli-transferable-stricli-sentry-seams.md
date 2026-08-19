# Transferable Stricli and Sentry seams from getsentry/cli

Research captured 2026-08-19 for [Research getsentry/cli's transferable Stricli and Sentry seams](https://github.com/nsdeschenes/radial/issues/104).

## Conclusion

Radial should adopt the architectural shape around getsentry/cli's Stricli integration, not copy that CLI's machinery wholesale:

- describe each command once as a Stricli command and compose those commands through route maps;
- put Radial-wide behavior behind one local `buildCommand` seam and one runtime-context builder;
- derive a canonical command identity from the route Stricli actually resolved, then use that identity consistently for spans, logs, metrics, and error attribution;
- keep the executable entry point thin and make the runner own parsing, error-to-exit classification, signal bridging, and cleanup;
- lazy-load command implementations or command service graphs where this materially improves cold paths, while keeping lightweight command metadata available for routing and help;
- preserve Radial's existing application capability boundary, phase-aware cancellation, publication atomicity, and drain-before-close lifecycle.

getsentry/cli's authentication recovery, global compatibility flags, output schema/rendering system, SDK/library execution layer, route aliases, update checks, patched dependencies, and Sentry-specific error taxonomy solve a much larger product's requirements. They are evidence that the wrapper seams can scale, not a template Radial should reproduce now.

## Source baseline

All getsentry/cli source findings are pinned to commit [`92e2d6427ad31bd12a6390655088c354636cfa47`](https://github.com/getsentry/cli/tree/92e2d6427ad31bd12a6390655088c354636cfa47). Radial comparisons are against commit [`d657292533bfe4cea02b153a2c668978fe163936`](https://github.com/nsdeschenes/radial/tree/d657292533bfe4cea02b153a2c668978fe163936). The Stricli documentation links are first-party Bloomberg documentation; the researched getsentry/cli commit pins `@stricli/core` 1.2.8 ([workspace configuration](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/package.json#L41-L50)).

## Comparative map

| Concern | getsentry/cli | Radial now | Transferable decision |
| --- | --- | --- | --- |
| Command composition | Nested Stricli route maps, built through local wrappers | Ordered `if` chain and command predicates | Use declarative commands and route maps |
| Cross-cutting behavior | One `buildCommand` wrapper | Parsing, execution, rendering, and disposal interleaved in handlers | Create a small Radial-owned command builder |
| Runtime dependencies | Context supplies process, env, paths, and writers | `CliInput` supplies args, env, I/O, optional application opener and signal | Supply a narrow context of CLI-facing capabilities |
| Command identity | Resolved route prefix names the active Sentry span/tag | Identity is inferred from raw argv after execution | Derive identity from the resolved command definition |
| Lazy loading | Coarse completion fast path and selected dynamic imports; full route tree is static | All CLI imports are static | Lazy-load expensive handlers/service graphs selectively |
| Failure semantics | Typed error hierarchy plus centralized exit-code and reporting policies | Mixture of result unions, numeric returns, and thrown exceptions | Add an explicit CLI outcome classifier without replacing domain results |
| Process lifecycle | Thin bin; runner owns recovery; telemetry ends/flushed on process lifecycle | Entrypoint wraps a generic span, flushes/closes Sentry; handlers own resources | Keep a thin bin and central runner, but preserve Radial resource ownership |
| Cancellation | Ad hoc for CLI commands; stronger in streaming library and child-process paths | Global signal bridge plus phase-aware application semantics | Keep Radial semantics; make the bridge an injected runner concern |
| Tests | Wrapper tests, in-process route tests, subprocess/e2e bundle tests, telemetry lifecycle tests | Strong direct-handler tests; no entrypoint, telemetry, or module-load tests | Retain handler tests and add runner/entrypoint contract tests |

## What getsentry/cli actually does

### Command tree and framework seams

The public command surface is a normal nested Stricli tree. The root module statically imports the route groups and leaf commands, composes them with its local `buildRouteMap`, then passes the root to `buildApplication` with scanner, exit-code, help, and localization policies ([root imports and routes](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/app.ts#L1-L199), [application construction](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/app.ts#L406-L436)). Route groups repeat the same composition recursively. This follows Stricli's documented model: a route map is a mapping from names to commands or nested route maps, with optional defaults and aliases ([official route-map documentation](https://bloomberg.github.io/stricli/docs/features/command-routing/route-maps)).

Two project-owned choke points isolate the framework:

- `lib/route-map.ts` is the only intended direct caller of Stricli's `buildRouteMap`; it adds standard aliases without changing command implementations ([source](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/route-map.ts#L1-L66)).
- `lib/command.ts` is the only intended direct caller of Stricli's `buildCommand`; its wrapper injects global flags, authentication/trust checks, telemetry context, output rendering, and finalization around the original async-generator handler ([builder contract](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/command.ts#L347-L380), [wrapper execution](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/command.ts#L674-L839)).

The useful pattern is ownership of those seams. The injected Sentry flags, authentication guard, compatibility environment mutations, async-generator output tokens, and non-standard properties attached to built commands are product-specific. Radial's wrapper can remain much smaller: command ID, outcome attribution, shared context typing, and perhaps common output/error adaptation.

### Runtime context and stable command identity

getsentry/cli extends Stricli's context with a process, environment, working/config/home directories, and injectable stdin/stdout/stderr writers. Its `forCommand` callback receives the resolved prefix, updates telemetry, and returns a per-command context carrying that same prefix ([context definition and builder](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/context.ts#L14-L60)). This is the core source-of-truth pattern: identity comes from successful route resolution, rather than a second argv parser.

The resolved dot-separated path renames the active Sentry span and becomes the `command` tag ([telemetry naming](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L758-L776)). The typed library path uses its explicit command path for the same operation ([SDK invocation](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/sdk-invoke.ts#L547-L582)). Unknown commands are intentionally assigned the fixed identity `unknown`, while raw argv is redacted and attached as structured context ([unknown-command reporting](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/cli.ts#L537-L587)).

Radial should use an explicit canonical ID owned by each command definition, for example `plan-route`, `data.status`, `data.reload.navaids`, and `data.reload.airport`. The Stricli path may itself be that ID, or the command wrapper may map the path to a stable ID. The invariant matters more than punctuation: one definition must drive help, execution, spans, logs, and metrics.

Radial's context should remain capability-oriented. It can contain `env`, `cwd`, I/O, an `AbortSignal`, and operation-shaped application access. It should not expose DuckDB instances, coordinators, or Sentry's global SDK. Radial already deliberately hides those behind application capabilities and shared-runtime leases ([application capabilities](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/application/RadialApplication.ts#L13-L62), [runtime ADR](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/docs/adr/0001-own-shared-duckdb-coordination-behind-runtime-leases.md#L3-L7)).

### Lazy imports: useful, but less complete than it first appears

getsentry/cli does **not** lazily load its public command modules by route. `app.ts` statically imports the whole route tree, and its local command-builder type requires a local `func`. Although Stricli command objects expose a loader, getsentry/cli's modules have already loaded by the time the application tree exists. Stricli's own quick start warns that everything except lazily loaded implementation modules is loaded synchronously ([official quick start](https://bloomberg.github.io/stricli/docs/quick-start)); its command builder supports a loader or local function ([official `buildCommand` API](https://bloomberg.github.io/stricli/packages/core/functions/buildCommand)).

Instead, getsentry/cli uses coarse and tactical laziness:

- shell completion is dispatched before the full application and Sentry SDK imports, producing a deliberately lightweight fast path ([completion path](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/cli.ts#L65-L77), [full runner imports](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/cli.ts#L230-L268));
- heavy or circular dependencies are dynamically imported at the point of need, such as help recovery and the rc trust check ([command wrapper](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/command.ts#L640-L671), [trust check](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/command.ts#L761-L790));
- its library runner dynamically imports Stricli, the application, and context, but resolving the application still loads the static route tree ([library runner](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/sdk-invoke.ts#L597-L619)).

Radial currently eagerly imports Sentry, the application opener, every formatter, data status, and validation from its CLI module ([source](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L1-L13)); the application import reaches the statically imported DuckDB runtime graph even for help ([runtime imports](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/application/internal/SharedDuckDBRuntime.ts#L1-L19)). A Stricli migration can improve this more directly than getsentry/cli does: keep lightweight command definitions and parsers synchronous, but use loaders or injected services to defer the application/DuckDB graph until a command needs it. Measure the benefit with Radial's mandatory Sentry preload included, because instrumentation and profiling initialization are part of its real cold start ([instrumentation](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/instrument.ts#L1-L21)).

### Error classification and Sentry observability

getsentry/cli separates three related decisions:

1. a typed error hierarchy assigns semantic exit codes below the Unix signal range ([exit-code taxonomy and base class](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/errors.ts#L1-L122));
2. the Stricli application maps thrown errors to exit codes and formats expected CLI errors differently from unexpected errors ([application error policy](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/app.ts#L284-L404), [exit-code configuration](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/app.ts#L406-L435));
3. Sentry reporting independently decides which failures are actionable defects. Expected auth, user-caused 401–499 responses other than 400, network, and output-bearing failures are silenced as issues but counted by metric; other failures receive normalized grouping tags and structured context before capture ([classification](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/error-reporting.ts#L45-L137), [capture path](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/error-reporting.ts#L287-L370)).

The telemetry wrapper creates one command transaction, records expected API failures on the span, routes terminal failures through the reporting policy, and marks a session crashed only for failures classified as genuine defects ([source](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L159-L257)). Parsed flag telemetry redacts named secret flags, but positional arguments are attached wholesale as context ([flag and argument context](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L797-L906)). Radial should transfer the separation of outcome, exit status, and defect reporting, while using an explicit telemetry allowlist rather than assuming every future positional argument is safe.

Radial already has useful domain failure unions ([application failure types](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/application/RadialApplicationTypes.ts#L33-L59), [planner failure types](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/route-planner/RoutePlannerTypes.ts#L112-L164)) and diagnostic formatters, so it should not replace them with a large exception hierarchy. A thin CLI classifier can map:

- parse/usage failures to exit 2 and no defect capture;
- expected domain failures to their existing rendered diagnostics and exit 1 or 2;
- interruption to 130 and a distinct cancelled outcome;
- unexpected thrown failures to exit 1 plus Sentry exception capture.

The current split is inconsistent: the handwritten CLI returns 0/1/2, maps abort to 130 only in reload handlers, and lets some route-planning and disposal exceptions escape ([dispatch and route execution](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L28-L172), [reload classification](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L327-L397)). The top-level Sentry command identity is then reconstructed from argv after execution and omits help and usage failures ([source](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/radial.ts#L33-L89)).

### Process lifecycle and cancellation

getsentry/cli's binary is intentionally thin: it installs CLI-only stream handlers and delegates to the testable `startCli` runner ([source](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/bin.ts#L1-L56)). The runner sets `process.exitCode` instead of forcing exit, aborts its background update check in `finally`, and leaves terminal formatting/classification centralized ([runner terminal path](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/cli.ts#L600-L657)). Enabled telemetry registers a guarded `beforeExit` handler to end healthy sessions and flush without turning telemetry failure into CLI failure ([handler](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L259-L294), [registration](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L685-L755)). Library mode deliberately removes integrations that mutate or hold open the host process and flushes explicitly instead ([library exclusions](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/telemetry.ts#L397-L426), [library flush](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/sdk-invoke.ts#L195-L206)).

Cancellation is not a general Stricli-context facility in getsentry/cli. The programmatic streaming path creates a controller, cascades a consumer signal and iterator return into it, and places the signal on a fake process for participating commands ([source](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/lib/sdk-invoke.ts#L447-L535)). The monitor wrapper separately forwards SIGINT/SIGTERM to its child and translates signal termination to `128 + signal` while retaining control long enough to send a final check-in ([source](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/commands/monitor/run.ts#L309-L390)). These are useful local patterns, not a coherent CLI-wide cancellation model.

Radial already bridges parent abort plus SIGINT/SIGTERM into one signal and removes listeners in `finally` ([source](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L524-L550)). More importantly, its data runtime distinguishes cancellable queued work from admitted publication work that must finish atomically; a CLI test explicitly requires publication to complete successfully after an interrupt ([test](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.test.ts#L372-L430)). A framework migration must preserve that phase-aware contract. It should move signal installation into the runner/context and standardize terminal outcome mapping, not impose immediate cancellation or bypass application disposal.

### Testing strategy

getsentry/cli tests at several seams:

- wrapper and route behavior runs Stricli applications against an in-memory context with captured writers ([example](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/test/lib/command.test.ts#L40-L150));
- the shared subprocess fixture captures stdout, stderr, and actual exit status against source or a built binary ([fixture](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/test/fixture.ts#L17-L111));
- bundle smoke tests exercise executable packaging, heavy lazy-import paths, SQLite, authentication, and telemetry initialization ([example](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/test/e2e/bundle.test.ts#L51-L163));
- telemetry lifecycle has focused unit and subprocess timing coverage ([exit timing](https://github.com/getsentry/cli/blob/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/test/e2e/telemetry-exit.test.ts#L1-L68)).

Radial's direct `runCli` tests already strongly pin stdout/stderr, exit codes, pre-open validation, cancellation, publication behavior, and absence of partial success output ([examples](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.test.ts#L12-L180), [cancellation cases](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.test.ts#L372-L430)). Keep those as behavioral migration tests. Add only the missing layers: command-tree routing/help, canonical identity, error classification, signal-listener cleanup, entrypoint/Sentry orchestration, and a cold-path assertion or benchmark proving expensive command graphs are not loaded for help.

## Transfer now, defer, and reject

### Transfer now

1. A declarative Stricli tree whose command definitions own canonical IDs and help metadata.
2. A minimal local `buildCommand` wrapper and route-map module as the only framework import seams.
3. A typed runtime context containing I/O, environment, cwd, cancellation, and operation-shaped Radial access.
4. A runner-level outcome classifier separating usage, expected domain failure, interruption, and defect.
5. Resolved-command naming for the command span, result log, metric, and captured defects.
6. Lazy handler/service imports for expensive command graphs, verified with a cold-path test or benchmark.
7. Layered tests: direct handler, in-process Stricli run, and a small executable/telemetry lifecycle suite.

### Defer until Radial has the need

- automatic global flag injection and aliases;
- structured JSON schemas and streaming renderers;
- middleware retries and interactive recovery;
- a programmatic library/SDK that bypasses string parsing;
- completion fast paths, update checks, shell wrappers, and generated command docs;
- server-side fingerprint rules or a large semantic exit-code range.

### Do not transfer

- Sentry product authentication, host trust, organization/project resolution, or legacy `sentry-cli` compatibility behavior;
- getsentry/cli's patched Stricli and Sentry dependencies;
- its global environment mutation and process-shaped library context;
- its unfiltered positional-argument telemetry;
- command-specific cancellation mechanisms as a replacement for Radial's application lifecycle.

## Scale and behavior cautions

getsentry/cli has roughly 157 files under its [commands directory](https://github.com/getsentry/cli/tree/92e2d6427ad31bd12a6390655088c354636cfa47/packages/cli/src/commands) at the pinned commit, versus four current Radial command identities and one default positional form ([Radial identity inference](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/radial.ts#L54-L89)). Its 863-line command wrapper and multi-layer recovery runner are a response to authentication, compatibility, structured output, interactive recovery, a public library API, and many command families. Reproducing that abstraction depth in Radial would obscure the useful seam.

Radial also has behavior getsentry/cli does not model centrally: shared DuckDB leases, nested planner/application disposal, admitted-work draining, and atomic publication after cancellation. Stricli should own route selection and argument parsing; Radial's application should continue to own operational lifetime. The CLI runner coordinates those owners but must not collapse them into framework middleware.

Finally, compare cold-start designs empirically. getsentry/cli's completion optimization avoids its full Sentry and Stricli graph; Radial always preloads the full Sentry Node SDK plus profiling before its entrypoint. A loader that saves DuckDB imports may still be worthwhile, but only a measurement including the real preload can establish its user-visible value.

## Decision enabled by this research

A Radial Stricli design can now be scoped around five small modules: command definitions, route composition, runtime context, a local command wrapper, and a process runner. The design should make canonical command identity and error/cancellation outcomes explicit, lazy-load only expensive implementation graphs, and invoke the existing application capabilities without weakening their lifecycle guarantees. No getsentry/cli product middleware is prerequisite to that migration.
