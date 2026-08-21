export default interface CliCommandMetadataTypes {
  Metadata:
    | Readonly<{
        id: 'plan-route';
        attributes: Readonly<{
          'radial.route.arrival_icao': string;
          'radial.route.departure_icao': string;
        }>;
      }>
    | Readonly<{id: 'data-status'}>
    | Readonly<{id: 'reload-navaids'}>
    | Readonly<{
        id: 'reload-airport';
        attributes: Readonly<{'radial.airport.icao': string}>;
      }>;
}
