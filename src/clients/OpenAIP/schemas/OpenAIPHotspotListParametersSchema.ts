import {z} from 'zod';

import OpenAIPListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPHotspotListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns hotspots where searchable fields match the input string. Search is case-insensitive. Searchable fields are: name and identifier.',
  }),
  type: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .optional()
    .meta({description: 'Show only hotspots of the provided types.'}),
  reliability: z
    .array(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]))
    .optional()
    .meta({description: 'Show only hotspots of the provided reliability.'}),
  occurrence: z
    .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
    .optional()
    .meta({description: 'Show only hotspots of the provided occurrence.'}),
  category: z
    .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
    .optional()
    .meta({
      description:
        'Show only hotspots that are suited for the specified aircraft categories.',
    }),
  timeOfDay: z
    .array(
      z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    )
    .optional()
    .meta({description: 'Show only hotspots that work at the provided times of day.'}),
  favTimeOfDay: z
    .array(
      z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    )
    .optional()
    .meta({
      description: 'Show only hotspots that work best at the provided times of day.',
    }),
  favWindDirection: z
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
      ])
    )
    .optional()
    .meta({
      description: 'Show only hotspots that work best at the provided wind directions.',
    }),
  reqWindDirection: z
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
      ])
    )
    .optional()
    .meta({
      description:
        'Show only hotspots that require the provided wind directions to work.',
    }),
}).meta({description: 'Query parameters for a list of hotspots.'});

export default OpenAIPHotspotListParametersSchema;
