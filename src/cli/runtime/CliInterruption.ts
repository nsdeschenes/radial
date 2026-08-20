class CliInterruptionError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('The CLI invocation was interrupted.');
    this.name = 'CliInterruptionError';
    this.cause = cause;
  }
}

function create(cause: unknown): Error {
  return new CliInterruptionError(cause);
}

function is(error: unknown): boolean {
  return error instanceof CliInterruptionError;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

export default {create, is, isCancellation};
