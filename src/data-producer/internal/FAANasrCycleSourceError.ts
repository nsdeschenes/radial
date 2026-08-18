export default class FAANasrCycleSourceError extends Error {
  readonly code: 'unavailable' | 'invalid-response';

  constructor(code: 'unavailable' | 'invalid-response', message: string) {
    super(message);
    this.code = code;
  }
}
