import type RoutePlannerTypes from '#radial/route-planner/RoutePlannerTypes.js';

type RoutePlan = RoutePlannerTypes['RoutePlan'];
type RoutePoint = RoutePlannerTypes['RoutePoint'];
type RouteLeg = RoutePlannerTypes['RouteLeg'];

type TableColumn<Row> = Readonly<{
  header: string;
  align: 'left' | 'right';
  render(row: Row): string;
}>;

const UNAVAILABLE = '—';
const OUTPUT_WIDTH = 100;
const ROUTE_POINTS_PREFIX = 'Route Points: ';

function formatRoutePlan(plan: RoutePlan): string {
  const routeLegRows = plan.routeLegs.map((routeLeg, index) => ({
    legNumber: index + 1,
    routeLeg,
  }));
  const navaids = uniqueNavaids(plan.routePoints);

  return (
    formatRoutePointSequence(plan.routePoints) +
    `Total Distance: ${formatDistance(plan.totalDistanceNm)}\n` +
    `Route Legs: ${plan.routeLegs.length}\n` +
    `Route Search Mode: ${formatSearchMode(plan.searchMode)}\n` +
    '\n' +
    'Route Legs\n' +
    formatTable(routeLegRows, routeLegColumns) +
    '\n' +
    'Navaids\n' +
    formatTable(navaids, navaidColumns)
  );
}

const routeLegColumns: readonly TableColumn<{
  legNumber: number;
  routeLeg: RouteLeg;
}>[] = [
  {header: 'Leg', align: 'right', render: row => String(row.legNumber)},
  {
    header: 'From',
    align: 'left',
    render: row => formatRoutePointIdentifier(row.routeLeg.departure),
  },
  {
    header: 'To',
    align: 'left',
    render: row => formatRoutePointIdentifier(row.routeLeg.arrival),
  },
  {
    header: 'Distance',
    align: 'right',
    render: row => formatDistance(row.routeLeg.distanceNm),
  },
  {
    header: 'Outbound True',
    align: 'right',
    render: row => formatCourse(row.routeLeg.departureTrueCourseDeg),
  },
  {
    header: 'Arrival True',
    align: 'right',
    render: row => formatCourse(row.routeLeg.arrivalTrueCourseDeg),
  },
  {
    header: 'Outbound Magnetic',
    align: 'right',
    render: row => formatCourse(row.routeLeg.departureMagneticCourseDeg),
  },
  {
    header: 'Arrival Magnetic',
    align: 'right',
    render: row => formatCourse(row.routeLeg.arrivalMagneticCourseDeg),
  },
  {
    header: 'Departure VOR Guidance',
    align: 'left',
    render: row => formatVorGuidance(row.routeLeg.departureVorGuidance, 'Outbound'),
  },
  {
    header: 'Arrival VOR Guidance',
    align: 'left',
    render: row => formatVorGuidance(row.routeLeg.arrivalVorGuidance, 'Inbound'),
  },
];

const navaidColumns: readonly TableColumn<
  RoutePlannerTypes['VorFamilyRoutePoint'] | RoutePlannerTypes['NdbRoutePoint']
>[] = [
  {header: 'Identifier', align: 'left', render: navaid => navaid.identifier},
  {
    header: 'Type',
    align: 'left',
    render: navaid => (navaid.kind === 'ndb' ? 'NDB' : navaid.family),
  },
  {
    header: 'Frequency',
    align: 'right',
    render: navaid =>
      navaid.frequency.unit === 'MHz'
        ? `${navaid.frequency.value.toFixed(2)} MHz`
        : `${navaid.frequency.value.toFixed(0)} kHz`,
  },
  {
    header: 'Published Range',
    align: 'right',
    render: navaid => formatDistance(navaid.publishedRangeNm),
  },
];

function formatRoutePointSequence(routePoints: readonly RoutePoint[]): string {
  const indentation = ' '.repeat(ROUTE_POINTS_PREFIX.length);
  const lines: string[] = [];
  let line = ROUTE_POINTS_PREFIX;

  for (const routePoint of routePoints) {
    const identifier = formatRoutePointIdentifier(routePoint);
    const separator = line === ROUTE_POINTS_PREFIX ? '' : ' → ';
    if (
      line.length > ROUTE_POINTS_PREFIX.length &&
      line.length + separator.length + identifier.length > OUTPUT_WIDTH
    ) {
      lines.push(line);
      line = indentation + identifier;
    } else {
      line += separator + identifier;
    }
  }

  lines.push(line);
  return `${lines.join('\n')}\n`;
}

function formatRoutePointIdentifier(routePoint: RoutePoint): string {
  return routePoint.kind === 'airport' ? routePoint.icao : routePoint.identifier;
}

function uniqueNavaids(
  routePoints: readonly RoutePoint[]
): readonly (
  | RoutePlannerTypes['VorFamilyRoutePoint']
  | RoutePlannerTypes['NdbRoutePoint']
)[] {
  const databaseIds = new Set<string>();
  const navaids: (
    | RoutePlannerTypes['VorFamilyRoutePoint']
    | RoutePlannerTypes['NdbRoutePoint']
  )[] = [];

  for (const routePoint of routePoints) {
    if (routePoint.kind !== 'airport' && !databaseIds.has(routePoint.databaseId)) {
      databaseIds.add(routePoint.databaseId);
      navaids.push(routePoint);
    }
  }

  return navaids;
}

function formatTable<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[]
): string {
  const renderedRows = rows.map(row => columns.map(column => column.render(row)));
  const widths = columns.map((column, columnIndex) =>
    Math.max(
      column.header.length,
      ...renderedRows.map(row => row[columnIndex]?.length ?? 0)
    )
  );
  const header = columns.map(column => column.header);

  return (
    [header, ...renderedRows]
      .map(row =>
        row
          .map((cell, columnIndex) => {
            const column = columns[columnIndex];
            const width = widths[columnIndex];
            if (column === undefined || width === undefined) {
              throw new Error('Table column invariant failed.');
            }
            return column.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
          })
          .join('  ')
          .trimEnd()
      )
      .join('\n') + '\n'
  );
}

function formatDistance(distanceNm: number): string {
  return `${distanceNm.toFixed(1)} NM`;
}

function formatCourse(courseDeg: number | null): string {
  if (courseDeg === null) {
    return UNAVAILABLE;
  }

  return `${String(Math.round(courseDeg) % 360).padStart(3, '0')}°`;
}

function formatVorGuidance(
  guidance: RouteLeg['departureVorGuidance'],
  label: 'Outbound' | 'Inbound'
): string {
  return guidance?.magneticCourseDeg === null || guidance === null
    ? UNAVAILABLE
    : `${label} ${formatCourse(guidance.magneticCourseDeg)}`;
}

function formatSearchMode(searchMode: RoutePlan['searchMode']): string {
  return searchMode === 'vor-family' ? 'VOR-family only' : 'NDB fallback';
}

export default formatRoutePlan;
