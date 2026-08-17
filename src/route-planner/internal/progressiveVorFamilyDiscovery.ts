type Coordinates = Readonly<{longitude: number; latitude: number}>;

type MeasuredCandidate = Readonly<{
  routePoint: Readonly<{databaseId: string}>;
  departureDistanceNm: number;
  arrivalDistanceNm: number;
}>;

type BoundingBox = Readonly<{
  minimumLongitude: number;
  maximumLongitude: number;
  minimumLatitude: number;
  maximumLatitude: number;
}>;

const EARTH_RADIUS_NM = 6_371_000 / 1_852;
const MAXIMUM_VOR_FAMILY_FACTOR = 1.5;
const SCHEDULED_FACTORS = [1.1, 1.25, MAXIMUM_VOR_FAMILY_FACTOR] as const;
const PREFILTER_PADDING_DEGREES = 1e-12;

class ProgressiveDiscoverySession<Candidate extends MeasuredCandidate> {
  readonly #measuredDatabaseIdSet = new Set<string>();
  readonly #measuredDatabaseIds: string[] = [];
  readonly #scheduledLimitsNm: readonly number[];
  #completedLimitNm: number | undefined;
  #pendingCandidates: Candidate[] = [];

  constructor(directDistanceNm: number, configuredMaximumFactor: number) {
    this.#scheduledLimitsNm = scheduledLimitsNm(
      directDistanceNm,
      configuredMaximumFactor
    );
  }

  get measuredDatabaseIds(): readonly string[] {
    return this.#measuredDatabaseIds;
  }

  nextLimitNm(provisionalRouteDistanceNm: number | undefined): number | undefined {
    return nextLimitNm(
      this.#scheduledLimitsNm,
      this.#completedLimitNm,
      provisionalRouteDistanceNm
    );
  }

  admitMeasuredCandidates(
    measuredCandidates: readonly Candidate[],
    nextLimitNm: number
  ): readonly Candidate[] {
    const batchDatabaseIds = new Set<string>();
    for (const candidate of measuredCandidates) {
      const databaseId = candidate.routePoint.databaseId;
      if (
        batchDatabaseIds.has(databaseId) ||
        this.#measuredDatabaseIdSet.has(databaseId)
      ) {
        throw new Error(
          `VOR-family candidate endpoint distances were measured more than once: ${databaseId}`
        );
      }
      batchDatabaseIds.add(databaseId);
    }

    this.#measuredDatabaseIds.push(
      ...measuredCandidates.map(candidate => candidate.routePoint.databaseId)
    );
    for (const databaseId of batchDatabaseIds) {
      this.#measuredDatabaseIdSet.add(databaseId);
    }
    this.#pendingCandidates.push(...measuredCandidates);
    const newlyAdmittedCandidates = this.#pendingCandidates.filter(candidate =>
      isNewlyAdmitted(
        candidate.departureDistanceNm + candidate.arrivalDistanceNm,
        this.#completedLimitNm,
        nextLimitNm
      )
    );
    this.#pendingCandidates = this.#pendingCandidates.filter(
      candidate =>
        candidate.departureDistanceNm + candidate.arrivalDistanceNm > nextLimitNm
    );
    this.#completedLimitNm = nextLimitNm;
    return newlyAdmittedCandidates;
  }
}

function createSession<Candidate extends MeasuredCandidate>(
  directDistanceNm: number,
  configuredMaximumFactor: number
): ProgressiveDiscoverySession<Candidate> {
  return new ProgressiveDiscoverySession(directDistanceNm, configuredMaximumFactor);
}

function scheduledLimitsNm(
  directDistanceNm: number,
  configuredMaximumFactor: number
): readonly number[] {
  return scheduledFactors(configuredMaximumFactor).map(
    factor => directDistanceNm * factor
  );
}

function scheduledFactors(configuredMaximumFactor: number): readonly number[] {
  const maximumFactor = Math.min(configuredMaximumFactor, MAXIMUM_VOR_FAMILY_FACTOR);
  return [...new Set(SCHEDULED_FACTORS.map(factor => Math.min(factor, maximumFactor)))];
}

function nextLimitNm(
  scheduledLimits: readonly number[],
  completedLimitNm: number | undefined,
  provisionalRouteDistanceNm: number | undefined
): number | undefined {
  if (
    completedLimitNm !== undefined &&
    provisionalRouteDistanceNm !== undefined &&
    provisionalRouteDistanceNm <= completedLimitNm
  ) {
    return undefined;
  }

  const scheduledLimit = scheduledLimits.find(
    limit => completedLimitNm === undefined || limit > completedLimitNm
  );
  if (scheduledLimit === undefined) {
    return undefined;
  }
  return provisionalRouteDistanceNm === undefined
    ? scheduledLimit
    : Math.min(scheduledLimit, provisionalRouteDistanceNm);
}

function isNewlyAdmitted(
  endpointDistanceSumNm: number,
  completedLimitNm: number | undefined,
  nextLimitNm: number
): boolean {
  return (
    (completedLimitNm === undefined || endpointDistanceSumNm > completedLimitNm) &&
    endpointDistanceSumNm <= nextLimitNm
  );
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

export default {
  conservativeBounds,
  createSession,
  isNewlyAdmitted,
  nextLimitNm,
  scheduledFactors,
  scheduledLimitsNm,
};
