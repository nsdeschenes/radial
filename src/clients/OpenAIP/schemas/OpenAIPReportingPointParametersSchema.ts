import OpenAIPDocumentParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPDocumentParametersSchema.js';

const OpenAIPReportingPointParametersSchema = OpenAIPDocumentParametersSchema.meta({
  description: 'Parameters for a reporting point.',
});

export default OpenAIPReportingPointParametersSchema;
