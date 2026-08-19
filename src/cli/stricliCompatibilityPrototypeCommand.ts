import type {CommandContext, CommandFunction, StricliProcess} from '@stricli/core';

type PrototypeCommandIdentity =
  | 'data-status'
  | 'plan-route'
  | 'reload-airport'
  | 'reload-navaids';

type PrototypeCommandContext = CommandContext & {
  commandIdentity: PrototypeCommandIdentity;
  evidence: {commandRuns: PrototypeCommandIdentity[]};
  process: StricliProcess;
  requestedExitCode: 0 | 1 | 2 | 130;
  signal: AbortSignal;
};

const runPrototypeCommand: CommandFunction<
  Readonly<{warnings?: boolean}>,
  readonly string[],
  PrototypeCommandContext
> = function () {
  this.evidence.commandRuns.push(this.commandIdentity);
  this.process.exitCode = this.signal.aborted ? 130 : this.requestedExitCode;
};

export default runPrototypeCommand;
