import {ExitCode, run} from '@stricli/core';
import type {StricliProcess} from '@stricli/core';

import buildCliApplication from '#radial/cli/buildCliApplication.js';
import type CliInputTypes from '#radial/cli/CliInput.js';

const cliApplication = buildCliApplication();
type CliCommandTypes = NonNullable<(typeof cliApplication)['commandTypes']>;

interface RunCli {
  (input: CliInputTypes['Input']): Promise<number>;
  readonly commandTypes?: CliCommandTypes;
}

const runCli: RunCli = async input => {
  let frameworkStderr = '';
  const processFacade: StricliProcess = {
    env: {STRICLI_NO_COLOR: '1'},
    stderr: {
      write(text) {
        frameworkStderr += text;
      },
    },
    stdout: {
      write(text) {
        input.io.writeStdout(text);
      },
    },
  };
  const context = cliApplication.contextFor(input, processFacade);

  await run(cliApplication.application, input.args, context);

  const exitCode = processFacade.exitCode;
  if (isFrameworkRejection(exitCode)) {
    input.io.writeStderr(cliApplication.rejectedInvocationDiagnostic(input.args));
  } else if (frameworkStderr !== '') {
    input.io.writeStderr(frameworkStderr);
  }

  return translateExitCode(exitCode);
};

function isFrameworkRejection(exitCode: number | string | null | undefined): boolean {
  return exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand;
}

function translateExitCode(exitCode: number | string | null | undefined): number {
  if (isFrameworkRejection(exitCode)) {
    return 2;
  }

  if (exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 130) {
    return exitCode;
  }

  throw new Error(`Unexpected Stricli framework exit code ${JSON.stringify(exitCode)}.`);
}

export default runCli;
