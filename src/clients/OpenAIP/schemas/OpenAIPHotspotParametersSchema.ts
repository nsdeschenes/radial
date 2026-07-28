import OpenAIPDocumentParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPHotspotParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for a hotspot.',
});

export default OpenAIPHotspotParametersSchema;
