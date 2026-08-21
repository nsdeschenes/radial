import type ApplicationTypes from '#radial/application/RadialApplicationTypes.js';
import type CliCommandMetadataTypes from '#radial/cli/CliCommandMetadata.js';

type CliCommandId = CliCommandMetadataTypes['Metadata']['id'];

type CliIo = Readonly<{
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}>;

type ApplicationUseResult<Value> =
  | Readonly<{ok: true; value: Value}>
  | Readonly<{ok: false; failure: ApplicationTypes['ApplicationOpenFailure']}>;

type CliRuntimeContext = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  io: CliIo;
  signal: AbortSignal;
  command: Readonly<{readonly id: CliCommandId | undefined}>;
  disposeApplication(): Promise<void>;
  withApplication<Value>(
    config: ApplicationTypes['ApplicationConfig'],
    use: (application: ApplicationTypes['Application']) => Promise<Value>
  ): Promise<ApplicationUseResult<Value>>;
}>;

export default interface CliRuntimeTypes {
  ApplicationOpener: (
    config: ApplicationTypes['ApplicationConfig']
  ) => Promise<ApplicationTypes['ApplicationOpenResult']>;
  ApplicationLoader: () => Promise<CliRuntimeTypes['ApplicationOpener']>;
  CommandId: CliCommandId;
  Context: CliRuntimeContext;
  Io: CliIo;
}
