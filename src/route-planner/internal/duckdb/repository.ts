import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api';

import plannerDatabaseContract from '#radial/planner-database/PlannerDatabaseContract.js';
import type RouteSearchTypes from '#radial/route-planner/internal/RouteSearchTypes.js';
import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type AirportRoutePoint = RoutePlannerTypes['AirportRoutePoint'];
type NdbRoutePoint = RoutePlannerTypes['NdbRoutePoint'];
type VorFamilyRoutePoint = RoutePlannerTypes['VorFamilyRoutePoint'];
type CandidateFamily = RouteSearchTypes['CandidateFamily'];
type NavaidPairDistance = RouteSearchTypes['NavaidPairDistance'];
type RouteSearchDataSource = RouteSearchTypes['RouteSearchDataSource'];

type AirportResolution = Readonly<{
  departure: readonly AirportRoutePoint[];
  arrival: readonly AirportRoutePoint[];
}>;

type VorFamilyCandidate = Readonly<{
  routePoint: VorFamilyRoutePoint;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

type NdbCandidate = Readonly<{
  routePoint: NdbRoutePoint;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

type NavaidCandidate = RouteSearchTypes['MeasuredCandidate'];

type Coordinates = Readonly<{longitude: number; latitude: number}>;

type BoundingBox = Readonly<{
  minimumLongitude: number;
  maximumLongitude: number;
  minimumLatitude: number;
  maximumLatitude: number;
}>;

const EARTH_RADIUS_NM = 6_371_000 / 1_852;
const PREFILTER_PADDING_DEGREES = 1e-12;

class PlannerRepository {
  readonly #instance: DuckDBInstance;

  constructor(instance: DuckDBInstance) {
    this.#instance = instance;
  }

  createRouteSearchDataSource(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint
  ): RouteSearchDataSource {
    return {
      directDistanceNm: () => this.directDistanceNm(connection, departure, arrival),
      findNewCandidates: (family, nextLimitNm, measuredDatabaseIds) =>
        this.findNewCandidates(
          connection,
          departure,
          arrival,
          family,
          nextLimitNm,
          measuredDatabaseIds
        ),
      findNewPairs: (newlyAdmittedCandidates, admittedDatabaseIds) =>
        this.findNewNavaidPairs(connection, newlyAdmittedCandidates, admittedDatabaseIds),
    };
  }

  async withReadTransaction<Value>(
    operation: (connection: DuckDBConnection) => Promise<Value>
  ): Promise<Value> {
    const connection = await this.#instance.connect();
    try {
      await connection.run('BEGIN TRANSACTION');
      try {
        const value = await operation(connection);
        await connection.run('COMMIT');
        return value;
      } catch (error) {
        await connection.run('ROLLBACK');
        throw error;
      }
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
        icao,
        name,
        longitude,
        latitude,
        magnetic_declination_deg_east
      FROM main.planner_airports
      WHERE icao IN (?, ?)`,
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

  async findNewCandidates(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint,
    family: CandidateFamily,
    nextLimitNm: number,
    previouslyMeasuredDatabaseIds: readonly string[]
  ): Promise<readonly NavaidCandidate[]> {
    return family === 'vor-family'
      ? this.findNewVorFamilyCandidates(
          connection,
          departure,
          arrival,
          nextLimitNm,
          previouslyMeasuredDatabaseIds
        )
      : this.findNewNdbCandidates(
          connection,
          departure,
          arrival,
          nextLimitNm,
          previouslyMeasuredDatabaseIds
        );
  }

  async findNewVorFamilyCandidates(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint,
    nextLimitNm: number,
    previouslyMeasuredDatabaseIds: readonly string[]
  ): Promise<readonly VorFamilyCandidate[]> {
    const candidateQuery = vorFamilyCandidateQuery(
      departure,
      arrival,
      nextLimitNm,
      previouslyMeasuredDatabaseIds
    );
    const reader = await connection.runAndReadAll(
      `${candidateQuery.sql}
      SELECT * EXCLUDE endpoint_distance_sum_nm
      FROM candidate_distances`,
      candidateQuery.parameters
    );

    return reader.getRowObjectsJS().map(row => ({
      routePoint: toVorFamilyRoutePoint(row),
      departureDistanceNm: Number(row['departure_distance_nm']),
      arrivalDistanceNm: Number(row['arrival_distance_nm']),
    }));
  }

  async findNewNdbCandidates(
    connection: DuckDBConnection,
    departure: AirportRoutePoint,
    arrival: AirportRoutePoint,
    nextLimitNm: number,
    previouslyMeasuredDatabaseIds: readonly string[]
  ): Promise<readonly NdbCandidate[]> {
    const candidateQuery = ndbCandidateQuery(
      departure,
      arrival,
      nextLimitNm,
      previouslyMeasuredDatabaseIds
    );
    const reader = await connection.runAndReadAll(
      `${candidateQuery.sql}
      SELECT * EXCLUDE endpoint_distance_sum_nm
      FROM candidate_distances`,
      candidateQuery.parameters
    );

    return reader.getRowObjectsJS().map(row => ({
      routePoint: toNdbRoutePoint(row),
      departureDistanceNm: Number(row['departure_distance_nm']),
      arrivalDistanceNm: Number(row['arrival_distance_nm']),
    }));
  }

  async findNewNavaidPairs(
    connection: DuckDBConnection,
    newlyAdmittedCandidates: readonly NavaidCandidate[],
    previouslyAdmittedDatabaseIds: readonly string[]
  ): Promise<readonly NavaidPairDistance[]> {
    if (newlyAdmittedCandidates.length === 0) {
      return [];
    }
    const admittedIds = [
      ...newlyAdmittedCandidates.map(candidate => ({
        databaseId: candidate.routePoint.databaseId,
        isNew: true,
      })),
      ...previouslyAdmittedDatabaseIds.map(databaseId => ({databaseId, isNew: false})),
    ];
    const reader = await connection.runAndReadAll(
      `WITH admitted_ids(database_id, is_new) AS (
        VALUES ${admittedIds.map(() => '(?, ?)').join(', ')}
      ),
      candidate_coordinates AS (
        SELECT admitted_ids.*, planner_navaids.latitude, planner_navaids.longitude
        FROM admitted_ids
        JOIN main.planner_navaids AS planner_navaids USING (database_id)
      )
      SELECT
        newly_admitted.database_id AS first_database_id,
        admitted.database_id AS second_database_id,
        ST_Distance_Sphere(
          ST_Point(newly_admitted.latitude, newly_admitted.longitude),
          ST_Point(admitted.latitude, admitted.longitude)
        ) / 1852.0 AS distance_nm
      FROM candidate_coordinates AS newly_admitted
      JOIN candidate_coordinates AS admitted
        ON newly_admitted.is_new
          AND newly_admitted.database_id <> admitted.database_id
          AND (
            NOT admitted.is_new
            OR newly_admitted.database_id < admitted.database_id
          )`,
      admittedIds.flatMap(({databaseId, isNew}) => [databaseId, isNew])
    );

    return reader.getRowObjectsJS().map(row => ({
      firstDatabaseId: requiredString(row['first_database_id']),
      secondDatabaseId: requiredString(row['second_database_id']),
      distanceNm: Number(row['distance_nm']),
    }));
  }
}

function vorFamilyCandidateQuery(
  departure: AirportRoutePoint,
  arrival: AirportRoutePoint,
  nextLimitNm: number,
  excludedDatabaseIds: readonly string[]
): {sql: string; parameters: (string | number)[]} {
  return navaidCandidateQuery(
    departure,
    arrival,
    nextLimitNm,
    excludedDatabaseIds,
    vorFamilyCandidateFilter()
  );
}

function ndbCandidateQuery(
  departure: AirportRoutePoint,
  arrival: AirportRoutePoint,
  nextLimitNm: number,
  excludedDatabaseIds: readonly string[]
): {sql: string; parameters: (string | number)[]} {
  return navaidCandidateQuery(
    departure,
    arrival,
    nextLimitNm,
    excludedDatabaseIds,
    ndbCandidateFilter()
  );
}

function navaidCandidateQuery(
  departure: AirportRoutePoint,
  arrival: AirportRoutePoint,
  nextLimitNm: number,
  excludedDatabaseIds: readonly string[],
  candidateFilter: string
): {sql: string; parameters: (string | number)[]} {
  const departureBounds = conservativeBounds(departure, nextLimitNm);
  const arrivalBounds = conservativeBounds(arrival, nextLimitNm);
  return {
    sql: `WITH spatial_candidates AS (
      SELECT *
      FROM main.planner_navaids
      WHERE ${candidateFilter}
        AND ${spatialBoundsFilter(departureBounds)}
        AND ${spatialBoundsFilter(arrivalBounds)}
        ${excludedDatabaseIds.length === 0 ? '' : `AND database_id NOT IN (${excludedDatabaseIds.map(() => '?').join(', ')})`}
    ),
    endpoint_distances AS (
      SELECT
        database_id,
        identifier,
        name,
        family,
        longitude,
        latitude,
        frequency_value,
        frequency_unit,
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
      FROM spatial_candidates
    ),
    candidate_distances AS (
      SELECT *, departure_distance_nm + arrival_distance_nm AS endpoint_distance_sum_nm
      FROM endpoint_distances
    )`,
    parameters: [
      ...excludedDatabaseIds,
      departure.latitude,
      departure.longitude,
      arrival.latitude,
      arrival.longitude,
    ],
  };
}

function spatialBoundsFilter(bounds: readonly BoundingBox[]): string {
  return `(${bounds
    .map(
      bound =>
        `ST_Intersects(point, ST_MakeEnvelope(${bound.minimumLongitude}, ${bound.minimumLatitude}, ${bound.maximumLongitude}, ${bound.maximumLatitude}))`
    )
    .join(' OR ')})`;
}

function conservativeBounds(
  endpoint: Coordinates,
  maximumDistanceNm: number
): readonly BoundingBox[] {
  const angularRadius = Math.min(Math.PI, maximumDistanceNm / EARTH_RADIUS_NM);
  const latitudeRadians = degreesToRadians(endpoint.latitude);
  const minimumLatitude = Math.max(
    -90,
    endpoint.latitude - radiansToDegrees(angularRadius) - PREFILTER_PADDING_DEGREES
  );
  const maximumLatitude = Math.min(
    90,
    endpoint.latitude + radiansToDegrees(angularRadius) + PREFILTER_PADDING_DEGREES
  );

  if (
    latitudeRadians + angularRadius >= Math.PI / 2 ||
    latitudeRadians - angularRadius <= -Math.PI / 2
  ) {
    return [
      {minimumLongitude: -180, maximumLongitude: 180, minimumLatitude, maximumLatitude},
    ];
  }

  const longitudeRadius =
    radiansToDegrees(Math.asin(Math.sin(angularRadius) / Math.cos(latitudeRadians))) +
    PREFILTER_PADDING_DEGREES;
  const minimumLongitude = endpoint.longitude - longitudeRadius;
  const maximumLongitude = endpoint.longitude + longitudeRadius;
  if (minimumLongitude < -180) {
    return [
      {
        minimumLongitude: minimumLongitude + 360,
        maximumLongitude: 180,
        minimumLatitude,
        maximumLatitude,
      },
      {
        minimumLongitude: -180,
        maximumLongitude,
        minimumLatitude,
        maximumLatitude,
      },
    ];
  }
  if (maximumLongitude > 180) {
    return [
      {
        minimumLongitude,
        maximumLongitude: 180,
        minimumLatitude,
        maximumLatitude,
      },
      {
        minimumLongitude: -180,
        maximumLongitude: maximumLongitude - 360,
        minimumLatitude,
        maximumLatitude,
      },
    ];
  }

  return [{minimumLongitude, maximumLongitude, minimumLatitude, maximumLatitude}];
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function vorFamilyCandidateFilter(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `${prefix}family IN ('VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC')`;
}

function ndbCandidateFilter(): string {
  return `family = 'NDB'`;
}

function toAirportRoutePoint(row: Readonly<Record<string, unknown>>): AirportRoutePoint {
  return {kind: 'airport', ...plannerDatabaseContract.decodeAirport(row)};
}

function toVorFamilyRoutePoint(
  row: Readonly<Record<string, unknown>>
): VorFamilyRoutePoint {
  const navaid = plannerDatabaseContract.decodeNavaid(row);
  if (navaid.kind !== 'vor-family') {
    throw new Error(`Expected a VOR-family row; received ${navaid.kind}.`);
  }
  return navaid;
}

function toNdbRoutePoint(row: Readonly<Record<string, unknown>>): NdbRoutePoint {
  const navaid = plannerDatabaseContract.decodeNavaid(row);
  if (navaid.kind !== 'ndb') {
    throw new Error(`Expected an NDB row; received ${navaid.kind}.`);
  }
  return navaid;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a database string value.');
  }
  return value;
}

export default PlannerRepository;
