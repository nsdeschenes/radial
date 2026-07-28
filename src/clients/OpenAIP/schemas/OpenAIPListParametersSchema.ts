import {z} from 'zod';

const OpenAIPListParametersSchema = z.strictObject({
  page: z.number().int().optional().meta({
    description:
      "Defines which page to return. Used with query parameter 'limit' to paginate through large result lists. Page numbers start at 1. Defaults to 1.",
  }),
  limit: z.number().int().optional().meta({
    description:
      'Defines maximum item count retrieved per page. Default value depends on the called API service, usually defaults to 1000.',
  }),
  fields: z.string().optional().meta({
    description:
      'A comma separated list of field names that should be available on returned objects in the list. If not specified, all available object fields will be returned.',
  }),
  pos: z.string().optional().meta({
    description:
      "A position defined by decimal coordinates. If set, endpoint will only return documents that are within a specific radius around the requested coordinates. Radius can be defined by using the query parameter 'dist'. If not set, endpoints will usually set a default value for the radius.",
  }),
  dist: z.number().int().optional().meta({
    description:
      'Distance in meters around specified position if defined. If not set, endpoints will usually set a default value.',
  }),
  bbox: z.string().optional().meta({
    description:
      "A comma separated list of lat/lon values that define a bound box of an area of interest (AOI). The bbox must be defined as 'minx,miny,maxx,maxy'.",
  }),
  sortBy: z.string().optional().meta({
    description:
      "Sort query results by specified field. If set, the query parameter 'sortDesc' can be used to change sort direction. If 'sortDesc' is not set, default sort is ascending order.",
  }),
  sortDesc: z.boolean().optional().meta({
    description:
      "Sort query results in ascending order. Only applies if 'sortBy' is set. Defaults to false.",
  }),
  country: z
    .string()
    .optional()
    .meta({description: 'Search by ISO alpha-2 country code.'}),
  updatedAfter: z
    .string()
    .optional()
    .meta({description: 'An URI encoded ISO 3601 UTC timestring.'}),
  searchOptLwc: z.boolean().optional().meta({
    description:
      "If true, uses leading wildcard regex to search results. This can be used to find something that 'contains' the input string. Defaults to false and uses leading wildcard search.",
  }),
  id: z.string().optional().meta({description: 'A document reference ID.'}),
});

export default OpenAIPListParametersSchema;
