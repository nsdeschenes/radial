import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type AirportRoutePoint = RoutePlannerTypes['AirportRoutePoint'];
type MagneticReferenceMetadata = RoutePlannerTypes['RoutePlan']['magneticReference'];
type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];
type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];

type AirportResolution = Readonly<{
  departure: readonly AirportRoutePoint[];
  arrival: readonly AirportRoutePoint[];
}>;

type VorFamilyCandidate = Readonly<{
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

  async findVorFamilyCandidates(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint
  ): Promise<readonly VorFamilyCandidate[]> {
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
      WHERE ${vorFamilyCandidateFilter()}`,
      [departure.latitude, departure.longitude, arrival.latitude, arrival.longitude]
    );

    return reader.getRowObjectsJS().map(row => ({
      routePoint: toVorFamilyRoutePoint(row),
      departureDistanceNm: Number(row['departure_distance_nm']),
      arrivalDistanceNm: Number(row['arrival_distance_nm']),
    }));
  }

  async findVorFamilyNavaidPairs(
    connection: DuckDBConnection
  ): Promise<readonly NavaidPairDistance[]> {
    const reader = await connection.runAndReadAll(`
      SELECT
        first.database_id AS first_database_id,
        second.database_id AS second_database_id,
        ST_Distance_Sphere(
          ST_Point(first.latitude, first.longitude),
          ST_Point(second.latitude, second.longitude)
        ) / 1852.0 AS distance_nm
      FROM planner_navaids AS first
      JOIN planner_navaids AS second
        ON first.database_id < second.database_id
      WHERE ${vorFamilyCandidateFilter('first')}
        AND ${vorFamilyCandidateFilter('second')}
    `);

    return reader.getRowObjectsJS().map(row => ({
      firstDatabaseId: requiredString(row['first_database_id']),
      secondDatabaseId: requiredString(row['second_database_id']),
      distanceNm: Number(row['distance_nm']),
    }));
  }
}

function vorFamilyCandidateFilter(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `${prefix}family IN ('VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC')
    AND ${prefix}database_id IS NOT NULL AND trim(${prefix}database_id) <> ''
    AND ${prefix}identifier IS NOT NULL AND trim(${prefix}identifier) <> ''
    AND ${prefix}name IS NOT NULL AND trim(${prefix}name) <> ''
    AND ${prefix}frequency_unit = 'MHz'
    AND ${prefix}frequency_value IS NOT NULL AND isfinite(${prefix}frequency_value)
    AND ${prefix}frequency_value > 0
    AND ${prefix}published_range_nm IS NOT NULL
    AND isfinite(${prefix}published_range_nm)
    AND ${prefix}published_range_nm > 0`;
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

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a database string value.');
  }
  return value;
}

function isVorFamily(value: string): value is VorFamilyRoutePoint['family'] {
  return (VOR_FAMILIES as readonly string[]).includes(value);
}

export default PlannerRepository;
