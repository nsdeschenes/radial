import {z} from 'zod';

import OpenAIPCountrySchema from '#/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPAirspaceSchema = z
  .looseObject({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    name: z.string().optional(),
    dataIngestion: z.boolean().optional().meta({
      description:
        ' Indicates if this airspace was created by a data ingestion process - this also means that it will be removed when the next data ingestion process is run. During data ingestion, only airspaces that are marked as "true" will be removed/replaced. This flag is set internally and cannot be edited.',
    }),
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
      .optional()
      .meta({
        description:
          'The airspace type. Possible values: \n\n 0: Other\n\n1: Restricted\n\n2: Danger\n\n3: Prohibited\n\n4: Controlled Tower Region (CTR)\n\n5: Transponder Mandatory Zone (TMZ)\n\n6: Radio Mandatory Zone (RMZ)\n\n7: Terminal Maneuvering Area (TMA)\n\n8: Temporary Reserved Area (TRA)\n\n9: Temporary Segregated Area (TSA)\n\n10: Flight Information Region (FIR)\n\n11: Upper Flight Information Region (UIR)\n\n12: Air Defense Identification Zone (ADIZ)\n\n13: Airport Traffic Zone (ATZ)\n\n14: Military Airport Traffic Zone (MATZ)\n\n15: Airway\n\n16: Military Training Route (MTR)\n\n17: Alert Area\n\n18: Warning Area\n\n19: Protected Area\n\n20: Helicopter Traffic Zone (HTZ)\n\n21: Gliding Sector\n\n22: Transponder Setting (TRP)\n\n23: Traffic Information Zone (TIZ)\n\n24: Traffic Information Area (TIA)\n\n25: Military Training Area (MTA)\n\n26: Control Area (CTA)\n\n27: ACC Sector (ACC)\n\n28: Aerial Sporting Or Recreational Activity\n\n29: Low Altitude Overflight Restriction\n\n30: Military Route (MRT)\n\n31: TSA/TRA Feeding Route (TFR)\n\n32: VFR Sector\n\n33: FIS Sector\n\n34: Lower Traffic Area (LTA)\n\n35: Upper Traffic Area (UTA)\n\n36: Military Controlled Tower Region (MCTR)',
      }),
    icaoClass: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(8),
      ])
      .optional()
      .meta({
        description:
          'The airspace ICAO class. Possible values: \n\n 0: A\n\n1: B\n\n2: C\n\n3: D\n\n4: E\n\n5: F\n\n6: G\n\n8: Unclassified / Special Use Airspace (SUA)',
      }),
    activity: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ])
      .optional()
      .meta({
        description:
          "The intended activity for this airspace if defined in 'ENR 5.5 Aerial sporting and recreational activities'. The default activity is 'NONE' which applies to all other airspaces not defined in ENR 5.5. Possible values: \n\n 0: None - No specific activity (default)\n\n1: Parachuting Activity\n\n2: Aerobatics Activity\n\n3: Aeroclub And Arial Work Area\n\n4: Ultra Light Machine (ULM) Activity\n\n5: Hang Gliding/Paragliding",
      }),
    onDemand: z.boolean().optional(),
    onRequest: z.boolean().optional(),
    byNotam: z.boolean().optional(),
    specialAgreement: z.boolean().optional().meta({
      description:
        'Indicates whether this airspace is related to a special agreement or not. Normally, airspaces are not based on a "special agreement" but there may be airspaces that may only be used by members of a certain club or if they personally signed a letter of agreement.',
    }),
    requestCompliance: z.boolean().optional().meta({
      description:
        'An airspace that is most often not found in eAIPs but is defined by other regional/national authorities, e.g. natural reserves and monuments in the US. Those airspaces are not official but authorities request compliance of those if possible. In several cases, aircraft like UAVs are not allowed to enter those airspaces.',
    }),
    geometry: z
      .strictObject({
        type: z.literal('Polygon'),
        coordinates: z
          .array(z.array(z.array(z.unknown()).min(2).max(2)).min(4))
          .min(1)
          .max(1),
      })
      .optional(),
    country: OpenAIPCountrySchema.optional().meta({
      description:
        'A valid 2-digit ISO country code (ISO 3166-1 alpha-2), or, an array of valid ISO codes.',
    }),
    upperLimit: z
      .strictObject({
        value: z.number().int(),
        unit: z.union([z.literal(1), z.literal(0), z.literal(6)]).meta({
          description:
            'The vertical limit unit. Possbile values: \n\n 0: Meter\n\n 1: Feet\n\n 6: Flight Level',
        }),
        referenceDatum: z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
          description:
            'The reference datum. Possible values: \n\n 0: GND\n\n1: MSL\n\n2: STD',
        }),
      })
      .optional()
      .meta({
        description:
          'Defines an airspace vertical limit. The vertical limit is a combination of an integer value, a measurement unit and a reference datum.',
      }),
    lowerLimit: z
      .strictObject({
        value: z.number().int(),
        unit: z.union([z.literal(1), z.literal(0), z.literal(6)]).meta({
          description:
            'The vertical limit unit. Possbile values: \n\n 0: Meter\n\n 1: Feet\n\n 6: Flight Level',
        }),
        referenceDatum: z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
          description:
            'The reference datum. Possible values: \n\n 0: GND\n\n1: MSL\n\n2: STD',
        }),
      })
      .optional()
      .meta({
        description:
          'Defines an airspace vertical limit. The vertical limit is a combination of an integer value, a measurement unit and a reference datum.',
      }),
    upperLimitMax: z
      .strictObject({
        value: z.number().int(),
        unit: z.union([z.literal(1), z.literal(0), z.literal(6)]).meta({
          description:
            'The vertical limit unit. Possbile values: \n\n 0: Meter\n\n 1: Feet\n\n 6: Flight Level',
        }),
        referenceDatum: z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
          description:
            'The reference datum. Possible values: \n\n 0: GND\n\n1: MSL\n\n2: STD',
        }),
      })
      .optional()
      .meta({
        description:
          'Defines the airspace maximum upper vertical limit. This vertical limit is only rarely used in cases where an airspace is required to have a maximum upper vertical limit, e.g. "5000ft MSL but at most 8000ft MSL by request".',
      }),
    lowerLimitMin: z
      .strictObject({
        value: z.number().int(),
        unit: z.union([z.literal(1), z.literal(0), z.literal(6)]).meta({
          description:
            'The vertical limit unit. Possbile values: \n\n 0: Meter\n\n 1: Feet\n\n 6: Flight Level',
        }),
        referenceDatum: z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
          description:
            'The reference datum. Possible values: \n\n 0: GND\n\n1: MSL\n\n2: STD',
        }),
      })
      .optional()
      .meta({
        description:
          'Defines the airspace minimum lower vertical limit. This vertical limit is only rarely used in cases where an airspace is required to have a bare minium vertical limit, e.g. "5000ft MSL but at least 1000ft AGL".',
      }),
    frequencies: z
      .array(
        z.strictObject({
          _id: z
            .string()
            .optional()
            .meta({description: "The document's internal reference ID value."}),
          value: z.string().regex(new RegExp('^\\d{3}\\.\\d{3}$')),
          unit: z.literal(2).meta({description: "The frequency unit. Always 'MHz'."}),
          name: z.string().optional(),
          primary: z.boolean().optional(),
          remarks: z.string().optional(),
        })
      )
      .optional(),
    transponderSettings: z
      .array(
        z.strictObject({
          code: z.string().regex(new RegExp('^[0-7]{4}$')),
          primary: z.boolean(),
          remarks: z.string().optional(),
        })
      )
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
      .meta({description: 'Defines the hours of operation for this airspace.'}),
    activeFrom: z.iso.datetime().optional(),
    activeUntil: z.iso.datetime().optional(),
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
  .meta({description: 'Response payload of a airspace instance.'});

export default OpenAIPAirspaceSchema;
