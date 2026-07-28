import {z} from 'zod';

const OpenAIPErrorSchema = z.strictObject({
  message: z.string(),
  code: z.string(),
  status: z.number().int(),
});

export default OpenAIPErrorSchema;
