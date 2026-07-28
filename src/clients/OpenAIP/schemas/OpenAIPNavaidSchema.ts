import {z} from 'zod';

import OpenAIPCountrySchema from '#/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPNavaidSchema = z
  .looseObject({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    name: z.string().optional(),
    type: z
      .union([
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
      .optional()
      .meta({
        description:
          'The navaid type. Possible values: \n\n 0: DME\n\n1: TACAN\n\n2: NDB\n\n3: VOR\n\n4: VOR-DME\n\n5: VORTAC\n\n6: DVOR\n\n7: DVOR-DME\n\n8: DVORTAC',
      }),
    identifier: z.string().regex(new RegExp('^[A-Z0-9]{1,}')).optional(),
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
    magneticDeclination: z.number().optional(),
    alignedTrueNorth: z.boolean().optional(),
    channel: z.string().regex(new RegExp('^(\\d{1,3})([X,Y])$')).optional(),
    frequency: z
      .strictObject({
        value: z.string().regex(new RegExp('^\\d{3}\\.\\d{3}$')),
        unit: z.union([z.literal(1), z.literal(2)]).meta({
          description: 'The navaid frequency. Possible values: \n\n1: kHz\n\n2: MHz',
        }),
      })
      .optional(),
    range: z
      .strictObject({
        value: z.number().int().min(0),
        unit: z.literal(2).meta({description: "The range of the navaid. Always 'NM'."}),
      })
      .optional(),
    hoursOfOperation: z
      .strictObject({
        operatingHours: z
          .array(
            z.union([
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                startTime: z
                  .string()
                  .regex(new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')),
                endTime: z
                  .string()
                  .regex(new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')),
                sunrise: z.literal(false),
                sunset: z.literal(false),
                byNotam: z.literal(false),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                startTime: z
                  .string()
                  .regex(new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')),
                sunrise: z.literal(false),
                sunset: z.literal(true),
                byNotam: z.literal(false),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                endTime: z
                  .string()
                  .regex(new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')),
                sunrise: z.literal(true),
                sunset: z.literal(false),
                byNotam: z.literal(false),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                sunrise: z.literal(true),
                sunset: z.literal(true),
                byNotam: z.literal(false),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                sunrise: z.literal(false),
                sunset: z.literal(false),
                byNotam: z.literal(false),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
              z.strictObject({
                dayOfWeek: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                    z.literal(6),
                  ])
                  .meta({
                    description:
                      'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Saturday\n\n6: Sunday',
                  }),
                sunrise: z.literal(false),
                sunset: z.literal(false),
                byNotam: z.literal(true),
                publicHolidaysExcluded: z.boolean(),
                remarks: z.string().optional(),
              }),
            ])
          )
          .min(1)
          .optional(),
        remarks: z.string().optional(),
      })
      .optional()
      .meta({description: 'Defines the hours of operation for this navaid.'}),
    images: z
      .array(
        z.strictObject({
          _id: z
            .string()
            .optional()
            .meta({description: "The document's internal reference ID value."}),
          filename: z.string(),
          description: z.string().optional(),
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
  .meta({description: 'Response payload of a navaid instance.'});

export default OpenAIPNavaidSchema;
