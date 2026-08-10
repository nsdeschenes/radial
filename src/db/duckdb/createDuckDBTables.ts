function createDuckDBTables() {
  return `
    CREATE TABLE IF NOT EXISTS navaids (
      _id STRING PRIMARY KEY, name STRING, type UTINYINT, identifier STRING,
      country UNION(code STRING, codes STRING[]),
      geometry STRUCT(type STRING, coordinates DOUBLE[2]),
      elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      elevationGeoid STRUCT(hae DOUBLE, geoidHeight DOUBLE),
      magneticDeclination DOUBLE, alignedTrueNorth BOOLEAN, channel STRING,
      frequency STRUCT(value STRING, unit UTINYINT),
      range STRUCT(value UBIGINT, unit UTINYINT),
      hoursOfOperation STRUCT(operatingHours STRUCT(dayOfWeek UTINYINT, startTime STRING, endTime STRING, sunrise BOOLEAN, sunset BOOLEAN, byNotam BOOLEAN, publicHolidaysExcluded BOOLEAN, remarks STRING)[], remarks STRING),
      images STRUCT(_id STRING, filename STRING, description STRING)[],
      remarks STRING, createdBy STRING, updatedBy STRING, createdAt TIMESTAMPTZ,
      updatedAt TIMESTAMPTZ, raw JSON
    );

    CREATE TABLE IF NOT EXISTS airports (
      _id STRING PRIMARY KEY, name STRING, icaoCode STRING, iataCode STRING,
      altIdentifier STRING, type UTINYINT, country UNION(code STRING, codes STRING[]),
      geometry STRUCT(type STRING, coordinates DOUBLE[2]),
      elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      elevationGeoid STRUCT(hae DOUBLE, geoidHeight DOUBLE), trafficType UTINYINT[],
      magneticDeclination DOUBLE, ppr BOOLEAN, private BOOLEAN, skydiveActivity BOOLEAN,
      winchOnly BOOLEAN,
      services STRUCT(fuelTypes UTINYINT[], chargingStations UTINYINT[], gliderTowing UTINYINT[], handlingFacilities UTINYINT[], passengerFacilities UTINYINT[]),
      frequencies STRUCT(_id STRING, value STRING, unit UTINYINT, type UTINYINT, name STRING, "primary" BOOLEAN, publicUse BOOLEAN, remarks STRING)[],
      runways STRUCT(
        _id STRING, designator STRING, trueHeading USMALLINT, alignedTrueNorth BOOLEAN,
        operations UTINYINT, mainRunway BOOLEAN, turnDirection UTINYINT, landingOnly BOOLEAN,
        takeOffOnly BOOLEAN,
        surface STRUCT(composition UTINYINT[], mainComposite UTINYINT, condition UTINYINT, mtow STRUCT(value DOUBLE, unit UTINYINT), pcn STRING, remarks STRING),
        dimension STRUCT(length STRUCT(value INTEGER, unit UTINYINT), width STRUCT(value INTEGER, unit UTINYINT)),
        declaredDistance STRUCT(tora STRUCT(value INTEGER, unit UTINYINT), toda STRUCT(value INTEGER, unit UTINYINT), asda STRUCT(value INTEGER, unit UTINYINT), lda STRUCT(value INTEGER, unit UTINYINT)),
        thresholdLocation STRUCT(geometry STRUCT(type STRING, coordinates DOUBLE[2]), elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT)),
        exclusiveAircraftType UTINYINT[], pilotCtrlLighting BOOLEAN, lightingSystem UTINYINT[], visualApproachAids UTINYINT[],
        instrumentApproachAids STRUCT(_id STRING, identifier STRING, frequency STRUCT(value STRING, unit UTINYINT), channel STRING, alignedTrueNorth BOOLEAN, type UTINYINT, hoursOfOperation STRUCT(operatingHours STRUCT(dayOfWeek UTINYINT, startTime STRING, endTime STRING, sunrise BOOLEAN, sunset BOOLEAN, byNotam BOOLEAN, publicHolidaysExcluded BOOLEAN, remarks STRING)[], remarks STRING), remarks STRING)[],
        remarks STRING
      )[],
      hoursOfOperation STRUCT(operatingHours STRUCT(dayOfWeek UTINYINT, startTime STRING, endTime STRING, sunrise BOOLEAN, sunset BOOLEAN, byNotam BOOLEAN, publicHolidaysExcluded BOOLEAN, remarks STRING)[], remarks STRING),
      contact STRING, remarks STRING, telephoneServices STRUCT(name STRING, phoneNumber STRING, remarks STRING)[],
      images STRUCT(_id STRING, filename STRING, description STRING)[], createdBy STRING,
      updatedBy STRING, createdAt TIMESTAMPTZ, updatedAt TIMESTAMPTZ, raw JSON
    );

    CREATE TABLE IF NOT EXISTS airspaces (
      _id STRING PRIMARY KEY, name STRING, dataIngestion BOOLEAN, type UTINYINT,
      icaoClass UTINYINT, activity UTINYINT, onDemand BOOLEAN, onRequest BOOLEAN,
      byNotam BOOLEAN, specialAgreement BOOLEAN, requestCompliance BOOLEAN,
      geometry STRUCT(type STRING, coordinates DOUBLE[2][][]),
      country UNION(code STRING, codes STRING[]),
      upperLimit STRUCT(value INTEGER, unit UTINYINT, referenceDatum UTINYINT),
      lowerLimit STRUCT(value INTEGER, unit UTINYINT, referenceDatum UTINYINT),
      upperLimitMax STRUCT(value INTEGER, unit UTINYINT, referenceDatum UTINYINT),
      lowerLimitMin STRUCT(value INTEGER, unit UTINYINT, referenceDatum UTINYINT),
      frequencies STRUCT(_id STRING, value STRING, unit UTINYINT, name STRING, "primary" BOOLEAN, remarks STRING)[],
      transponderSettings STRUCT(code STRING, "primary" BOOLEAN, remarks STRING)[],
      hoursOfOperation STRUCT(operatingHours STRUCT(dayOfWeek UTINYINT, startTime STRING, endTime STRING, sunrise BOOLEAN, sunset BOOLEAN, byNotam BOOLEAN, publicHolidaysExcluded BOOLEAN, remarks STRING)[], remarks STRING),
      activeFrom TIMESTAMPTZ, activeUntil TIMESTAMPTZ, remarks STRING, createdBy STRING,
      updatedBy STRING, createdAt TIMESTAMPTZ, updatedAt TIMESTAMPTZ, raw JSON
    );

    CREATE TABLE IF NOT EXISTS hotspots (
      _id STRING PRIMARY KEY, name STRING, type UTINYINT, reliability UTINYINT,
      occurrence UTINYINT, category UTINYINT[], country UNION(code STRING, codes STRING[]),
      geometry STRUCT(type STRING, coordinates DOUBLE[2]),
      elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      elevationGeoid STRUCT(hae DOUBLE, geoidHeight DOUBLE), timeOfDay UTINYINT[],
      favTimeOfDay UTINYINT[], favWindDirection UTINYINT[], reqWindDirection UTINYINT[],
      remarks STRING, createdBy STRING, updatedBy STRING, createdAt TIMESTAMPTZ,
      updatedAt TIMESTAMPTZ, raw JSON
    );

    CREATE TABLE IF NOT EXISTS obstacles (
      _id STRING PRIMARY KEY, osmId STRING, osmTags JSON, name STRING, type UTINYINT,
      country UNION(code STRING, codes STRING[]),
      geometry STRUCT(type STRING, coordinates DOUBLE[2]),
      elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      elevationGeoid STRUCT(hae DOUBLE, geoidHeight DOUBLE),
      height STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      createdBy STRING, updatedBy STRING, createdAt TIMESTAMPTZ, updatedAt TIMESTAMPTZ,
      osmImportJobId STRING, osmUpdatedAt TIMESTAMPTZ, raw JSON
    );

    CREATE TABLE IF NOT EXISTS reporting_points (
      _id STRING PRIMARY KEY, name STRING, compulsory BOOLEAN,
      country UNION(code STRING, codes STRING[]),
      geometry STRUCT(type STRING, coordinates DOUBLE[2]),
      elevation STRUCT(value DOUBLE, unit UTINYINT, referenceDatum UTINYINT),
      elevationGeoid STRUCT(hae DOUBLE, geoidHeight DOUBLE), airports STRING[],
      remarks STRING, createdBy STRING, updatedBy STRING, createdAt TIMESTAMPTZ,
      updatedAt TIMESTAMPTZ, raw JSON
    );`;
}

export default createDuckDBTables;
