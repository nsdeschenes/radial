import {z} from 'zod';

import OpenAIPListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPNavaidListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns navaids where searchable fields match the input string. Search is case-insensitive. Searchable fields are: name and identifier.',
  }),
  type: z
    .array(
      z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(7),
        z.literal(8),
      ])
    )
    .optional()
    .meta({description: 'Show only navaids of the provided types.'}),
  alignedTrueNorth: z.boolean().optional().meta({
    description: 'If true only shows navaids that are aligned to true north.',
  }),
}).meta({description: 'Query parameters for a list of navaids.'});

export default OpenAIPNavaidListParametersSchema;
