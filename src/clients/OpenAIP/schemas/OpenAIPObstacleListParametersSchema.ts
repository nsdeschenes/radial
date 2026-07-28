import {z} from 'zod';

import OpenAIPListParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPObstacleListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns obstacles where searchable fields match the input string. Search is case-insensitive. Searchable fields are: name and identifier.',
  }),
  type: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .optional()
    .meta({description: 'Show only obstacles of the provided types.'}),
}).meta({description: 'Query parameters for a list of obstacles.'});

export default OpenAIPObstacleListParametersSchema;
