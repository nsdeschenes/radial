import OpenAIPDocumentParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPNavaidParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for a navaid.',
});

export default OpenAIPNavaidParametersSchema;
