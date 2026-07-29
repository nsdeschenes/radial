import {z} from 'zod';

import OpenAIPListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPReportingPointListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns reporting points where searchable fields match the input string. Search is case-insensitive. The searchable field is name.',
  }),
  airport: z.string().optional().meta({
    description:
      "Searches and returns reporting points linked to the specified airport. Value must be an airport's document ID.",
  }),
}).meta({description: 'Query parameters for a list of reporting points.'});

export default OpenAIPReportingPointListParametersSchema;
