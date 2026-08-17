class OpenAIPNavaidTransportError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'OpenAIPNavaidTransportError';
    this.retryable = retryable;
  }
}

export default OpenAIPNavaidTransportError;
