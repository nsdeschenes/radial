import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type AirportRoutePoint = RoutePlannerTypes['AirportRoutePoint'];
type MagneticReferenceMetadata = RoutePlannerTypes['RoutePlan']['magneticReference'];
type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];

type AirportResolution = Readonly<{
  departure: readonly AirportRoutePoint[];
  arrival: readonly AirportRoutePoint[];
}>;

type VorCandidate = Readonly<{
  routePoint: VorFamilyRoutePoint;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

const VOR_FAMILIES = ['VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC'] as const;

class PlannerRepository {
  readonly #instance: DuckDBInstance;
  readonly magneticReference: MagneticReferenceMetadata;

  constructor(instance: DuckDBInstance, magneticReference: MagneticReferenceMetadata) {
    this.#instance = instance;
    this.magneticReference = magneticReference;
  }

  async withConnection<Value>(
    operation: (connection: DuckDBConnection) => Promise<Value>
  ): Promise<Value> {
    const connection = await this.#instance.connect();
    try {
      return await operation(connection);
    } finally {
      connection.closeSync();
    }
  }

  async resolveAirports(
    connection: DuckDBConnection,
    departureIcao: string,
    arrivalIcao: string
  ): Promise<AirportResolution> {
    const reader = await connection.runAndReadAll(
      `SELECT
        database_id,
        upper(trim(icao)) AS icao,
        name,
        longitude,
        latitude,
        magnetic_declination_deg_east
      FROM planner_airports
      WHERE upper(trim(icao)) IN (?, ?)
        AND database_id IS NOT NULL AND trim(database_id) <> ''
        AND name IS NOT NULL AND trim(name) <> ''`,
      [departureIcao, arrivalIcao]
    );
    const airports = reader.getRowObjectsJS().map(toAirportRoutePoint);

    return {
      departure: airports.filter(airport => airport.icao === departureIcao),
      arrival: airports.filter(airport => airport.icao === arrivalIcao),
    };
  }

  async directDistanceNm(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint
  ): Promise<number> {
    const reader = await connection.runAndReadAll(
      `SELECT ST_Distance_Sphere(
        ST_Point(?, ?),
        ST_Point(?, ?)
      ) / 1852.0 AS distance_nm`,
      [departure.latitude, departure.longitude, arrival.latitude, arrival.longitude]
    );

    return Number(reader.getRowObjectsJS()[0]?.['distance_nm']);
  }

  async findVorCandidates(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint
  ): Promise<readonly VorCandidate[]> {
    const reader = await connection.runAndReadAll(
      `SELECT
        database_id,
        identifier,
        name,
        family,
        longitude,
        latitude,
        frequency_value,
        published_range_nm,
        magnetic_declination_deg_east,
        facility_variation_deg_east,
        facility_variation_source,
        CAST(facility_variation_effective_date AS VARCHAR)
          AS facility_variation_effective_date,
        ST_Distance_Sphere(
          ST_Point(?, ?),
          ST_Point(latitude, longitude)
        ) / 1852.0 AS departure_distance_nm,
        ST_Distance_Sphere(
          ST_Point(latitude, longitude),
          ST_Point(?, ?)
        ) / 1852.0 AS arrival_distance_nm
      FROM planner_navaids
      WHERE family IN ('VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC')
        AND database_id IS NOT NULL AND trim(database_id) <> ''
        AND identifier IS NOT NULL AND trim(identifier) <> ''
        AND name IS NOT NULL AND trim(name) <> ''
        AND frequency_unit = 'MHz'
        AND frequency_value IS NOT NULL AND isfinite(frequency_value)
        AND frequency_value > 0
        AND published_range_nm IS NOT NULL AND isfinite(published_range_nm)
        AND published_range_nm > 0`,
      [departure.latitude, departure.longitude, arrival.latitude, arrival.longitude]
    );

    return reader.getRowObjectsJS().map(row => ({
      routePoint: toVorFamilyRoutePoint(row),
      departureDistanceNm: Number(row['departure_distance_nm']),
      arrivalDistanceNm: Number(row['arrival_distance_nm']),
    }));
  }
}

function toAirportRoutePoint(row: Readonly<Record<string, unknown>>): AirportRoutePoint {
  return {
    kind: 'airport',
    databaseId: String(row['database_id']),
    icao: String(row['icao']),
    name: String(row['name']),
    longitude: Number(row['longitude']),
    latitude: Number(row['latitude']),
    magneticDeclinationDegEast: nullableNumber(row['magnetic_declination_deg_east']),
  };
}

function toVorFamilyRoutePoint(
  row: Readonly<Record<string, unknown>>
): VorFamilyRoutePoint {
  const family = String(row['family']);
  if (!isVorFamily(family)) {
    throw new Error(`Unexpected VOR-family value: ${family}`);
  }

  const facilityVariationDegEast = nullableNumber(row['facility_variation_deg_east']);
  return {
    kind: 'vor-family',
    databaseId: String(row['database_id']),
    identifier: String(row['identifier']),
    name: String(row['name']),
    family,
    longitude: Number(row['longitude']),
    latitude: Number(row['latitude']),
    frequency: {unit: 'MHz', value: Number(row['frequency_value'])},
    publishedRangeNm: Number(row['published_range_nm']),
    magneticDeclinationDegEast: nullableNumber(row['magnetic_declination_deg_east']),
    facilityVariation:
      facilityVariationDegEast === null
        ? null
        : {
            degreesEast: facilityVariationDegEast,
            source: String(row['facility_variation_source']),
            effectiveDate: nullableString(row['facility_variation_effective_date']),
          },
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Expected a nullable database string value.');
  }
  return value;
}

function isVorFamily(value: string): value is VorFamilyRoutePoint['family'] {
  return (VOR_FAMILIES as readonly string[]).includes(value);
}

export default PlannerRepository;
