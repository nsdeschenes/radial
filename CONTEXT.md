# Radial

Radial plans old-school, ground-based radio-navigation routes for flight simulation.

## Language

**Route Plan**:
A geometric path from a departure airport to an arrival airport through one or more ordered ground-based Navaids. A direct airport-to-airport path is not a Route Plan.
_Avoid_: Flight plan, airway route

**Route Point**:
An airport or navaid that forms one endpoint of a route leg.
_Avoid_: Fix, node, waypoint

**Route Leg**:
The segment of a route plan between two consecutive route points.
_Avoid_: Hop, edge

**Navigable Route Leg**:
A route leg whose endpoints fall within continuous published navaid coverage, allowing navigation from one received signal to the next.
_Avoid_: Connected leg, valid edge

**Course**:
The intended direction of travel over the ground, expressed relative to true or magnetic north without wind correction.
_Avoid_: Heading

**VOR Guidance**:
An operational course or radial referenced to a VOR-family Navaid's Facility Variation of Record. At a Route Leg endpoint it is either an inbound course to the facility or an outbound radial from it.
_Avoid_: Bearing, travel course

**Route Search Mode**:
The navaid-admission policy under which a Route Plan was found: VOR-family only, or NDB fallback after VOR-family discovery was exhausted. An NDB-fallback Route Plan may retain VOR-family Navaids discovered before fallback began.
_Avoid_: Route type, algorithm

**Route Search**:
The progressive discovery and evaluation of Navaids that can form a Route Plan within the configured distance limit. It admits VOR-family Navaids first and admits Fallback Navaids only after exhaustive VOR-family discovery finds no Route Plan.
_Avoid_: Route planning, pathfinding

**Progressive Discovery**:
The staged widening of the endpoint-distance region from which Route Search admits Navaids, including completion of any region that could improve a provisional Route Plan.
_Avoid_: Pagination, radius search

**Local Magnetic Declination**:
The angle between true and magnetic north at a Route Point on the database snapshot's magnetic reference date, expressed in degrees east-positive.
_Avoid_: Facility variation

**Facility Variation of Record**:
The published magnetic reference used by a VOR-family Navaid for operational radials and courses; it is not interchangeable with Local Magnetic Declination.
_Avoid_: Local declination, current declination

**VOR-family Navaid**:
A navaid that supplies VOR guidance, including combined VOR/DME and VORTAC facilities.
_Avoid_: VOR when referring to the whole family

**Fallback Navaid**:
An NDB admitted only after exhaustive VOR-family discovery fails to find a Route Plan.
_Avoid_: Secondary waypoint

**Navaid Snapshot**:
The complete set of OpenAIP Navaid records imported together and committed atomically. It is created when a database has no successful Navaid Snapshot and replaced only by an explicit reload.
_Avoid_: Navigation-point cache, startup refresh

**Cached Airport**:
An airport record fetched from OpenAIP for a requested departure or arrival ICAO and retained for later Route Plans. An explicit reload replaces it only after the replacement has been fetched and validated successfully.
_Avoid_: Airport Snapshot
