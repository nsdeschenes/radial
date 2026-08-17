import type {DuckDBConnection} from '@duckdb/node-api';

import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type MagneticReferenceMetadata = NonNullable<
  RoutePlannerTypes['RoutePlan']['magneticReference']
>;

type ContractValidation =
  | {ok: true; magneticReference: MagneticReferenceMetadata | null}
  | {ok: false; violations: readonly string[]};

const REQUIRED_COLUMNS = {
  planner_airports: {
    database_id: 'VARCHAR',
    icao: 'VARCHAR',
    name: 'VARCHAR',
    longitude: 'DOUBLE',
    latitude: 'DOUBLE',
    point: 'GEOMETRY',
    magnetic_declination_deg_east: 'DOUBLE',
  },
  planner_navaids: {
    database_id: 'VARCHAR',
    identifier: 'VARCHAR',
    name: 'VARCHAR',
    family: 'VARCHAR',
    longitude: 'DOUBLE',
    latitude: 'DOUBLE',
    point: 'GEOMETRY',
    frequency_value: 'DOUBLE',
    frequency_unit: 'VARCHAR',
    published_range_nm: 'DOUBLE',
    magnetic_declination_deg_east: 'DOUBLE',
    facility_variation_deg_east: 'DOUBLE',
    facility_variation_source: 'VARCHAR',
    facility_variation_effective_date: 'DATE',
  },
  planner_metadata: {
    magnetic_model: 'VARCHAR',
    magnetic_model_version: 'VARCHAR',
    magnetic_model_epoch_year: 'DOUBLE',
    magnetic_reference_date: 'DATE',
    magnetic_model_source: 'VARCHAR',
  },
} as const;

async function validateContract(
  connection: DuckDBConnection
): Promise<ContractValidation> {
  const violations: string[] = [];

  for (const [relation, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    let actualColumns: ReadonlyMap<string, string>;
    try {
      const described = await connection.runAndReadAll(`DESCRIBE ${relation}`);
      actualColumns = new Map(
        described
          .getRowObjectsJS()
          .map(row => [
            requireString(row['column_name']),
            requireString(row['column_type']),
          ])
      );
    } catch {
      violations.push(`${relation} is missing`);
      continue;
    }

    for (const [column, requiredType] of Object.entries(requiredColumns)) {
      const actualType = actualColumns.get(column);
      if (actualType === undefined) {
        violations.push(`${relation} is missing required column ${column}`);
      } else if (actualType !== requiredType) {
        violations.push(
          `${relation}.${column} must have type ${requiredType}; received ${actualType}`
        );
      }
    }
  }

  if (violations.length > 0) {
    return {ok: false, violations};
  }

  await validateGeometry(connection, 'planner_airports', violations);
  await validateGeometry(connection, 'planner_navaids', violations);
  await validateMagneticAngles(connection, violations);

  const metadataReader = await connection.runAndReadAll(`
    SELECT
      magnetic_model,
      magnetic_model_version,
      magnetic_model_epoch_year,
      CAST(magnetic_reference_date AS VARCHAR) AS magnetic_reference_date,
      magnetic_model_source
    FROM planner_metadata
  `);
  const metadataRows = metadataReader.getRowObjectsJS();
  if (metadataRows.length !== 1) {
    violations.push('planner_metadata must contain exactly one row');
    return {ok: false, violations};
  }

  const metadata = metadataRows[0];
  if (metadata === undefined) {
    return {ok: false, violations: ['planner_metadata must contain exactly one row']};
  }

  const values = [
    metadata['magnetic_model'],
    metadata['magnetic_model_version'],
    metadata['magnetic_model_epoch_year'],
    metadata['magnetic_reference_date'],
    metadata['magnetic_model_source'],
  ];
  const presentCount = values.filter(value => value !== null).length;
  const hasLocalDeclination = await queryBoolean(
    connection,
    `SELECT EXISTS(
      SELECT 1 FROM planner_airports WHERE magnetic_declination_deg_east IS NOT NULL
      UNION ALL
      SELECT 1 FROM planner_navaids WHERE magnetic_declination_deg_east IS NOT NULL
    ) AS value`
  );

  if (presentCount !== 0 && presentCount !== values.length) {
    violations.push(
      'planner_metadata magnetic reference bundle must be all null or complete'
    );
  } else if (hasLocalDeclination && presentCount === 0) {
    violations.push('local magnetic declination requires complete planner_metadata');
  }

  if (presentCount === values.length) {
    const epochYear = metadata['magnetic_model_epoch_year'];
    const referenceDate = metadata['magnetic_reference_date'];
    if (
      typeof epochYear !== 'number' ||
      !Number.isFinite(epochYear) ||
      typeof referenceDate !== 'string' ||
      typeof metadata['magnetic_model'] !== 'string' ||
      metadata['magnetic_model'].trim() === '' ||
      typeof metadata['magnetic_model_version'] !== 'string' ||
      metadata['magnetic_model_version'].trim() === '' ||
      typeof metadata['magnetic_model_source'] !== 'string' ||
      metadata['magnetic_model_source'].trim() === ''
    ) {
      violations.push('planner_metadata magnetic reference bundle is invalid');
    } else {
      const referenceYear = dateToDecimalYear(referenceDate);
      if (referenceYear < epochYear || referenceYear >= epochYear + 5) {
        violations.push(
          'planner_metadata reference date is outside the model validity period'
        );
      }
    }
  }

  if (violations.length > 0) {
    return {ok: false, violations};
  }

  if (presentCount === 0) {
    return {ok: true, magneticReference: null};
  }

  return {
    ok: true,
    magneticReference: {
      model: requireString(metadata['magnetic_model']),
      version: requireString(metadata['magnetic_model_version']),
      epochYear: Number(metadata['magnetic_model_epoch_year']),
      referenceDate: requireString(metadata['magnetic_reference_date']),
      source: requireString(metadata['magnetic_model_source']),
    },
  };
}

async function validateGeometry(
  connection: DuckDBConnection,
  relation: 'planner_airports' | 'planner_navaids',
  violations: string[]
): Promise<void> {
  const hasInvalidGeometry = await queryBoolean(
    connection,
    `SELECT EXISTS(
      SELECT 1 FROM ${relation}
      WHERE longitude IS NULL
        OR latitude IS NULL
        OR NOT isfinite(longitude)
        OR NOT isfinite(latitude)
        OR longitude < -180 OR longitude > 180
        OR latitude < -90 OR latitude > 90
        OR point IS NULL
        OR ST_GeometryType(point) <> 'POINT'
        OR ST_X(point) <> longitude
        OR ST_Y(point) <> latitude
    ) AS value`
  );
  if (hasInvalidGeometry) {
    violations.push(`${relation} contains invalid longitude/latitude point geometry`);
  }
}

async function validateMagneticAngles(
  connection: DuckDBConnection,
  violations: string[]
): Promise<void> {
  const invalidLocalDeclination = await queryBoolean(
    connection,
    `SELECT EXISTS(
      SELECT 1 FROM planner_airports
      WHERE magnetic_declination_deg_east IS NOT NULL
        AND (NOT isfinite(magnetic_declination_deg_east)
          OR magnetic_declination_deg_east < -180
          OR magnetic_declination_deg_east >= 180)
      UNION ALL
      SELECT 1 FROM planner_navaids
      WHERE magnetic_declination_deg_east IS NOT NULL
        AND (NOT isfinite(magnetic_declination_deg_east)
          OR magnetic_declination_deg_east < -180
          OR magnetic_declination_deg_east >= 180)
    ) AS value`
  );
  if (invalidLocalDeclination) {
    violations.push('planner data contains an invalid Local Magnetic Declination');
  }

  const invalidFacilityVariation = await queryBoolean(
    connection,
    `SELECT EXISTS(
      SELECT 1 FROM planner_navaids
      WHERE
        (facility_variation_deg_east IS NULL AND
          (facility_variation_source IS NOT NULL OR
            facility_variation_effective_date IS NOT NULL))
        OR
        (facility_variation_deg_east IS NOT NULL AND
          (NOT isfinite(facility_variation_deg_east)
            OR facility_variation_deg_east < -180
            OR facility_variation_deg_east >= 180
            OR facility_variation_source IS NULL
            OR trim(facility_variation_source) = ''))
        OR
        (family NOT IN ('VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC')
          AND (facility_variation_deg_east IS NOT NULL
            OR facility_variation_source IS NOT NULL
            OR facility_variation_effective_date IS NOT NULL))
    ) AS value`
  );
  if (invalidFacilityVariation) {
    violations.push('planner_navaids contains invalid Facility Variation of Record data');
  }
}

async function queryBoolean(connection: DuckDBConnection, sql: string): Promise<boolean> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJS()[0]?.['value'] === true;
}

function dateToDecimalYear(date: string): number {
  const instant = new Date(`${date}T00:00:00Z`).getTime();
  const year = Number(date.slice(0, 4));
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);

  return year + (instant - yearStart) / (nextYearStart - yearStart);
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a database string value.');
  }
  return value;
}

export default validateContract;
