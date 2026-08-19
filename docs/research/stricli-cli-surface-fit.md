# Stricli fit for Radial's CLI Surface

## Decision summary

Stricli is a strong structural fit for Radial's Public CLI at **`@stricli/core` 1.3.0**, pinned to the exact version while the migration is designed. Its route-map default command can preserve the canonical root form `radial <departure-icao> <arrival-icao>` beside the nested `data` tree; command loaders are genuinely lazy; and its context is explicitly designed for injected process I/O and application-specific dependencies.

A **focused compatibility prototype is still required** before the design is implementation-ready. The prototype should not revisit whether Stricli can represent the command tree. It should prove the small adapter needed for four observable seams:

1. exact established help and malformed-input diagnostics;
2. exit-status translation, including Stricli's negative framework statuses;
3. rejection of `--warnings` outside its currently accepted terminal position; and
4. silent interruption with exit 130 while retaining lazy operational imports and cleanup.

The remaining uncertainty is therefore compatibility-adapter feasibility and shape, not basic framework fit.

## Pinned research basis

- Package: [`@stricli/core` 1.3.0](https://www.npmjs.com/package/@stricli/core/v/1.3.0), published 2026-07-16.
- Source revision: Stricli tag `v1.3.0`, commit [`692ce631a384c5ece9a343659ae3c098fc245c1a`](https://github.com/bloomberg/stricli/tree/692ce631a384c5ece9a343659ae3c098fc245c1a). The tag resolves to that commit; the package manifest at the revision declares version 1.3.0, ESM and CommonJS exports, built-in declarations, and no runtime dependencies ([manifest](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/package.json)).
- Documentation consulted: the official Stricli pages for [route maps](https://bloomberg.github.io/stricli/docs/features/command-routing/route-maps), [commands](https://bloomberg.github.io/stricli/docs/features/command-routing/commands), [positional arguments](https://bloomberg.github.io/stricli/docs/features/argument-parsing/positional), [help](https://bloomberg.github.io/stricli/docs/features/integrations/help-text), [integrations](https://bloomberg.github.io/stricli/docs/features/integrations), and [testing](https://bloomberg.github.io/stricli/docs/testing). Source links below are pinned to the commit and are authoritative where the generated documentation is less precise.
- Radial baseline: commit [`d657292533bfe4cea02b153a2c668978fe163936`](https://github.com/nsdeschenes/radial/tree/d657292533bfe4cea02b153a2c668978fe163936), especially the [current dispatcher](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts), its [CLI contract tests](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.test.ts), and the [process/telemetry shell](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/radial.ts).

## Radial's current compatibility target

Radial currently has one default root operation and one nested branch:

```text
radial <departure-icao> <arrival-icao> [--warnings]
radial data status
radial data reload navaids
radial data reload airport <ICAO>
```

The root Route Plan operation recognizes `--warnings` only when it is the final token. The literal first token `data` is already reserved for the nested tree rather than being usable as a departure ICAO. Leaf `--help` writes exactly one `Usage: ...\n` line to stdout and returns 0; malformed shape writes command-specific diagnostics to stderr and returns 2. The dispatcher injects arguments, environment, output writers, application opening, and an optional parent signal. It installs `SIGINT`/`SIGTERM` handlers, disposes them in `finally`, and recognizes interruption as a silent exit 130 ([dispatcher and interruption code](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L15-L114), [signal adapter](https://github.com/nsdeschenes/radial/blob/d657292533bfe4cea02b153a2c668978fe163936/src/cli/main.ts#L524-L549)).

These are observable CLI Surface constraints, not merely parser implementation details. In particular, Stricli's normal ability to accept flags in any order would make `radial --warnings CYYZ CYOW` valid even though Radial currently rejects it.

## Findings

### The mixed root operation and nested tree are representable

`buildRouteMap` accepts nested route maps and a `defaultCommand` that must name a command registered in the same map. Inputs matching a named route enter that route; otherwise inputs are passed to the default command. A default route may be hidden from generated documentation with `docs.hideRoute` ([route-map API and implementation](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/routing/route-map/builder.ts), [official default-command documentation](https://bloomberg.github.io/stricli/docs/features/command-routing/route-maps#default-command)).

That is the exact routing primitive Radial needs: register a hidden internal `planRoute` route as the root default and register `data` as the visible nested route. It preserves the current reservation of `data`; it does not introduce a new collision in the existing CLI Surface.

The hidden default route remains technically invocable by its registered name. The name should therefore be a deliberately internal token, hidden from help, and covered by a compatibility test. This is a minor exposure to decide, not a blocker to the structure.

### Positional shape is native; domain validation should remain Radial-owned

Stricli commands support explicitly typed positional tuples, required/optional positionals, and custom string parsers. Positional placeholders feed generated usage text ([official positional documentation](https://bloomberg.github.io/stricli/docs/features/argument-parsing/positional), [command builder source](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/routing/command/builder.ts)). This covers the two root ICAOs and the single Airport reload ICAO.

The minimum design should use Stricli for command selection, flag recognition, and positional count, while keeping ICAO normalization, same-airport rejection, configuration validation, and Radial's diagnostic formatters in Radial. That matches the map's standing decision that Stricli owns command shape while existing validation remains authoritative.

One compatibility exception needs proof: Stricli flags are order-independent, whereas Radial's current root parser recognizes `--warnings` only as the last token. Stricli's parsed function arguments do not retain token order. The adapter will likely need the injected invocation's raw argument array (or an equally small pre-parse record) so the root implementation can preserve this rejection without taking routing away from Stricli.

### Default help is not byte-compatible, but 1.3.0 exposes the required extension point

Stricli's stock help deliberately emits structured `USAGE`, `FLAGS`, `ARGUMENTS`, and `COMMANDS` sections. `customUsage` replaces a command's generated usage lines, but it does not replace the entire help document ([command documentation type](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/routing/command/documentation.ts), [help integration implementation](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/application/integrations/help.ts)). Consequently, `customUsage` alone cannot preserve Radial's exact one-line leaf help.

Version 1.3.0 adds first-class integrations for built-in flags and lifecycle hooks ([1.3.0 changelog](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/CHANGELOG.md#130-2026-07-16)). `buildApplication` accepts a complete custom integration set; a custom global `help` flag receives the resolved target and route prefix and can write Radial-owned text to injected stdout without loading a command ([application builder](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/application/builder.ts), [integration API](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/application/integration.ts)). This is the clean extension point for preserving the three established leaf help strings and adding the newly required conventional root help.

Parser error formatting is application-wide through `ApplicationText`; argument parsing writes the formatted result plus a newline to stderr ([command runner](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/routing/command/run.ts), [text contract](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/text.ts)). Radial's malformed-shape diagnostics are command-specific. The prototype must establish whether Stricli's error objects contain enough information for a pure formatter or whether the injected raw invocation/prefix must select the existing Radial formatter. No operational module should be loaded merely to format these failures.

### Context injection is a direct fit

Every Stricli command context must provide stdout and stderr writers and may extend that minimal interface with arbitrary application dependencies. `run` also accepts a dynamic `forCommand({prefix})` builder, which can asynchronously create command-specific context ([context source](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/context.ts)). This directly accommodates Radial's environment, output writers, `openApplication`, `AbortSignal`, raw invocation metadata, and stable telemetry command identity.

`forCommand` runs only after routing has selected a command, but it runs **before** command argument parsing. Therefore it must remain a cheap dependency assembler: do not open the application, database, or operational telemetry there. Help and route-selection failures skip `forCommand`; argument-shape failures do not. The official testing model uses the same injected context and `run(app, inputs, context)` boundary, so Radial can keep its current in-process, captured-I/O test style ([testing documentation](https://bloomberg.github.io/stricli/docs/testing), [application runner](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/application/run.ts)).

### Command implementation loading is genuinely lazy

A command's `loader` is called only after route scanning, context construction, and successful argument parsing. Help formatting uses the static command specification and never calls the loader ([command documentation](https://bloomberg.github.io/stricli/docs/features/command-routing/commands#lazy-loader), [command runner order](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/routing/command/run.ts)). This supports dynamic `import()` modules for Route Plan, status, and reload implementations.

The route tree and command specifications are necessarily eager. Those modules must therefore contain only command metadata and lightweight parsers; they must not import `RadialApplication`, DuckDB, data producers, or operational Sentry instrumentation. This requires splitting the current `src/cli/main.ts`, whose top-level imports presently pull those dependencies into all invocations.

### Abort handling remains a Radial shell/context responsibility

Stricli 1.3.0 exposes no built-in `AbortSignal` or signal-handler lifecycle. Its context is sufficient to carry one, but the executable shell must continue to compose an optional parent signal with `SIGINT`/`SIGTERM`, inject the resulting signal, and remove listeners in `finally`.

Command functions may set `context.process.exitCode`; Stricli's public `run` only fills it when it is still nullish ([public `run` implementation](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/index.ts#L76-L86)). Commands should therefore catch recognized interruption, emit nothing, set 130, and still await the existing disposal/publication boundaries. Throwing an abort through Stricli is unsuitable because Stricli formats thrown command exceptions to stderr before applying `determineExitCode`.

### Framework exit codes need an adapter

Stricli assigns negative statuses to framework failures: invalid argument is `-4`, unknown command is `-5`, and load/context/integration failures use other negative values ([exit-code source](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/src/exit-code.ts)). Passing the real Node process directly would expose incompatible OS statuses.

Radial should pass a small mutable process facade to Stricli, inspect its exit code after `run`, translate expected parsing/routing failures to Radial status 2, preserve 0/1/2/130 explicitly set by command code, and treat unexpected Stricli framework failures according to Radial's unexpected-exception policy. This also keeps tests independent of global `process.exitCode`.

## Minimum viable structural sketch

This is intentionally a shape, not implementation code:

```ts
type RadialCliContext = CommandContext & {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly openApplication: typeof openRadialApplication;
  readonly signal: AbortSignal;
  readonly invocation: readonly string[];
  readonly commandIdentity: RadialCliCommandIdentity;
};

type PlanRouteFlags = {readonly warnings?: boolean};
type PlanRouteArgs = readonly [departureIcao: string, arrivalIcao: string];

const planRoute = buildCommand<PlanRouteFlags, PlanRouteArgs, RadialCliContext>({
  loader: () => import('./commands/planRoute.js'),
  parameters: {
    flags: {warnings: {kind: 'boolean', optional: true, brief: '...'}},
    positional: [departureIcao, arrivalIcao],
  },
  docs: {brief: 'Plan a Route'},
});

const reload = buildRouteMap({
  routes: {
    airport: reloadAirportCommand,
    navaids: reloadNavaidsCommand,
  },
  docs: {brief: 'Reload local data'},
});

const data = buildRouteMap({
  routes: {reload, status: dataStatusCommand},
  docs: {brief: 'Inspect or reload local data'},
});

const root = buildRouteMap({
  routes: {__planRoute: planRoute, data},
  defaultCommand: '__planRoute',
  docs: {
    brief: 'Radial flight-simulation route planner',
    hideRoute: {__planRoute: true},
  },
});

const app = buildApplication(
  root,
  {name: 'radial', localization: {text: radialApplicationText}},
  {help: radialHelpIntegration, telemetry: radialTelemetryIntegration},
);

async function runPublicCli(input: CliInput): Promise<number> {
  const interrupt = createInterruptSignal(input.signal);
  const stricliProcess = createProcessFacade(input.io, input.env);
  try {
    await run(app, input.args, {
      process: stricliProcess,
      forCommand: ({prefix}) => buildRadialCliContext(input, interrupt.signal, prefix),
    });
    return translateStricliExitCode(stricliProcess.exitCode);
  } finally {
    interrupt.dispose();
  }
}
```

The command-specification modules must be import-light. Each loader target owns one operation and imports its operational dependencies only after Stricli has accepted the invocation. The custom help integration owns exact help output; Radial's validators and diagnostic formatters own domain and compatibility diagnostics; the shell owns cancellation and final status translation.

## Dependency recommendation

Add `"@stricli/core": "1.3.0"` as an **exact production dependency** for the migration and prototype.

Reasons:

- 1.3.0 is the researched and currently published version.
- Its new public integration API is the key extension point for exact help and lifecycle/telemetry behavior.
- It has zero runtime dependencies and exports both ESM and CommonJS, with built-in TypeScript declarations ([package manifest](https://github.com/bloomberg/stricli/blob/692ce631a384c5ece9a343659ae3c098fc245c1a/packages/core/package.json)).
- An exact pin prevents help, scanning, integration, or exit behavior from drifting during an atomic compatibility-sensitive cutover. A later upgrade can be a separate evidence-backed change.

The prototype should also compile the 1.3.0 declarations under Radial's pinned TypeScript 7 toolchain. The package was built against TypeScript 5.6; that is not evidence of incompatibility, but the local compile is the cheapest definitive check.

## Required focused compatibility prototype

The prototype should be limited to an import-light Stricli app with fake command implementations and captured output. It succeeds only if tests demonstrate all of the following:

1. `radial CYYZ CYOW` resolves to the hidden default Route Plan command and `radial data ...` resolves through the nested tree.
2. The hidden default route does not appear in root help, and its explicit internal token has a consciously accepted behavior.
3. Existing leaf help is byte-for-byte unchanged, conventional root `--help` is added, and no command loader/context initialization occurs for help.
4. Every currently tested malformed command shape produces the existing stderr text and status 2; no command loader runs.
5. `radial --warnings CYYZ CYOW` remains rejected while `radial CYYZ CYOW --warnings` succeeds.
6. Command-set statuses 0, 1, 2, and 130 survive the process facade; Stricli invalid-argument and unknown-route statuses translate to 2 rather than leaking negative values.
7. A recognized abort produces no Stricli exception text, returns 130, and always removes signal listeners.
8. Type checking succeeds with Radial's TypeScript version and dynamic imports do not pull operational modules into help or rejected invocations.

If those tests pass, no broader Stricli feasibility prototype is necessary. If exact malformed diagnostics require bypassing Stricli's command-shape parser rather than adapting its formatter/context, that is a design failure against the map's standing decisions and should return to the map as a fresh decision rather than silently weakening parser ownership.
