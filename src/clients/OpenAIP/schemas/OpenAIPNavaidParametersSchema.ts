import OpenAIPDocumentParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPNavaidParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for a navaid.',
});

export default OpenAIPNavaidParametersSchema;
