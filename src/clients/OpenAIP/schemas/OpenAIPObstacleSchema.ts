import {z} from 'zod';

import OpenAIPCountrySchema from '#/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPObstacleSchema = z
  .object({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    osmId: z.string().optional(),
    osmTags: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    type: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional()
      .meta({
        description:
          'The obstacle type. Possible values: \n\n 0: Obstacle\n\n1: Chimney\n\n2: Building\n\n3: Wind Turbine\n\n4: Tower',
      }),
    country: OpenAIPCountrySchema.optional().meta({
      description:
        'A valid 2-digit ISO country code (ISO 3166-1 alpha-2), or, an array of valid ISO codes.',
    }),
    geometry: z
      .object({
        type: z.literal('Point'),
        coordinates: z.array(z.unknown()).min(2).max(2),
      })
      .strict()
      .optional(),
    elevation: z
      .object({
        value: z.number(),
        unit: z.literal(0).meta({description: "The elevation unit. Always 'meters'."}),
        referenceDatum: z
          .literal(1)
          .optional()
          .meta({description: "The elevation reference datum. Always 'MSL'."}),
      })
      .strict()
      .optional(),
    elevationGeoid: z
      .object({
        hae: z.number().meta({description: 'Height above ellipsoid in meters.'}),
        geoidHeight: z.number().meta({description: 'Height of geoid in meters.'}),
      })
      .strict()
      .optional(),
    height: z
      .object({
        value: z.number(),
        unit: z.literal(0).meta({description: "The elevation unit. Always 'meters'."}),
        referenceDatum: z
          .literal(0)
          .optional()
          .meta({description: "Reference datum is always 'GND'."}),
      })
      .strict()
      .optional(),
    createdBy: z
      .string()
      .optional()
      .meta({description: 'UID of user that created this document.'}),
    updatedBy: z
      .string()
      .optional()
      .meta({description: 'UID of user that updated this document.'}),
    createdAt: z.iso
      .datetime()
      .optional()
      .meta({description: 'The creation date for this document as ISO 8601 date.'}),
    updatedAt: z.iso
      .datetime()
      .optional()
      .meta({description: 'The updated date for this document as ISO 8601 date.'}),
    osmImportJobId: z.string().optional(),
    osmUpdatedAt: z.iso
      .datetime()
      .optional()
      .meta({description: 'The time of the last OSM update.'}),
  })
  .loose()
  .meta({description: 'Response payload of a obstacle instance.'});

export default OpenAIPObstacleSchema;
