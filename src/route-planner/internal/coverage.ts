function isAirportToNavaidNavigable(
  distanceNm: number,
  publishedRangeNm: number
): boolean {
  return distanceNm <= publishedRangeNm;
}

function isNavaidToNavaidNavigable(
  distanceNm: number,
  firstPublishedRangeNm: number,
  secondPublishedRangeNm: number
): boolean {
  return distanceNm <= firstPublishedRangeNm + secondPublishedRangeNm;
}

export default {isAirportToNavaidNavigable, isNavaidToNavaidNavigable};
