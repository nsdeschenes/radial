import {z} from 'zod';

import OpenAIPCountrySchema from '#/clients/OpenAIP/schemas/OpenAIPCountrySchema.js';

const OpenAIPAirportSchema = z
  .object({
    _id: z
      .string()
      .optional()
      .meta({description: "The document's internal reference ID value."}),
    name: z.string().optional(),
    icaoCode: z.string().regex(new RegExp('^[A-Z]{4}$')).optional(),
    iataCode: z.string().regex(new RegExp('^[A-Z]{3}$')).optional(),
    altIdentifier: z.string().optional(),
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
      ])
      .optional()
      .meta({
        description:
          'The type of the airport. Possible values: \n\n 0: Airport (civil/military)\n\n1: Glider Site\n\n2: Airfield Civil\n\n3: International Airport\n\n4: Heliport Military\n\n5: Military Aerodrome\n\n6: Ultra Light Flying Site\n\n7: Heliport Civil\n\n8: Aerodrome Closed\n\n9: Airport resp. Airfield IFR\n\n10: Airfield Water\n\n11: Landing Strip\n\n12: Agricultural Landing Strip\n\n13: Altiport',
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
    trafficType: z
      .array(
        z.union([z.literal(0), z.literal(1)]).meta({
          description:
            'The type of the airport traffic. Possible values: \n\n 0: VFR \n\n1: IFR',
        })
      )
      .min(1)
      .optional(),
    magneticDeclination: z.number().optional(),
    ppr: z.boolean().optional(),
    private: z.boolean().optional(),
    skydiveActivity: z.boolean().optional(),
    winchOnly: z.boolean().optional(),
    services: z
      .object({
        fuelTypes: z
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
              ])
              .meta({
                description:
                  'Available fuel types. Possible values: \n\n 0: Super PLUS\n\n1: AVGAS\n\n2: Jet A\n\n3: Jet A1\n\n4: Jet B\n\n5: Diesel\n\n6: AVGAS UL91',
              })
          )
          .optional(),
        chargingStations: z
          .array(
            z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
              description:
                'Available charging stations. Possible values: \n\n 0: CCS-E\n\n1: CCS1\n\n2: CCS2',
            })
          )
          .optional(),
        gliderTowing: z
          .array(
            z
              .union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
                z.literal(4),
                z.literal(5),
              ])
              .meta({
                description:
                  'Available glider towing capabilties. Possible values: \n\n 0: Self Launch\n\n1: Winch\n\n2: Tow\n\n3: Auto Tow\n\n4: Bungee\n\n5: Gravity Powered',
              })
          )
          .optional(),
        handlingFacilities: z
          .array(
            z
              .union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
                z.literal(4),
              ])
              .meta({
                description:
                  'Available handling facilities. Possible values: \n\n 0: Cargo Handling\n\n1: De-Icing\n\n2: Maintenance\n\n3: Security\n\n4: Shelter',
              })
          )
          .optional(),
        passengerFacilities: z
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
                z.literal(8),
                z.literal(9),
              ])
              .meta({
                description:
                  'Available passenger facilities. Possible values: \n\n 0: Bank Office\n\n1: Post Office\n\n2: Customs\n\n3: Lodging\n\n4: Medical Facility\n\n5: Restaurant\n\n6: Sanitation\n\n7: Transportation\n\n8: Laundry Service\n\n9: Camping',
              })
          )
          .optional(),
      })
      .strict()
      .optional(),
    frequencies: z
      .array(
        z
          .object({
            _id: z
              .string()
              .optional()
              .meta({description: "The document's internal reference ID value."}),
            value: z.string().regex(new RegExp('^\\d{3}\\.\\d{3}$')),
            unit: z.literal(2).meta({description: "The frequency unit. Always 'MHz'."}),
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
              ])
              .meta({
                description:
                  'The frequency type. Possible values: \n\n 0: Approach\n\n1: APRON\n\n2: Arrival\n\n3: Center\n\n4: CTAF\n\n5: Delivery\n\n6: Departure\n\n7: FIS\n\n8: Gliding\n\n9: Ground\n\n10: Information\n\n11: Multicom\n\n12: Unicom\n\n13: Radar\n\n14: Tower\n\n15: ATIS\n\n16: Radio\n\n17: Other\n\n18: AIRMET\n\n19: AWOS\n\n20: Lights\n\n21: VOLMET\n\n22: AFIS\n\n23: ASOS\n\n24: AWIS\n\n25: Emergency\n\n26: Clearance Delivery\n\n27: Remote Com Outlet\n\n28: Ground Com Outlet\n\n29: Flight Service Station\n\n30: Class C\n\n31: Class B\n\n32: VFR Advisory\n\n33: TRSA',
              }),
            name: z.string().optional(),
            primary: z.boolean(),
            publicUse: z.boolean(),
            remarks: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    runways: z
      .array(
        z
          .object({
            _id: z
              .string()
              .optional()
              .meta({description: "The document's internal reference ID value."}),
            designator: z
              .string()
              .regex(new RegExp('^(0[1-9]|[1-2]\\d|1[0-9]|2[0-9]|3[0-6])[LCR]?$')),
            trueHeading: z.number().int().min(0).max(360),
            alignedTrueNorth: z.boolean(),
            operations: z.union([z.literal(0), z.literal(1), z.literal(2)]).meta({
              description:
                'The type of the operations. Possible values: \n\n 0: Active\n\n1: Temporarily Closed\n\n2: Closed',
            }),
            mainRunway: z.boolean(),
            turnDirection: z
              .union([z.literal(0), z.literal(1), z.literal(2)])
              .optional()
              .meta({
                description:
                  'Allowed take-off/landing turn directions for this runway. Possible values: \n\n 0: Right\n\n1: Left\n\n2: Both',
              }),
            landingOnly: z.boolean().optional(),
            takeOffOnly: z.boolean().optional(),
            surface: z
              .object({
                composition: z
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
                      ])
                      .meta({
                        description:
                          'The runway composition. Possible values: \n\n 0: Asphalt\n\n1: Concrete\n\n2: Grass\n\n3: Sand\n\n4: Water\n\n5: Bituminous tar or asphalt ("earth cement")\n\n6: Brick\n\n7: Macadam or tarmac surface consisting of water-bound crushed rock\n\n8: Stone\n\n9: Coral\n\n10: Clay\n\n11: Laterite - a high iron clay formed in tropical areas\n\n12: Gravel\n\n13: Earth\n\n14: Ice\n\n15: Snow\n\n16: Protective laminate usually made of rubber\n\n17: Metal\n\n18: Landing mat portable system usually made of aluminium\n\n19: Pierced steel planking\n\n20: Wood\n\n21: Non Bituminous mix\n\n22: Unknown',
                      })
                  )
                  .min(1),
                mainComposite: z
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
                  ])
                  .meta({
                    description:
                      'The runway main composite. Possible values: \n\n 0: Asphalt\n\n1: Concrete\n\n2: Grass\n\n3: Sand\n\n4: Water\n\n5: Bituminous tar or asphalt ("earth cement")\n\n6: Brick\n\n7: Macadam or tarmac surface consisting of water-bound crushed rock\n\n8: Stone\n\n9: Coral\n\n10: Clay\n\n11: Laterite - a high iron clay formed in tropical areas\n\n12: Gravel\n\n13: Earth\n\n14: Ice\n\n15: Snow\n\n16: Protective laminate usually made of rubber\n\n17: Metal\n\n18: Landing mat portable system usually made of aluminium\n\n19: Pierced steel planking\n\n20: Wood\n\n21: Non Bituminous mix\n\n22: Unknown',
                  }),
                condition: z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                    z.literal(5),
                  ])
                  .meta({
                    description:
                      'The runway main composite. Possible values: \n\n 0: Good\n\n1: Fair\n\n2: Poor\n\n3: Unsafe\n\n4: Deformed\n\n5: Unknown',
                  }),
                mtow: z
                  .union([
                    z
                      .object({
                        value: z.number(),
                        unit: z.literal(9).meta({
                          description:
                            "The maximum take-off weight permitted on the runway. Always 'tons'.",
                        }),
                      })
                      .strict(),
                    z.null(),
                  ])
                  .optional(),
                pcn: z
                  .union([
                    z
                      .string()
                      .regex(
                        new RegExp(
                          '^([1-9]|0?[1-9][0-9]|1[0-9][0-9]|2[0][0])/([fF,rR]{1})/([aA,bB,cC,dD]{1})/([wW,xX,yY,zZ]{1})/([tT,uU]{1})$'
                        )
                      ),
                    z.null(),
                  ])
                  .optional(),
                remarks: z.string().optional(),
              })
              .strict(),
            dimension: z
              .object({
                length: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict(),
                width: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict(),
              })
              .strict(),
            declaredDistance: z
              .object({
                tora: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict()
                  .optional(),
                toda: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict()
                  .optional(),
                asda: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict()
                  .optional(),
                lda: z
                  .object({
                    value: z.number().int(),
                    unit: z
                      .literal(0)
                      .meta({description: 'The distance unit. Always meters.'}),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
            thresholdLocation: z
              .object({
                geometry: z
                  .object({
                    type: z.literal('Point'),
                    coordinates: z.array(z.unknown()).min(2).max(2),
                  })
                  .strict(),
                elevation: z
                  .object({
                    value: z.number(),
                    unit: z
                      .literal(0)
                      .meta({description: "The elevation unit. Always 'meters'."}),
                    referenceDatum: z.literal(1).optional().meta({
                      description: "The elevation reference datum. Always 'MSL'.",
                    }),
                  })
                  .strict(),
              })
              .strict()
              .optional(),
            exclusiveAircraftType: z
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
                    z.literal(8),
                    z.literal(9),
                    z.literal(10),
                    z.literal(11),
                    z.literal(12),
                    z.literal(13),
                  ])
                  .meta({
                    description:
                      'If set, the runway may only be exclusively used by the specified aircraft types. Possible values: \n\n 0: Single Engine Piston\n\n1: Single Engine Turbine\n\n2: Multi Engine Piston\n\n3: Multi Engine\n\n4: High Performance Aircraft\n\n5: Touring Motor Glider\n\n6: Experimental\n\n7: Very Light Aircraft\n\n8: Glider\n\n9: Light Sport Aircraft\n\n10: Ultra Light Aircraft\n\n11: Hang Glider\n\n12: Paraglider\n\n13: Balloon',
                  })
              )
              .optional(),
            pilotCtrlLighting: z.boolean().optional(),
            lightingSystem: z
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
                    z.literal(8),
                    z.literal(9),
                  ])
                  .meta({
                    description:
                      'Available lighting systems for this runway. Possible values are: \n\n 0: Runway End Identifier Lights\n\n1: Runway End Lights\n\n2: Runway Edge Lights\n\n3: Runway Center Line Lighting System\n\n4: Touchdown Zone Lights\n\n5: Taxiway Centerline Lead Off Lights\n\n6: Taxiway Centerline Lead On Lights\n\n7: Land And Hold Short Lights\n\n8: Approach Lighting System\n\n9: Threshold Lights',
                  })
              )
              .optional(),
            visualApproachAids: z
              .array(
                z
                  .union([
                    z.literal(0),
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                  ])
                  .meta({
                    description:
                      'Available visual approach aids on this runway. Possible values: \n\n 0: Visual Approach Slope Indicator\n\n1: Precision Approach Path Indicator\n\n2: Tri-Color Visual Approach Slope Indicator\n\n3: Pulsating Visual Approach Slope Indicator\n\n4: Alignment Of Elements System',
                  })
              )
              .optional(),
            instrumentApproachAids: z
              .array(
                z
                  .object({
                    _id: z
                      .string()
                      .optional()
                      .meta({description: "The document's internal reference ID value."}),
                    identifier: z.string().regex(new RegExp('^[A-Z0-9]{1,}')).optional(),
                    frequency: z
                      .object({
                        value: z.string().regex(new RegExp('^\\d{3}\\.\\d{3}$')),
                        unit: z.union([z.literal(1), z.literal(2)]).meta({
                          description:
                            'The navaid frequency. Possible values: \n\n1: kHz\n\n2: MHz',
                        }),
                      })
                      .strict(),
                    channel: z
                      .string()
                      .regex(new RegExp('^(\\d{1,3})([X,Y])$'))
                      .optional(),
                    alignedTrueNorth: z.boolean(),
                    type: z
                      .union([
                        z.literal(0),
                        z.literal(1),
                        z.literal(2),
                        z.literal(3),
                        z.literal(4),
                        z.literal(5),
                      ])
                      .meta({
                        description:
                          'Instrument approach type. Possible values: \n\n 0: ILS - Instrument Landing System\n\n1: LOC - Localizer Approach\n\n2: LDA - Localizer Type Directional Aid Approach\n\n3: L- Locator (Compass Locator)\n\n4: DME - Distance Measuring Equipment\n\n5: GP - Glide Path',
                      }),
                    hoursOfOperation: z
                      .object({
                        operatingHours: z
                          .array(
                            z.union([
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  startTime: z
                                    .string()
                                    .regex(
                                      new RegExp(
                                        '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                                      )
                                    ),
                                  endTime: z
                                    .string()
                                    .regex(
                                      new RegExp(
                                        '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                                      )
                                    ),
                                  sunrise: z.literal(false),
                                  sunset: z.literal(false),
                                  byNotam: z.literal(false),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  startTime: z
                                    .string()
                                    .regex(
                                      new RegExp(
                                        '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                                      )
                                    ),
                                  sunrise: z.literal(false),
                                  sunset: z.literal(true),
                                  byNotam: z.literal(false),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  endTime: z
                                    .string()
                                    .regex(
                                      new RegExp(
                                        '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                                      )
                                    ),
                                  sunrise: z.literal(true),
                                  sunset: z.literal(false),
                                  byNotam: z.literal(false),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  sunrise: z.literal(true),
                                  sunset: z.literal(true),
                                  byNotam: z.literal(false),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  sunrise: z.literal(false),
                                  sunset: z.literal(false),
                                  byNotam: z.literal(false),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                              z
                                .object({
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
                                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                                    }),
                                  sunrise: z.literal(false),
                                  sunset: z.literal(false),
                                  byNotam: z.literal(true),
                                  publicHolidaysExcluded: z.boolean(),
                                  remarks: z.string().optional(),
                                })
                                .strict(),
                            ])
                          )
                          .min(1)
                          .optional(),
                        remarks: z.string().optional(),
                      })
                      .strict()
                      .meta({
                        description:
                          'Defines the hours of operation for this instrument approach aid.',
                      }),
                    remarks: z.string().optional(),
                  })
                  .strict()
              )
              .optional(),
            remarks: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    hoursOfOperation: z
      .object({
        operatingHours: z
          .array(
            z.union([
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  startTime: z
                    .string()
                    .regex(
                      new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')
                    ),
                  endTime: z
                    .string()
                    .regex(
                      new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')
                    ),
                  sunrise: z.literal(false),
                  sunset: z.literal(false),
                  byNotam: z.literal(false),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  startTime: z
                    .string()
                    .regex(
                      new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')
                    ),
                  sunrise: z.literal(false),
                  sunset: z.literal(true),
                  byNotam: z.literal(false),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  endTime: z
                    .string()
                    .regex(
                      new RegExp('^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$')
                    ),
                  sunrise: z.literal(true),
                  sunset: z.literal(false),
                  byNotam: z.literal(false),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  sunrise: z.literal(true),
                  sunset: z.literal(true),
                  byNotam: z.literal(false),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  sunrise: z.literal(false),
                  sunset: z.literal(false),
                  byNotam: z.literal(false),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
              z
                .object({
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
                        'Possible values: \n\n 0: Monday\n\n1: Tuesday\n\n2: Wednesday\n\n3: Thursday\n\n4: Friday\n\n5: Staturday\n\n6: Sunday',
                    }),
                  sunrise: z.literal(false),
                  sunset: z.literal(false),
                  byNotam: z.literal(true),
                  publicHolidaysExcluded: z.boolean(),
                  remarks: z.string().optional(),
                })
                .strict(),
            ])
          )
          .min(1)
          .optional(),
        remarks: z.string().optional(),
      })
      .strict()
      .optional()
      .meta({description: 'Defines the hours of operation for this airport.'}),
    contact: z.string().optional(),
    remarks: z.string().optional(),
    telephoneServices: z
      .array(
        z
          .object({
            name: z.string(),
            phoneNumber: z.string(),
            remarks: z.string().optional(),
          })
          .strict()
          .meta({
            description: 'A single telephone service that is available at an airport.',
          })
      )
      .optional(),
    images: z
      .array(
        z
          .object({
            _id: z
              .string()
              .optional()
              .meta({description: "The document's internal reference ID value."}),
            filename: z.string(),
            description: z.string().optional(),
          })
          .strict()
      )
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
  })
  .loose()
  .meta({description: 'Response payload of an airport instance.'});

export default OpenAIPAirportSchema;
