import {z} from 'zod';

import OpenAIPAirportSchema from '#/clients/OpenAIP/schemas/OpenAIPAirportSchema.js';

const OpenAIPAirportListSchema = z
  .object({
    page: z
      .number()
      .int()
      .meta({description: 'The requested page. Page numbers start at 1.'}),
    limit: z.number().int().meta({description: 'The maximum items per requested page.'}),
    totalCount: z
      .number()
      .int()
      .meta({description: "The query's result total item count."}),
    totalPages: z
      .number()
      .int()
      .meta({description: "The query's result total page count."}),
    nextPage: z.number().int().optional().meta({
      description:
        'The number of the next page that can be requested. If no more pages exist, nextPage is not set.',
    }),
    items: z
      .array(OpenAIPAirportSchema)
      .meta({description: 'Contains the actual query result items in JSON format.'}),
  })
  .loose()
  .meta({description: 'Response schema of a paginated list of airports.'});

export default OpenAIPAirportListSchema;
