import type {DuckDBConnection} from '@duckdb/node-api';

type DatabaseRow = Readonly<Record<string, unknown>>;

type CanonicalViewSource = Readonly<{
  createFrom: string;
  normalizedFrom: string;
}>;

type CanonicalViewSources = Readonly<{
  plannerAirports: CanonicalViewSource;
  plannerMetadata: CanonicalViewSource;
  plannerNavaids: CanonicalViewSource;
}>;

type PlannerAirport = Readonly<{
  databaseId: string;
  icao: string;
  latitude: number;
  longitude: number;
  magneticDeclinationDegEast: number | null;
  name: string;
}>;

type VorFamily = 'VOR' | 'VOR-DME' | 'VORTAC' | 'DVOR' | 'DVOR-DME' | 'DVORTAC';

type PlannerNavaidBase = Readonly<{
  databaseId: string;
  identifier: string;
  latitude: number;
  longitude: number;
  magneticDeclinationDegEast: number | null;
  name: string;
  publishedRangeNm: number;
}>;

type PlannerNavaid =
  | (PlannerNavaidBase &
      Readonly<{
        frequency: Readonly<{unit: 'kHz'; value: number}>;
        kind: 'ndb';
      }>)
  | (PlannerNavaidBase &
      Readonly<{
        facilityVariation: Readonly<{
          degreesEast: number;
          effectiveDate: string | null;
          source: string;
        }> | null;
        family: VorFamily;
        frequency: Readonly<{unit: 'MHz'; value: number}>;
        kind: 'vor-family';
      }>);

type PlannerMetadata = Readonly<{
  epochYear: number;
  model: string;
  referenceDate: string;
  source: string;
  version: string;
}>;

type ContractValidation =
  | Readonly<{metadata: PlannerMetadata | null; ok: true}>
  | Readonly<{ok: false; violations: readonly string[]}>;

type CanonicalViews = Readonly<{
  createSql: string;
  normalizedDefinitions: readonly string[];
}>;

type RelationDefinition = Readonly<{
  canonicalColumns: Readonly<Record<string, string>>;
  createSelect: readonly string[];
  name: keyof typeof RELATION_NAMES;
  normalizedSelect: readonly string[];
  requiredColumns: Readonly<Record<string, string>>;
}>;

const RELATION_NAMES = {
  plannerAirports: 'planner_airports',
  plannerMetadata: 'planner_metadata',
  plannerNavaids: 'planner_navaids',
} as const;

const VOR_FAMILIES = ['VOR', 'VOR-DME', 'VORTAC', 'DVOR', 'DVOR-DME', 'DVORTAC'] as const;
const SUPPORTED_FAMILIES = ['NDB', ...VOR_FAMILIES] as const;
const ICAO_PATTERN = /^[A-Z]{4}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const RELATIONS: readonly RelationDefinition[] = [
  {
    name: 'plannerAirports',
    canonicalColumns: {
      snapshot_id: 'UUID',
      database_id: 'VARCHAR',
      icao: 'VARCHAR',
      name: 'VARCHAR',
      longitude: 'DOUBLE',
      latitude: 'DOUBLE',
      point: 'GEOMETRY',
      magnetic_declination_deg_east: 'DOUBLE',
    },
    requiredColumns: {
      database_id: 'VARCHAR',
      icao: 'VARCHAR',
      name: 'VARCHAR',
      longitude: 'DOUBLE',
      latitude: 'DOUBLE',
      point: 'GEOMETRY',
      magnetic_declination_deg_east: 'DOUBLE',
    },
    createSelect: [
      'airports.snapshot_id',
      'airports.database_id',
      'airports.icao',
      'airports.name',
      'airports.longitude',
      'airports.latitude',
      'ST_Point(airports.longitude, airports.latitude) AS point',
      'airports.magnetic_declination_deg_east',
    ],
    normalizedSelect: [
      'airports.snapshot_id',
      'airports.database_id',
      'airports.icao',
      'airports."name"',
      'airports.longitude',
      'airports.latitude',
      'st_point(airports.longitude, airports.latitude) AS point',
      'airports.magnetic_declination_deg_east',
    ],
  },
  {
    name: 'plannerNavaids',
    canonicalColumns: {
      snapshot_id: 'UUID',
      source_record_id: 'VARCHAR',
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
    requiredColumns: {
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
    createSelect: [
      'navaids.snapshot_id',
      'navaids.source_record_id',
      'navaids.database_id',
      'navaids.identifier',
      'navaids.name',
      'navaids.family',
      'navaids.longitude',
      'navaids.latitude',
      'ST_Point(navaids.longitude, navaids.latitude) AS point',
      'navaids.frequency_value',
      'navaids.frequency_unit',
      'navaids.published_range_nm',
      'navaids.magnetic_declination_deg_east',
      'navaids.facility_variation_deg_east',
      'navaids.facility_variation_source',
      'navaids.facility_variation_effective_date',
    ],
    normalizedSelect: [
      'navaids.snapshot_id',
      'navaids.source_record_id',
      'navaids.database_id',
      'navaids.identifier',
      'navaids."name"',
      'navaids."family"',
      'navaids.longitude',
      'navaids.latitude',
      'st_point(navaids.longitude, navaids.latitude) AS point',
      'navaids.frequency_value',
      'navaids.frequency_unit',
      'navaids.published_range_nm',
      'navaids.magnetic_declination_deg_east',
      'navaids.facility_variation_deg_east',
      'navaids.facility_variation_source',
      'navaids.facility_variation_effective_date',
    ],
  },
  {
    name: 'plannerMetadata',
    canonicalColumns: {
      snapshot_id: 'UUID',
      snapshot_checksum: 'VARCHAR',
      magnetic_model: 'VARCHAR',
      magnetic_model_version: 'VARCHAR',
      magnetic_model_epoch_year: 'DOUBLE',
      magnetic_reference_date: 'DATE',
      magnetic_model_source: 'VARCHAR',
    },
    requiredColumns: {
      magnetic_model: 'VARCHAR',
      magnetic_model_version: 'VARCHAR',
      magnetic_model_epoch_year: 'DOUBLE',
      magnetic_reference_date: 'DATE',
      magnetic_model_source: 'VARCHAR',
    },
    createSelect: [
      'snapshots.snapshot_id',
      'snapshots.snapshot_checksum',
      'snapshots.magnetic_model',
      'snapshots.magnetic_model_version',
      'snapshots.magnetic_model_epoch_year',
      'snapshots.magnetic_reference_date',
      'snapshots.magnetic_model_source',
    ],
    normalizedSelect: [
      'snapshots.snapshot_id',
      'snapshots.snapshot_checksum',
      'snapshots.magnetic_model',
      'snapshots.magnetic_model_version',
      'snapshots.magnetic_model_epoch_year',
      'snapshots.magnetic_reference_date',
      'snapshots.magnetic_model_source',
    ],
  },
] as const;

class PlannerDatabaseContractError extends Error {
  readonly category: 'invalid-field' | 'invalid-row';
  readonly field: string;

  constructor(category: 'invalid-field' | 'invalid-row', field: string) {
    super(`Planner Database Contract ${category}: ${field}`);
    this.category = category;
    this.field = field;
  }
}

function createCanonicalViews(sources: CanonicalViewSources): CanonicalViews {
  const createSql = RELATIONS.map(relation => {
    const source = sources[relation.name];
    return `CREATE VIEW main.${RELATION_NAMES[relation.name]} AS
SELECT
  ${relation.createSelect.join(',\n  ')}
FROM ${source.createFrom};`;
  }).join('\n\n');

  const normalizedDefinitions = RELATIONS.toSorted((left, right) =>
    RELATION_NAMES[left.name].localeCompare(RELATION_NAMES[right.name])
  ).map(relation => {
    const relationName = RELATION_NAMES[relation.name];
    return `${relationName}:CREATE VIEW ${relationName} AS SELECT ${relation.normalizedSelect.join(', ')} FROM ${sources[relation.name].normalizedFrom};`;
  });

  return {createSql, normalizedDefinitions};
}

async function hasAnyReservedRelation(connection: DuckDBConnection): Promise<boolean> {
  const relations = await connection.runAndReadAll(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'main'
      AND table_name IN (${Object.values(RELATION_NAMES)
        .map(name => `'${name}'`)
        .join(', ')})
  `);
  return relations.getRowObjectsJS().length > 0;
}

async function validate(connection: DuckDBConnection): Promise<ContractValidation> {
  const violations: string[] = [];

  for (const relation of RELATIONS) {
    const relationName = RELATION_NAMES[relation.name];
    let actualColumns: ReadonlyMap<string, string>;
    try {
      const described = await connection.runAndReadAll(`DESCRIBE main.${relationName}`);
      actualColumns = new Map(
        described
          .getRowObjectsJS()
          .map(row => [
            requiredDatabaseString(row['column_name']),
            requiredDatabaseString(row['column_type']),
          ])
      );
    } catch {
      violations.push(`${relationName} is missing`);
      continue;
    }

    for (const [column, requiredType] of Object.entries(relation.requiredColumns)) {
      const actualType = actualColumns.get(column);
      if (actualType === undefined) {
        violations.push(`${relationName} is missing required column ${column}`);
      } else if (actualType !== requiredType) {
        violations.push(
          `${relationName}.${column} must have type ${requiredType}; received ${actualType}`
        );
      }
    }
  }

  if (violations.length > 0) {
    return {ok: false, violations};
  }

  const airportFlags = await readFlags(
    connection,
    `SELECT
      EXISTS(
        SELECT 1 FROM main.planner_airports
        WHERE database_id IS NULL OR trim(database_id) = ''
          OR icao IS NULL OR NOT regexp_full_match(icao, '[A-Z]{4}')
          OR name IS NULL OR trim(name) = ''
      ) AS invalid_identity,
      EXISTS(
        SELECT 1 FROM main.planner_airports
        GROUP BY icao HAVING count(*) > 1
        UNION ALL
        SELECT 1 FROM main.planner_airports
        GROUP BY database_id HAVING count(*) > 1
      ) AS duplicate_identity,
      EXISTS(
        SELECT 1 FROM main.planner_airports
        WHERE longitude IS NULL OR latitude IS NULL
          OR NOT isfinite(longitude) OR NOT isfinite(latitude)
          OR longitude < -180 OR longitude > 180
          OR latitude < -90 OR latitude > 90
          OR point IS NULL OR ST_GeometryType(point) <> 'POINT'
          OR ST_X(point) <> longitude OR ST_Y(point) <> latitude
      ) AS invalid_geometry,
      EXISTS(
        SELECT 1 FROM main.planner_airports
        WHERE magnetic_declination_deg_east IS NOT NULL
          AND (NOT isfinite(magnetic_declination_deg_east)
            OR magnetic_declination_deg_east < -180
            OR magnetic_declination_deg_east >= 180)
      ) AS invalid_magnetic_angle,
      EXISTS(
        SELECT 1 FROM main.planner_airports
        WHERE magnetic_declination_deg_east IS NOT NULL
      ) AS has_local_declination`
  );
  if (airportFlags['invalid_identity'] === true) {
    violations.push('planner_airports contains invalid planner-ready identity data');
  }

  if (airportFlags['duplicate_identity'] === true) {
    violations.push('planner_airports contains duplicate planner-ready identity data');
  }

  if (airportFlags['invalid_geometry'] === true) {
    violations.push(
      'planner_airports contains invalid longitude/latitude point geometry'
    );
  }

  const navaidFlags = await readFlags(
    connection,
    `SELECT
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE database_id IS NULL OR trim(database_id) = ''
          OR identifier IS NULL OR trim(identifier) = ''
          OR name IS NULL OR trim(name) = ''
      ) AS invalid_identity,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        GROUP BY database_id HAVING count(*) > 1
      ) AS duplicate_identity,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE longitude IS NULL OR latitude IS NULL
          OR NOT isfinite(longitude) OR NOT isfinite(latitude)
          OR longitude < -180 OR longitude > 180
          OR latitude < -90 OR latitude > 90
          OR point IS NULL OR ST_GeometryType(point) <> 'POINT'
          OR ST_X(point) <> longitude OR ST_Y(point) <> latitude
      ) AS invalid_geometry,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE family IS NULL OR family NOT IN (${SUPPORTED_FAMILIES.map(family => `'${family}'`).join(', ')})
          OR frequency_value IS NULL OR NOT isfinite(frequency_value)
          OR frequency_value <= 0
          OR frequency_unit IS NULL
          OR published_range_nm IS NULL OR NOT isfinite(published_range_nm)
          OR published_range_nm <= 0
          OR (family = 'NDB' AND (frequency_unit <> 'kHz' OR frequency_value <> trunc(frequency_value)))
          OR (family IN (${VOR_FAMILIES.map(family => `'${family}'`).join(', ')}) AND frequency_unit <> 'MHz')
      ) AS invalid_navigation_data,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE magnetic_declination_deg_east IS NOT NULL
          AND (NOT isfinite(magnetic_declination_deg_east)
            OR magnetic_declination_deg_east < -180
            OR magnetic_declination_deg_east >= 180)
      ) AS invalid_magnetic_angle,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE (facility_variation_deg_east IS NULL AND
            (facility_variation_source IS NOT NULL OR facility_variation_effective_date IS NOT NULL))
          OR (facility_variation_deg_east IS NOT NULL AND
            (NOT isfinite(facility_variation_deg_east)
              OR facility_variation_deg_east < -180
              OR facility_variation_deg_east >= 180
              OR facility_variation_source IS NULL
              OR trim(facility_variation_source) = ''))
          OR (family NOT IN (${VOR_FAMILIES.map(family => `'${family}'`).join(', ')}) AND
            (facility_variation_deg_east IS NOT NULL
              OR facility_variation_source IS NOT NULL
              OR facility_variation_effective_date IS NOT NULL))
      ) AS invalid_facility_variation,
      EXISTS(
        SELECT 1 FROM main.planner_navaids
        WHERE magnetic_declination_deg_east IS NOT NULL
      ) AS has_local_declination`
  );
  if (navaidFlags['invalid_identity'] === true) {
    violations.push('planner_navaids contains invalid planner-ready identity data');
  }

  if (navaidFlags['duplicate_identity'] === true) {
    violations.push('planner_navaids contains duplicate planner-ready identity data');
  }

  if (navaidFlags['invalid_geometry'] === true) {
    violations.push('planner_navaids contains invalid longitude/latitude point geometry');
  }

  if (navaidFlags['invalid_navigation_data'] === true) {
    violations.push('planner_navaids contains invalid planner-ready navigation data');
  }

  if (
    airportFlags['invalid_magnetic_angle'] === true ||
    navaidFlags['invalid_magnetic_angle'] === true
  ) {
    violations.push('planner data contains an invalid Local Magnetic Declination');
  }

  if (navaidFlags['invalid_facility_variation'] === true) {
    violations.push('planner_navaids contains invalid Facility Variation of Record data');
  }

  const metadataReader = await connection.runAndReadAll(`
    SELECT magnetic_model, magnetic_model_version, magnetic_model_epoch_year,
      CAST(magnetic_reference_date AS VARCHAR) AS magnetic_reference_date,
      magnetic_model_source
    FROM main.planner_metadata
  `);
  const metadataRows = metadataReader.getRowObjectsJS();
  if (metadataRows.length !== 1) {
    violations.push('planner_metadata must contain exactly one row');
    return {ok: false, violations};
  }

  let metadata: PlannerMetadata | null = null;
  try {
    metadata = decodeMetadata(metadataRows[0]!);
  } catch {
    const values = Object.values(metadataRows[0]!);
    const presentCount = values.filter(value => value !== null).length;
    violations.push(
      presentCount !== 0 && presentCount !== values.length
        ? 'planner_metadata magnetic reference bundle must be all null or complete'
        : 'planner_metadata magnetic reference bundle is invalid'
    );
  }

  if (
    metadata === null &&
    (airportFlags['has_local_declination'] === true ||
      navaidFlags['has_local_declination'] === true)
  ) {
    violations.push('local magnetic declination requires complete planner_metadata');
  }

  if (metadata !== null) {
    const referenceYear = dateToDecimalYear(metadata.referenceDate);
    if (referenceYear < metadata.epochYear || referenceYear >= metadata.epochYear + 5) {
      violations.push(
        'planner_metadata reference date is outside the model validity period'
      );
    }
  }

  return violations.length === 0 ? {ok: true, metadata} : {ok: false, violations};
}

function decodeAirport(row: DatabaseRow): PlannerAirport {
  const icao = requiredString(row, 'icao');
  if (!ICAO_PATTERN.test(icao)) {
    throw invalidField('icao');
  }

  return {
    databaseId: requiredNonBlankString(row, 'database_id'),
    icao,
    name: requiredNonBlankString(row, 'name'),
    longitude: coordinate(row, 'longitude', -180, 180),
    latitude: coordinate(row, 'latitude', -90, 90),
    magneticDeclinationDegEast: nullableAngle(row, 'magnetic_declination_deg_east'),
  };
}

function decodeNavaid(row: DatabaseRow): PlannerNavaid {
  const family = requiredString(row, 'family');
  const frequencyValue = positiveFiniteNumber(row, 'frequency_value');
  const base = {
    databaseId: requiredNonBlankString(row, 'database_id'),
    identifier: requiredNonBlankString(row, 'identifier'),
    name: requiredNonBlankString(row, 'name'),
    longitude: coordinate(row, 'longitude', -180, 180),
    latitude: coordinate(row, 'latitude', -90, 90),
    publishedRangeNm: positiveFiniteNumber(row, 'published_range_nm'),
    magneticDeclinationDegEast: nullableAngle(row, 'magnetic_declination_deg_east'),
  } as const;

  if (family === 'NDB') {
    if (
      requiredString(row, 'frequency_unit') !== 'kHz' ||
      !Number.isInteger(frequencyValue)
    ) {
      throw invalidField('frequency_value');
    }

    if (
      row['facility_variation_deg_east'] !== null ||
      row['facility_variation_source'] !== null ||
      row['facility_variation_effective_date'] !== null
    ) {
      throw invalidField('facility_variation_deg_east');
    }

    return {kind: 'ndb', ...base, frequency: {unit: 'kHz', value: frequencyValue}};
  }

  if (!isVorFamily(family) || requiredString(row, 'frequency_unit') !== 'MHz') {
    throw invalidField('family');
  }

  const facilityVariationDegEast = nullableAngle(row, 'facility_variation_deg_east');
  const facilityVariationSource = nullableString(row, 'facility_variation_source');
  const facilityVariationEffectiveDate = nullableDateString(
    row,
    'facility_variation_effective_date'
  );
  if (
    (facilityVariationDegEast === null &&
      (facilityVariationSource !== null || facilityVariationEffectiveDate !== null)) ||
    (facilityVariationDegEast !== null &&
      (facilityVariationSource === null || facilityVariationSource.trim() === ''))
  ) {
    throw invalidField('facility_variation_deg_east');
  }

  return {
    kind: 'vor-family',
    ...base,
    family,
    frequency: {unit: 'MHz', value: frequencyValue},
    facilityVariation:
      facilityVariationDegEast === null
        ? null
        : {
            degreesEast: facilityVariationDegEast,
            source: facilityVariationSource!,
            effectiveDate: facilityVariationEffectiveDate,
          },
  };
}

function decodeMetadata(row: DatabaseRow): PlannerMetadata | null {
  const fields = [
    'magnetic_model',
    'magnetic_model_version',
    'magnetic_model_epoch_year',
    'magnetic_reference_date',
    'magnetic_model_source',
  ] as const;
  const values = fields.map(field => row[field]);
  if (values.every(value => value === null)) {
    return null;
  }

  if (values.some(value => value === null)) {
    throw new PlannerDatabaseContractError('invalid-row', 'planner_metadata');
  }

  return {
    model: requiredNonBlankString(row, 'magnetic_model'),
    version: requiredNonBlankString(row, 'magnetic_model_version'),
    epochYear: finiteNumber(row, 'magnetic_model_epoch_year'),
    referenceDate: requiredDateString(row, 'magnetic_reference_date'),
    source: requiredNonBlankString(row, 'magnetic_model_source'),
  };
}

async function readFlags(
  connection: DuckDBConnection,
  sql: string
): Promise<DatabaseRow> {
  const row = (await connection.runAndReadAll(sql)).getRowObjectsJS()[0];
  if (row === undefined) {
    throw new PlannerDatabaseContractError('invalid-row', 'validation flags');
  }

  return row;
}

function requiredDatabaseString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PlannerDatabaseContractError('invalid-field', 'catalog value');
  }

  return value;
}

function requiredString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw invalidField(field);
  }

  return value;
}

function requiredNonBlankString(row: DatabaseRow, field: string): string {
  const value = requiredString(row, field);
  if (value.trim() === '') {
    throw invalidField(field);
  }

  return value;
}

function nullableString(row: DatabaseRow, field: string): string | null {
  return row[field] === null ? null : requiredString(row, field);
}

function finiteNumber(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidField(field);
  }

  return value;
}

function positiveFiniteNumber(row: DatabaseRow, field: string): number {
  const value = finiteNumber(row, field);
  if (value <= 0) {
    throw invalidField(field);
  }

  return value;
}

function coordinate(
  row: DatabaseRow,
  field: string,
  minimum: number,
  maximum: number
): number {
  const value = finiteNumber(row, field);
  if (value < minimum || value > maximum) {
    throw invalidField(field);
  }

  return value;
}

function nullableAngle(row: DatabaseRow, field: string): number | null {
  if (row[field] === null) {
    return null;
  }

  const value = finiteNumber(row, field);
  if (value < -180 || value >= 180) {
    throw invalidField(field);
  }

  return value;
}

function requiredDateString(row: DatabaseRow, field: string): string {
  const value = requiredString(row, field);
  if (!isCanonicalDate(value)) {
    throw invalidField(field);
  }

  return value;
}

function nullableDateString(row: DatabaseRow, field: string): string | null {
  return row[field] === null ? null : requiredDateString(row, field);
}

function isCanonicalDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateToDecimalYear(date: string): number {
  const instant = new Date(`${date}T00:00:00Z`).getTime();
  const year = Number(date.slice(0, 4));
  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);
  return year + (instant - yearStart) / (nextYearStart - yearStart);
}

function isVorFamily(value: string): value is VorFamily {
  return (VOR_FAMILIES as readonly string[]).includes(value);
}

function invalidField(field: string): PlannerDatabaseContractError {
  return new PlannerDatabaseContractError('invalid-field', field);
}

export default {
  canonicalColumns: Object.fromEntries(
    RELATIONS.map(relation => [RELATION_NAMES[relation.name], relation.canonicalColumns])
  ),
  createCanonicalViews,
  decodeAirport,
  decodeMetadata,
  decodeNavaid,
  hasAnyReservedRelation,
  relationNames: RELATION_NAMES,
  requiredColumns: Object.fromEntries(
    RELATIONS.map(relation => [RELATION_NAMES[relation.name], relation.requiredColumns])
  ),
  validate,
  version: 1,
} as const;
