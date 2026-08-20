import type {CommandContext, StricliProcess} from '@stricli/core';

import type CliInputTypes from '#radial/cli/CliInput.js';
import type CliRuntimeTypes from '#radial/cli/runtime/CliRuntimeContext.js';

type CommandSelection = Readonly<{id: CliRuntimeTypes['CommandId']}>;
type SelectedCommandCell = {value: CommandSelection | undefined};
type CliStricliContext = CommandContext &
  Readonly<{
    input: CliInputTypes['Input'];
    invocation: readonly string[];
    process: StricliProcess;
    selectedCommand: SelectedCommandCell;
  }>;

export default interface CliStricliTypes {
  CommandSelection: CommandSelection;
  Context: CliStricliContext;
  SelectedCommandCell: SelectedCommandCell;
}
