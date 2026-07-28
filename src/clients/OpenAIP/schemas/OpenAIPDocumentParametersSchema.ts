import {z} from 'zod';

const OpenAIPDocumentParametersSchema = z.strictObject({
  id: z.string().meta({description: 'A document reference ID.'}),
  fields: z.string().optional().meta({
    description:
      'A comma separated list of field names that should be available on the returned object. If not specified, all available object fields will be returned.',
  }),
});

export default OpenAIPDocumentParametersSchema;
