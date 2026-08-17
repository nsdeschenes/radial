type NavaidPairDistance = Readonly<{
  firstDatabaseId: string;
  secondDatabaseId: string;
  distanceNm: number;
}>;

export default interface RouteSearchTypes {
  NavaidPairDistance: NavaidPairDistance;
}
