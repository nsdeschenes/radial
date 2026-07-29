import {z} from 'zod';

import OpenAIPErrorSchema from '#radial/clients/OpenAIP/schemas/OpenAIPErrorSchema.js';

class OpenAIPError extends Error {
  readonly code: string;
  readonly status: number;

  constructor({message, code, status}: z.infer<typeof OpenAIPErrorSchema>) {
    super(message);
    this.name = 'OpenAIPError';
    this.code = code;
    this.status = status;
  }
}

export default OpenAIPError;
