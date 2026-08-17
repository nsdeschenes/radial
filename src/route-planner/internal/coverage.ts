function isAirportToNavaidNavigable(
  distanceNm: number,
  publishedRangeNm: number
): boolean {
  return distanceNm <= publishedRangeNm;
}

export default {isAirportToNavaidNavigable};
