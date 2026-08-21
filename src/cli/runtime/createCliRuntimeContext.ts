import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import cliInterruption from '#radial/cli/runtime/CliInterruption.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';

type ApplicationConfig = ApplicationTypes['ApplicationConfig'];
type ApplicationOpenResult = ApplicationTypes['ApplicationOpenResult'];
type ApplicationUseResult<Value> =
  | Readonly<{ok: true; value: Value}>
  | Readonly<{ok: false; failure: ApplicationTypes['ApplicationOpenFailure']}>;

type RuntimeInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  io: CliRuntimeTypes['Io'];
  signal: AbortSignal;
  loadApplication?: CliRuntimeTypes['ApplicationLoader'];
}>;

type RuntimeScope = Readonly<{
  context: CliRuntimeTypes['Context'];
  lifecycleContext: CliRuntimeTypes['LifecycleContext'];
  [Symbol.asyncDispose](): Promise<void>;
}>;

function createCliRuntimeContext(input: RuntimeInput): RuntimeScope {
  const environmentSnapshot = Object.isFrozen(input.env)
    ? input.env
    : Object.freeze({...input.env});
  let applicationConfig: ApplicationConfig | undefined;
  let applicationOpener: Promise<CliRuntimeTypes['ApplicationOpener']> | undefined;
  let applicationOpen: Promise<ApplicationOpenResult> | undefined;
  let applicationDisposal: Promise<void> | undefined;
  let disposed = false;

  const disposeApplication = async (): Promise<void> => {
    if (applicationDisposal !== undefined) {
      return applicationDisposal;
    }

    applicationDisposal = (async () => {
      const openedApplication = await applicationOpen;
      if (openedApplication?.ok === true) {
        await openedApplication.value[Symbol.asyncDispose]();
      }
    })();
    return applicationDisposal;
  };

  const lifecycleContext: CliRuntimeTypes['LifecycleContext'] = Object.freeze({
    env: environmentSnapshot,
    io: input.io,
    signal: input.signal,
  });
  const context: CliRuntimeTypes['Context'] = Object.freeze({
    ...lifecycleContext,
    async withApplication<Value>(
      config: ApplicationConfig,
      use: (application: ApplicationTypes['Application']) => Promise<Value>
    ): Promise<ApplicationUseResult<Value>> {
      if (disposed) {
        throw new Error(
          'Cannot use the CLI application scope after it has been disposed.'
        );
      }

      if (applicationConfig !== undefined && !sameConfig(applicationConfig, config)) {
        throw new Error(
          'Cannot open a competing Radial application configuration in one CLI invocation.'
        );
      }

      if (input.signal.aborted) {
        throw cliInterruption.create(input.signal.reason);
      }

      applicationConfig ??= Object.freeze({...config});
      applicationOpener ??= loadApplicationOpener(input.loadApplication);
      const openApplication = await applicationOpener;
      if (disposed) {
        throw new Error(
          'Cannot use the CLI application scope after it has been disposed.'
        );
      }

      if (input.signal.aborted) {
        throw cliInterruption.create(input.signal.reason);
      }

      applicationOpen ??= openApplication(applicationConfig);
      const openedApplication = await applicationOpen;

      if (input.signal.aborted) {
        await disposeApplication();
        throw cliInterruption.create(input.signal.reason);
      }

      if (!openedApplication.ok) {
        return openedApplication;
      }

      return {ok: true, value: await use(openedApplication.value)};
    },
  });

  return Object.freeze({
    context,
    lifecycleContext,
    async [Symbol.asyncDispose]() {
      disposed = true;
      await disposeApplication();
    },
  });
}

async function loadApplicationOpener(
  injectedLoader: CliRuntimeTypes['ApplicationLoader'] | undefined
): Promise<CliRuntimeTypes['ApplicationOpener']> {
  const loadApplication = injectedLoader ?? defaultApplicationLoader;
  return loadApplication();
}

async function defaultApplicationLoader() {
  const applicationModule = await import('#radial/application/RadialApplication.js');
  return applicationModule.default;
}

function sameConfig(first: ApplicationConfig, second: ApplicationConfig): boolean {
  return (
    first.databasePath === second.databasePath &&
    first.maxRouteFactor === second.maxRouteFactor &&
    first.openAipApiKey === second.openAipApiKey
  );
}

export default createCliRuntimeContext;
