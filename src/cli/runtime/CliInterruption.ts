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

export default {create, is};
