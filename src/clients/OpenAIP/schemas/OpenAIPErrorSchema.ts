import {z} from 'zod';

const OpenAIPErrorSchema = z
  .object({
    message: z.string(),
    code: z.string(),
    status: z.number().int(),
  })
  .strict();

export default OpenAIPErrorSchema;
