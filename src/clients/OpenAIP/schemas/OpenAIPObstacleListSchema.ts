import {z} from 'zod';

import OpenAIPObstacleSchema from '#/clients/OpenAIP/schemas/OpenAIPObstacleSchema.js';

const OpenAIPObstacleListSchema = z
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
      .array(OpenAIPObstacleSchema)
      .meta({description: 'Contains the actual query result items in JSON format.'}),
  })
  .loose()
  .meta({description: 'Response schema of a paginated list of obstacles.'});

export default OpenAIPObstacleListSchema;
