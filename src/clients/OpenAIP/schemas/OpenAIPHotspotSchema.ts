import {z} from 'zod';

import OpenAIPCountrySchema from '#radial/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPHotspotSchema = z
  .looseObject({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    name: z.string().optional(),
    type: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .meta({
        description:
          'The hotspot type. Possible values: \n\n 0: natural\n\n1: artificial',
      }),
    reliability: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .meta({
        description:
          'The hotspot reliability. Possible values: \n\n 0: poor\n\n1: fair\n\n2: high\n\n3: very high',
      }),
    occurrence: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .meta({
        description:
          'The hotspot occurrence. Possible values: \n\n 0: irregular intervals\n\n1: scheduled interval\n\n2: nearly constant',
      }),
    category: z
      .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
      .min(1)
      .optional()
      .meta({
        description:
          'If set, the hotspot is only suitable for the specified aircraft category. Possible values: \n\n 0: Glider\n\n1: Hang Glider\n\n2: Paraglider',
      }),
    country: OpenAIPCountrySchema.optional().meta({
      description:
        'A valid 2-digit ISO country code (ISO 3166-1 alpha-2), or, an array of valid ISO codes.',
    }),
    geometry: z
      .strictObject({
        type: z.literal('Point'),
        coordinates: z.array(z.unknown()).min(2).max(2),
      })
      .optional(),
    elevation: z
      .strictObject({
        value: z.number(),
        unit: z.literal(0).meta({description: "The elevation unit. Always 'meters'."}),
        referenceDatum: z
          .literal(1)
          .optional()
          .meta({description: "The elevation reference datum. Always 'MSL'."}),
      })
      .optional(),
    elevationGeoid: z
      .strictObject({
        hae: z.number().meta({description: 'Height above ellipsoid in meters.'}),
        geoidHeight: z.number().meta({description: 'Height of geoid in meters.'}),
      })
      .optional(),
    timeOfDay: z
      .array(
        z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .meta({
            description:
              'The time of day that this hotspot may work. Possible values: \n\n 0: early morning\n\n1: morning\n\n2: noon\n\n3: afternoon\n\n4: evening',
          })
      )
      .min(1)
      .optional(),
    favTimeOfDay: z
      .array(
        z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .meta({
            description:
              'The time of day that this hotspot works best. Possible values: \n\n 0: early morning\n\n1: morning\n\n2: noon\n\n3: afternoon\n\n4: evening',
          })
      )
      .optional(),
    favWindDirection: z
      .array(
        z
          .union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(6),
            z.literal(7),
          ])
          .meta({
            description:
              'The wind direction that this hotspot works best. Possible values: \n\n 0: N\n\n1: NE\n\n2: E\n\n3: SE\n\n4: S\n\n5: SW\n\n6: W\n\n7: NW',
          })
      )
      .optional(),
    reqWindDirection: z
      .array(
        z
          .union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(6),
            z.literal(7),
          ])
          .meta({
            description:
              'The wind direction that this hotspot requires to work. Possible values: \n\n 0: N\n\n1: NE\n\n2: E\n\n3: SE\n\n4: S\n\n5: SW\n\n6: W\n\n7: NW',
          })
      )
      .optional(),
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
  .meta({description: 'Response payload of a hotspot instance.'});

export default OpenAIPHotspotSchema;
