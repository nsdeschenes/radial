import {z} from 'zod';

import OpenAIPListParametersSchema from '#/clients/OpenAIP/schemas/OpenAIPListParametersSchema.js';

const OpenAIPAirportListParametersSchema = OpenAIPListParametersSchema.extend({
  search: z.string().optional().meta({
    description:
      'Searches and returns airports where searchable fields match the input string. Search is case-insensitive. Searchable fields are: name, icaoCode, iataCode and altIdentifier.',
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
      ])
    )
    .optional()
    .meta({description: 'Show only airports of the provided types.'}),
  trafficType: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .optional()
    .meta({description: 'Show only airports that allow the provided traffic types.'}),
  ppr: z
    .boolean()
    .optional()
    .meta({description: 'If true shows only airfields that are PPR.'}),
  private: z
    .boolean()
    .optional()
    .meta({description: 'If true shows only airfields that are private.'}),
  skydiveActivity: z.boolean().optional().meta({
    description: 'If true shows only airfields that are have skydive activity.',
  }),
  winchOnly: z.boolean().optional().meta({
    description: 'If true shows only airfields that allow winch launch only.',
  }),
  servicesFuelType: z
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
        'Only show airports that provide at least one of the provided fuel types.',
    }),
  servicesGliderTowing: z
    .array(
      z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ])
    )
    .optional()
    .meta({
      description:
        'Only show airports that provide at least one of the provided glider towing types.',
    }),
  servicesHandlingFacility: z
    .array(
      z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    )
    .optional()
    .meta({
      description:
        'Only show airports that provide at least one of the provided handling facilities.',
    }),
  servicesPassengerFacility: z
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
      ])
    )
    .optional()
    .meta({
      description:
        'Only show airports that provide at least one of the provided passenger facilities.',
    }),
}).meta({description: 'Query parameters for a list of airports.'});

export default OpenAIPAirportListParametersSchema;
