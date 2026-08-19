import {createHash} from 'node:crypto';

const WMM2025_EPOCH = 2025;
const WMM2025_END = 2030;
const WMM2025_MAX_DEGREE = 12;
const WMM2025_BLACKOUT_HORIZONTAL_INTENSITY_NT = 2_000;
const WGS84_SEMI_MAJOR_AXIS_KM = 6_378.137;
const WGS84_SEMI_MINOR_AXIS_KM = 6_356.752_314_2;
const WMM_REFERENCE_RADIUS_KM = 6_371.2;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WHITESPACE_PATTERN = /\s+/;
const WMM2025_COEFFICIENT_CHECKSUM =
  'sha256:dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f';

const WMM2025_COEFFICIENTS = `    2025.0            WMM-2025     11/13/2024
  1  0  -29351.8       0.0       12.0        0.0
  1  1   -1410.8    4545.4        9.7      -21.5
  2  0   -2556.6       0.0      -11.6        0.0
  2  1    2951.1   -3133.6       -5.2      -27.7
  2  2    1649.3    -815.1       -8.0      -12.1
  3  0    1361.0       0.0       -1.3        0.0
  3  1   -2404.1     -56.6       -4.2        4.0
  3  2    1243.8     237.5        0.4       -0.3
  3  3     453.6    -549.5      -15.6       -4.1
  4  0     895.0       0.0       -1.6        0.0
  4  1     799.5     278.6       -2.4       -1.1
  4  2      55.7    -133.9       -6.0        4.1
  4  3    -281.1     212.0        5.6        1.6
  4  4      12.1    -375.6       -7.0       -4.4
  5  0    -233.2       0.0        0.6        0.0
  5  1     368.9      45.4        1.4       -0.5
  5  2     187.2     220.2        0.0        2.2
  5  3    -138.7    -122.9        0.6        0.4
  5  4    -142.0      43.0        2.2        1.7
  5  5      20.9     106.1        0.9        1.9
  6  0      64.4       0.0       -0.2        0.0
  6  1      63.8     -18.4       -0.4        0.3
  6  2      76.9      16.8        0.9       -1.6
  6  3    -115.7      48.8        1.2       -0.4
  6  4     -40.9     -59.8       -0.9        0.9
  6  5      14.9      10.9        0.3        0.7
  6  6     -60.7      72.7        0.9        0.9
  7  0      79.5       0.0       -0.0        0.0
  7  1     -77.0     -48.9       -0.1        0.6
  7  2      -8.8     -14.4       -0.1        0.5
  7  3      59.3      -1.0        0.5       -0.8
  7  4      15.8      23.4       -0.1        0.0
  7  5       2.5      -7.4       -0.8       -1.0
  7  6     -11.1     -25.1       -0.8        0.6
  7  7      14.2      -2.3        0.8       -0.2
  8  0      23.2       0.0       -0.1        0.0
  8  1      10.8       7.1        0.2       -0.2
  8  2     -17.5     -12.6        0.0        0.5
  8  3       2.0      11.4        0.5       -0.4
  8  4     -21.7      -9.7       -0.1        0.4
  8  5      16.9      12.7        0.3       -0.5
  8  6      15.0       0.7        0.2       -0.6
  8  7     -16.8      -5.2       -0.0        0.3
  8  8       0.9       3.9        0.2        0.2
  9  0       4.6       0.0       -0.0        0.0
  9  1       7.8     -24.8       -0.1       -0.3
  9  2       3.0      12.2        0.1        0.3
  9  3      -0.2       8.3        0.3       -0.3
  9  4      -2.5      -3.3       -0.3        0.3
  9  5     -13.1      -5.2        0.0        0.2
  9  6       2.4       7.2        0.3       -0.1
  9  7       8.6      -0.6       -0.1       -0.2
  9  8      -8.7       0.8        0.1        0.4
  9  9     -12.9      10.0       -0.1        0.1
 10  0      -1.3       0.0        0.1        0.0
 10  1      -6.4       3.3        0.0        0.0
 10  2       0.2       0.0        0.1       -0.0
 10  3       2.0       2.4        0.1       -0.2
 10  4      -1.0       5.3       -0.0        0.1
 10  5      -0.6      -9.1       -0.3       -0.1
 10  6      -0.9       0.4        0.0        0.1
 10  7       1.5      -4.2       -0.1        0.0
 10  8       0.9      -3.8       -0.1       -0.1
 10  9      -2.7       0.9       -0.0        0.2
 10 10      -3.9      -9.1       -0.0       -0.0
 11  0       2.9       0.0        0.0        0.0
 11  1      -1.5       0.0       -0.0       -0.0
 11  2      -2.5       2.9        0.0        0.1
 11  3       2.4      -0.6        0.0       -0.0
 11  4      -0.6       0.2        0.0        0.1
 11  5      -0.1       0.5       -0.1       -0.0
 11  6      -0.6      -0.3        0.0       -0.0
 11  7      -0.1      -1.2       -0.0        0.1
 11  8       1.1      -1.7       -0.1       -0.0
 11  9      -1.0      -2.9       -0.1        0.0
 11 10      -0.2      -1.8       -0.1        0.0
 11 11       2.6      -2.3       -0.1        0.0
 12  0      -2.0       0.0        0.0        0.0
 12  1      -0.2      -1.3        0.0       -0.0
 12  2       0.3       0.7       -0.0        0.0
 12  3       1.2       1.0       -0.0       -0.1
 12  4      -1.3      -1.4       -0.0        0.1
 12  5       0.6      -0.0       -0.0       -0.0
 12  6       0.6       0.6        0.1       -0.0
 12  7       0.5      -0.1       -0.0       -0.0
 12  8      -0.1       0.8        0.0        0.0
 12  9      -0.4       0.1        0.0       -0.0
 12 10      -0.2      -1.0       -0.1       -0.0
 12 11      -1.3       0.1       -0.0        0.0
 12 12      -0.7       0.2       -0.1       -0.1
999999999999999999999999999999999999999999999999
999999999999999999999999999999999999999999999999`;

const WMM2025_PROVENANCE = Object.freeze({
  model: 'WMM',
  version: 'WMM2025',
  epochYear: WMM2025_EPOCH,
  source: 'https://doi.org/10.25921/aqfd-sd83',
  coefficientChecksum: WMM2025_COEFFICIENT_CHECKSUM,
});

type Coefficient = Readonly<{
  degree: number;
  order: number;
  mainG: number;
  mainH: number;
  secularG: number;
  secularH: number;
}>;

type DeclinationRequest = Readonly<{
  referenceDate: string;
  latitude: number;
  longitude: number;
}>;

const COEFFICIENTS = parseCoefficients();

function localMagneticDeclinationFromWmm2025(request: DeclinationRequest): number | null {
  validateCoordinates(request.latitude, request.longitude);
  const decimalYear = noaaDecimalYearFromUtcDate(request.referenceDate);
  const field = calculateField(decimalYear, request.latitude, request.longitude);
  if (field.horizontalIntensityNt < WMM2025_BLACKOUT_HORIZONTAL_INTENSITY_NT) {
    return null;
  }

  return normalizeDegrees(field.declinationDegEast);
}

function noaaDecimalYearFromUtcDate(referenceDate: string): number {
  const match = ISO_DATE_PATTERN.exec(referenceDate);
  if (match === null) {
    throw new Error('WMM2025 reference date must be an ISO UTC date.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const canonicalDate = new Date(timestamp).toISOString().slice(0, 10);
  if (canonicalDate !== referenceDate) {
    throw new Error('WMM2025 reference date must be an ISO UTC date.');
  }

  const yearStart = Date.UTC(year, 0, 1);
  const nextYearStart = Date.UTC(year + 1, 0, 1);
  const decimalYear = year + (timestamp - yearStart) / (nextYearStart - yearStart);
  if (decimalYear < WMM2025_EPOCH || decimalYear >= WMM2025_END) {
    throw new Error('WMM2025 reference date must be in [2025.0, 2030.0).');
  }

  return decimalYear;
}

function wmm2025Provenance(referenceDate: string) {
  noaaDecimalYearFromUtcDate(referenceDate);
  return Object.freeze({...WMM2025_PROVENANCE, referenceDate});
}

function calculateField(decimalYear: number, latitude: number, longitude: number) {
  const latitudeRadians = latitude / DEGREES_PER_RADIAN;
  const longitudeRadians = longitude / DEGREES_PER_RADIAN;
  const sinLatitude = Math.sin(latitudeRadians);
  const cosLatitude = Math.cos(latitudeRadians);
  const eccentricitySquared =
    1 -
    (WGS84_SEMI_MINOR_AXIS_KM * WGS84_SEMI_MINOR_AXIS_KM) /
      (WGS84_SEMI_MAJOR_AXIS_KM * WGS84_SEMI_MAJOR_AXIS_KM);
  const radiusOfCurvature =
    WGS84_SEMI_MAJOR_AXIS_KM /
    Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
  const cartesianX = radiusOfCurvature * cosLatitude;
  const cartesianZ = radiusOfCurvature * (1 - eccentricitySquared) * sinLatitude;
  const sphericalRadius = Math.hypot(cartesianX, cartesianZ);
  const geocentricLatitude = Math.asin(cartesianZ / sphericalRadius);
  const sinGeocentricLatitude = Math.sin(geocentricLatitude);
  const cosGeocentricLatitude = Math.cos(geocentricLatitude);
  const {polynomials, derivatives} = associatedLegendreFunctions(sinGeocentricLatitude);
  const radiusPowers = Array.from<number>({length: WMM2025_MAX_DEGREE + 1}).fill(0);
  const cosineOrders = Array.from<number>({length: WMM2025_MAX_DEGREE + 1}).fill(0);
  const sineOrders = Array.from<number>({length: WMM2025_MAX_DEGREE + 1}).fill(0);
  const radiusRatio = WMM_REFERENCE_RADIUS_KM / sphericalRadius;
  radiusPowers[0] = radiusRatio * radiusRatio;
  cosineOrders[0] = 1;
  cosineOrders[1] = Math.cos(longitudeRadians);
  sineOrders[1] = Math.sin(longitudeRadians);
  for (let degree = 1; degree <= WMM2025_MAX_DEGREE; degree += 1) {
    radiusPowers[degree] = valueAt(radiusPowers, degree - 1) * radiusRatio;
  }

  for (let order = 2; order <= WMM2025_MAX_DEGREE; order += 1) {
    cosineOrders[order] =
      valueAt(cosineOrders, order - 1) * valueAt(cosineOrders, 1) -
      valueAt(sineOrders, order - 1) * valueAt(sineOrders, 1);
    sineOrders[order] =
      valueAt(cosineOrders, order - 1) * valueAt(sineOrders, 1) +
      valueAt(sineOrders, order - 1) * valueAt(cosineOrders, 1);
  }

  let sphericalNorth = 0;
  let sphericalEast = 0;
  let sphericalDown = 0;
  const yearOffset = decimalYear - WMM2025_EPOCH;
  for (const coefficient of COEFFICIENTS) {
    const index = coefficientIndex(coefficient.degree, coefficient.order);
    const timedG = coefficient.mainG + yearOffset * coefficient.secularG;
    const timedH = coefficient.mainH + yearOffset * coefficient.secularH;
    const longitudeTerm =
      timedG * valueAt(cosineOrders, coefficient.order) +
      timedH * valueAt(sineOrders, coefficient.order);
    const radiusPower = valueAt(radiusPowers, coefficient.degree);
    sphericalDown -=
      radiusPower *
      (coefficient.degree + 1) *
      longitudeTerm *
      valueAt(polynomials, index);
    sphericalNorth -= radiusPower * longitudeTerm * valueAt(derivatives, index);
    sphericalEast +=
      radiusPower *
      coefficient.order *
      (timedG * valueAt(sineOrders, coefficient.order) -
        timedH * valueAt(cosineOrders, coefficient.order)) *
      valueAt(polynomials, index);
  }

  sphericalEast =
    Math.abs(cosGeocentricLatitude) > 1e-10
      ? sphericalEast / cosGeocentricLatitude
      : calculatePolarEast(
          radiusPowers,
          sineOrders,
          cosineOrders,
          yearOffset,
          sinGeocentricLatitude
        );

  const rotation = geocentricLatitude - latitudeRadians;
  const north = sphericalNorth * Math.cos(rotation) - sphericalDown * Math.sin(rotation);
  const east = sphericalEast;
  const down = sphericalNorth * Math.sin(rotation) + sphericalDown * Math.cos(rotation);
  const horizontalIntensityNt = Math.hypot(north, east);
  const declinationDegEast = Math.atan2(east, north) * DEGREES_PER_RADIAN;
  if (
    ![north, east, down, horizontalIntensityNt, declinationDegEast].every(Number.isFinite)
  ) {
    throw new Error('WMM2025 calculation produced invalid arithmetic.');
  }

  return {horizontalIntensityNt, declinationDegEast};
}

function associatedLegendreFunctions(sinLatitude: number) {
  const termCount = ((WMM2025_MAX_DEGREE + 1) * (WMM2025_MAX_DEGREE + 2)) / 2;
  const polynomials = Array.from<number>({length: termCount}).fill(0);
  const derivatives = Array.from<number>({length: termCount}).fill(0);
  const schmidtNormalization = Array.from<number>({length: termCount}).fill(0);
  const cosLatitude = Math.sqrt((1 - sinLatitude) * (1 + sinLatitude));
  polynomials[0] = 1;
  schmidtNormalization[0] = 1;

  for (let degree = 1; degree <= WMM2025_MAX_DEGREE; degree += 1) {
    for (let order = 0; order <= degree; order += 1) {
      const index = coefficientIndex(degree, order);
      if (degree === order) {
        const previous = coefficientIndex(degree - 1, order - 1);
        polynomials[index] = cosLatitude * valueAt(polynomials, previous);
        derivatives[index] =
          cosLatitude * valueAt(derivatives, previous) +
          sinLatitude * valueAt(polynomials, previous);
      } else if (degree === 1) {
        polynomials[index] = sinLatitude;
        derivatives[index] = -cosLatitude;
      } else {
        const previous = coefficientIndex(degree - 1, order);
        const twoDegreesBack = coefficientIndex(degree - 2, order);
        if (order > degree - 2) {
          polynomials[index] = sinLatitude * valueAt(polynomials, previous);
          derivatives[index] =
            sinLatitude * valueAt(derivatives, previous) -
            cosLatitude * valueAt(polynomials, previous);
        } else {
          const recursion =
            ((degree - 1) * (degree - 1) - order * order) /
            ((2 * degree - 1) * (2 * degree - 3));
          polynomials[index] =
            sinLatitude * valueAt(polynomials, previous) -
            recursion * valueAt(polynomials, twoDegreesBack);
          derivatives[index] =
            sinLatitude * valueAt(derivatives, previous) -
            cosLatitude * valueAt(polynomials, previous) -
            recursion * valueAt(derivatives, twoDegreesBack);
        }
      }
    }

    const zonalIndex = coefficientIndex(degree, 0);
    schmidtNormalization[zonalIndex] =
      valueAt(schmidtNormalization, coefficientIndex(degree - 1, 0)) *
      ((2 * degree - 1) / degree);
    for (let order = 1; order <= degree; order += 1) {
      const index = coefficientIndex(degree, order);
      schmidtNormalization[index] =
        valueAt(schmidtNormalization, index - 1) *
        Math.sqrt(((degree - order + 1) * (order === 1 ? 2 : 1)) / (degree + order));
    }
  }

  for (let degree = 1; degree <= WMM2025_MAX_DEGREE; degree += 1) {
    for (let order = 0; order <= degree; order += 1) {
      const index = coefficientIndex(degree, order);
      polynomials[index] =
        valueAt(polynomials, index) * valueAt(schmidtNormalization, index);
      derivatives[index] =
        -valueAt(derivatives, index) * valueAt(schmidtNormalization, index);
    }
  }

  return {polynomials, derivatives};
}

function calculatePolarEast(
  radiusPowers: readonly number[],
  sineOrders: readonly number[],
  cosineOrders: readonly number[],
  yearOffset: number,
  sinLatitude: number
): number {
  let east = 0;
  let polynomialTwoDegreesBack = 1;
  let polynomialPrevious = 1;
  let zonalNormalization = 1;
  for (let degree = 1; degree <= WMM2025_MAX_DEGREE; degree += 1) {
    const coefficient = COEFFICIENTS.find(
      candidate => candidate.degree === degree && candidate.order === 1
    );
    if (coefficient === undefined) {
      throw new Error('WMM2025 coefficient set is incomplete.');
    }

    const nextZonalNormalization = zonalNormalization * ((2 * degree - 1) / degree);
    const sectoralNormalization =
      nextZonalNormalization * Math.sqrt((degree * 2) / (degree + 1));
    let polynomial: number;
    if (degree === 1) {
      polynomial = polynomialPrevious;
    } else {
      const recursion =
        ((degree - 1) * (degree - 1) - 1) / ((2 * degree - 1) * (2 * degree - 3));
      polynomial =
        sinLatitude * polynomialPrevious - recursion * polynomialTwoDegreesBack;
      polynomialTwoDegreesBack = polynomialPrevious;
      polynomialPrevious = polynomial;
    }

    const timedG = coefficient.mainG + yearOffset * coefficient.secularG;
    const timedH = coefficient.mainH + yearOffset * coefficient.secularH;
    east +=
      valueAt(radiusPowers, degree) *
      (timedG * valueAt(sineOrders, 1) - timedH * valueAt(cosineOrders, 1)) *
      polynomial *
      sectoralNormalization;
    zonalNormalization = nextZonalNormalization;
  }

  return east;
}

function parseCoefficients(): readonly Coefficient[] {
  const embeddedChecksum = `sha256:${createHash('sha256')
    .update(`${WMM2025_COEFFICIENTS}\n`, 'utf8')
    .digest('hex')}`;
  if (embeddedChecksum !== WMM2025_COEFFICIENT_CHECKSUM) {
    throw new Error('WMM2025 coefficients do not match the pinned checksum.');
  }

  const coefficients: Coefficient[] = [];
  for (const line of WMM2025_COEFFICIENTS.split('\n').slice(1)) {
    if (line.startsWith('9999')) {
      break;
    }

    const values = line.trim().split(WHITESPACE_PATTERN).map(Number);
    if (values.length !== 6 || values.some(value => !Number.isFinite(value))) {
      throw new Error('WMM2025 coefficient set is invalid.');
    }

    coefficients.push({
      degree: requiredValue(values, 0),
      order: requiredValue(values, 1),
      mainG: requiredValue(values, 2),
      mainH: requiredValue(values, 3),
      secularG: requiredValue(values, 4),
      secularH: requiredValue(values, 5),
    });
  }

  if (coefficients.length !== 90) {
    throw new Error('WMM2025 coefficient set is incomplete.');
  }

  return Object.freeze(coefficients);
}

function validateCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('WMM2025 coordinates must be finite WGS84 degrees.');
  }

  if (latitude < -90 || latitude > 90) {
    throw new Error('WMM2025 latitude must be in [-90, 90].');
  }

  if (longitude < -180 || longitude >= 180) {
    throw new Error('WMM2025 longitude must be in [-180, 180).');
  }
}

function coefficientIndex(degree: number, order: number): number {
  return (degree * (degree + 1)) / 2 + order;
}

function normalizeDegrees(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function valueAt(values: readonly number[], index: number): number {
  return requiredValue(values, index);
}

function requiredValue(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error('WMM2025 calculation accessed incomplete model data.');
  }

  return value;
}

const Wmm2025 = Object.freeze({
  localMagneticDeclinationFromWmm2025,
  noaaDecimalYearFromUtcDate,
  wmm2025Provenance,
});

export default Wmm2025;
