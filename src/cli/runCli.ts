import {ExitCode, run} from '@stricli/core';
import type {StricliProcess} from '@stricli/core';

import buildCliApplication from '#radial/cli/buildCliApplication.js';
import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliStricliTypes from '#radial/cli/CliStricliContext.js';
import formatCliCompatibilityDiagnostic from '#radial/cli/formatCliCompatibilityDiagnostic.js';

const application = buildCliApplication();

async function runCli(input: CliInputTypes['Input']): Promise<number> {
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
  const selectedCommand: CliStricliTypes['SelectedCommandCell'] = {value: undefined};
  const context: CliStricliTypes['Context'] = {
    input,
    invocation: input.args,
    process: processFacade,
    selectedCommand,
  };

  await run(application, input.args, context);

  const exitCode = processFacade.exitCode;
  if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
    input.io.writeStderr(formatCliCompatibilityDiagnostic(input.args));
  } else if (frameworkStderr !== '') {
    input.io.writeStderr(frameworkStderr);
  }

  return translateExitCode(exitCode);
}

function translateExitCode(exitCode: number | string | null | undefined): number {
  if (exitCode === ExitCode.InvalidArgument || exitCode === ExitCode.UnknownCommand) {
    return 2;
  }

  if (exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 130) {
    return exitCode;
  }

  throw new Error(`Unexpected Stricli framework exit code ${JSON.stringify(exitCode)}.`);
}

export default runCli;
