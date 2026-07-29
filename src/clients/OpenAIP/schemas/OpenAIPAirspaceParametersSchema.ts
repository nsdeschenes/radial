import OpenAIPDocumentParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPAirspaceParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for an airspace.',
});

export default OpenAIPAirspaceParametersSchema;
