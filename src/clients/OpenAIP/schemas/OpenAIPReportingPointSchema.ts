import {z} from 'zod';

import OpenAIPCountrySchema from '#/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPReportingPointSchema = z
  .object({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    name: z.string().optional(),
    compulsory: z.boolean().optional(),
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
    airports: z.array(z.string()).optional(),
    remarks: z.string().optional(),
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
  })
  .loose()
  .meta({description: 'Response payload of a reporting point instance.'});

export default OpenAIPReportingPointSchema;
