type OpenAIPNavaidCaptureFailureCode =
  | 'auth'
  | 'forbidden'
  | 'unavailable'
  | 'invalid-response'
  | 'snapshot-drift';

export default class OpenAIPNavaidCaptureError extends Error {
  readonly code: OpenAIPNavaidCaptureFailureCode;

  constructor(code: OpenAIPNavaidCaptureFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}
