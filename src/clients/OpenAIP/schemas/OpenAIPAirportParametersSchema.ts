import OpenAIPDocumentParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPAirportParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for an airport.',
});

export default OpenAIPAirportParametersSchema;
