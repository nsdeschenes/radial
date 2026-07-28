import {z} from 'zod';

import OpenAIPListParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPAirspaceListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns airspaces where searchable fields match the input string. Search is case-insensitive. Searchable fields are: name and identifier.',
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
        z.literal(9),
        z.literal(10),
        z.literal(11),
        z.literal(12),
        z.literal(13),
        z.literal(14),
        z.literal(15),
        z.literal(16),
        z.literal(17),
        z.literal(18),
        z.literal(19),
        z.literal(20),
        z.literal(21),
        z.literal(22),
        z.literal(23),
        z.literal(24),
        z.literal(25),
        z.literal(26),
        z.literal(27),
        z.literal(28),
        z.literal(29),
        z.literal(30),
        z.literal(31),
        z.literal(32),
        z.literal(33),
        z.literal(34),
        z.literal(35),
        z.literal(36),
      ])
    )
    .optional()
    .meta({description: 'Show only airspaces of the provided types.'}),
  icaoClass: z
    .array(
      z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(8),
      ])
    )
    .optional()
    .meta({description: 'Show only airspaces of the provided ICAO classes.'}),
  activity: z
    .array(
      z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ])
    )
    .optional()
    .meta({
      description:
        'Show only airspaces that are exclusively reserved for the specified activities.',
    }),
  onDemand: z.boolean().optional().meta({
    description: 'If true only shows airspaces that are activated on demand.',
  }),
  onRequest: z.boolean().optional().meta({
    description: 'If true only shows airspaces that are activated on request.',
  }),
  byNotam: z.boolean().optional().meta({
    description: 'If true only shows airspaces that are activated by NOTAM.',
  }),
  specialAgreement: z.boolean().optional().meta({
    description:
      'If true only shows airspaces that are regulated by a special agreement.',
  }),
  requestCompliance: z.boolean().optional().meta({
    description: 'If true only shows unofficial airspaces that request pilot compliance.',
  }),
}).meta({description: 'Query parameters for a list of airspaces.'});

export default OpenAIPAirspaceListParametersSchema;
