# Course, radial, and magnetic-declination conventions

## Decision

The planner should keep three concepts separate:

1. **True travel course** is the forward azimuth of the shortest geodesic from one route point to the next.
2. **Magnetic travel course** is that true azimuth corrected with a current, local magnetic declination at the endpoint where the course is reported.
3. **VOR radial/course** is referenced to the VOR facility's magnetic variation of record (the orientation of station north), not automatically to current local magnetic north.

That separation matters operationally. FAA guidance says PBN paths are computed relative to true north, while the displayed magnetic course can differ according to the variation applied. It also warns that a VOR radial and an FMS-computed magnetic track can disagree when VOR station declination differs from current magnetic variation ([FAA AIM, “Impact of Magnetic Variation on PBN Systems”](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap1_section_1.html); [FAA PARC MagVar VOR recommendations, pp. 2–3](https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/avs/160422PARCMagVarVORRecs.pdf)).

## Exact angle conventions

- Store angles as floating-point degrees increasing clockwise from north.
- Normalize any displayed or compared course with:

  ```text
  normalize360(x) = ((x % 360) + 360) % 360
  reciprocal(x)   = normalize360(x + 180)
  ```

- Round only for display. For the requested whole-degree display, round first and then normalize again so a value that rounds to `360` is rendered as `000°`. Render all course/radial values as three digits (`000°` through `359°`). FAA chart specifications likewise use three-digit, whole-degree magnetic bearings and radials ([FAA Interagency Air Cartographic Committee Specification 5, §3.1.2](https://www.faa.gov/air_traffic/flight_info/aeronav/iac/media/IAC5/IAC-5-30JUN2021-Ch3.pdf)).
- Do not use `360°` as a separate value; it is the same direction as `000°` and the normalized representation is `000°`.

## True course along a leg

For a leg from point A `(lat1, lon1)` to point B `(lat2, lon2)`, all coordinates are decimal degrees on WGS84. The canonical operation is the **inverse geodesic**. It returns distance plus:

- `azi1`: forward azimuth at A — the leg's **initial/outbound true course**;
- `azi2`: forward azimuth at B, continuing in the A→B direction — the leg's **arrival/inbound true course**.

GeographicLib documents angles in degrees, longitude increasing east, azimuth increasing clockwise from north, and `azi2` as the forward azimuth at the second point ([GeographicLib interface](https://geographiclib.sourceforge.io/html/python/interface.html)). Its WGS84 inverse routine is an appropriate reference implementation. Normalize both returned azimuths before storing them.

If the implementation uses a spherical great-circle primitive instead, the equivalent initial course formula is below, with latitudes `phi` and longitude difference `deltaLambda` in radians:

```text
theta1 = atan2(
  sin(deltaLambda) * cos(phi2),
  cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(deltaLambda)
)
initialTrue = normalize360(toDegrees(theta1))
arrivalTrue = normalize360(initialGreatCircleBearing(B, A) + 180)
```

The implementation must use one geodesic model consistently for route distances and courses; do not calculate distance spherically and course ellipsoidally in the same result.

The arrival course is not generally `reciprocal(initialTrue)`. A geodesic's forward azimuth changes along the earth's curved surface. FAA guidance explicitly notes that the course into a waypoint may not be 180 degrees from the course leaving the previous waypoint because avionics compute geodesic paths ([FAA AIM, “Impact of Magnetic Variation on PBN Systems”](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap1_section_1.html)).

## Magnetic travel course

Adopt NOAA's sign convention internally:

- declination `D > 0` east of true north;
- declination `D < 0` west of true north.

NOAA states `true bearing = magnetic bearing + declination`; therefore the planner's conversion is ([NOAA NCEI, Magnetic Declination](https://www.ncei.noaa.gov/products/magnetic-declination)):

```text
magneticCourse = normalize360(trueCourse - declination)
```

Evaluate declination for the date and position where each course is reported:

```text
outboundMagnetic(A→B) = normalize360(outboundTrue(A→B) - localDeclination(A, date))
inboundMagnetic(A→B)  = normalize360(inboundTrue(A→B)  - localDeclination(B, date))
```

This intentionally permits outbound and inbound magnetic values for one leg to differ by more than geodesic convergence alone, because declination changes with position and time. Persist the model name/version, evaluation date, and declination used with a computed route so results are reproducible. The World Magnetic Model is the official model family to use; its software warns that declination is undefined near magnetic poles ([NOAA NCEI, World Magnetic Model](https://www.ncei.noaa.gov/products/world-magnetic-model)).

## VOR radial and inbound course

FAA defines a VOR radial as a magnetic bearing extending **outward** from the station; FAA chart specifications likewise use outbound magnetic radials for VHF/UHF navaids and inbound magnetic bearings for LF/MF navaids ([FAA Control Tower Operator Study Guide, Appendix D](https://www.faa.gov/sites/faa.gov/files/2022-07/CTOSTUDYGUIDE%20_%20Feb%202022.pdf); [FAA IAC Specification 5, §§3.1.2 and 3.7.8.3.4](https://www.faa.gov/air_traffic/flight_info/aeronav/iac/media/IAC5/IAC-5-30JUN2021-Ch3.pdf)).

For a VOR route point V:

- **Outbound radial** for leg V→B: apply V's facility magnetic variation of record to the leg's outbound true course at V.
- **Inbound course** for leg A→V: apply V's facility magnetic variation of record to the leg's arrival true course at V.
- The radial occupied immediately before arriving at V is `reciprocal(inbound course)`.

Using the same east-positive internal sign convention:

```text
vorOutboundRadial = normalize360(outboundTrueAtV - facilityDeclination(V))
vorInboundCourse  = normalize360(inboundTrueAtV  - facilityDeclination(V))
arrivalRadial     = reciprocal(vorInboundCourse)
```

An intermediate VOR's inbound course and outbound radial describe different legs and are therefore not expected to be reciprocals. A VOR's facility declination must not be silently replaced with current WMM declination: FAA material states that station antenna orientation and the database's VOR declination must remain consistent, and distinguishes VOR station declination from current magnetic variation ([FAA PARC MagVar VOR recommendations, pp. 2–3](https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/avs/160422PARCMagVarVORRecs.pdf)). If facility variation is absent, current-WMM magnetic travel courses may still be shown, but operationally labelled VOR radial/course fields must be unavailable rather than estimated.

For NDBs, retain magnetic travel courses but render VOR-radial-specific fields as unavailable. If a future output adds an NDB bearing, label it **inbound bearing to the NDB**, consistent with FAA LF/MF chart convention.

## Unavailable values and warnings

- Represent unavailable numeric values internally as `null`, never `0`, `NaN`, or a made-up declination.
- Render `null` as `—` in the console table.
- Keep the route valid when true geometry exists but a magnetic value does not. Emit one deduplicated warning naming the route point, unavailable field, and reason.
- Magnetic travel course is unavailable when a trustworthy date/position-specific declination cannot be produced, including an undefined/unreliable magnetic-pole result.
- VOR radial/inbound-course fields are unavailable when the facility magnetic variation of record is missing, invalid, or has an unknown sign convention.
- Airports and NDBs always show `—` for VOR-only fields.

Suggested warnings:

```text
Warning: YHZ outbound magnetic course unavailable: declination unavailable for 2026-08-11.
Warning: YHZ VOR outbound radial unavailable: facility magnetic variation of record is missing.
```

## Acceptance examples

These examples should become unit tests:

| Input | Expected |
| --- | --- |
| `normalize360(-1)` | `359` |
| `normalize360(360)` | `0` |
| `reciprocal(359)` | `179` |
| true `090°`, declination `+10°` east | magnetic `080°` |
| true `090°`, declination `-10°` west | magnetic `100°` |
| VOR arrival inbound course `270°` | arrival radial `090°` |
| missing local declination | true course retained; magnetic travel course `null` / `—` |
| local WMM declination present, facility declination missing | magnetic travel course present; VOR radial/course `null` / `—` |

Tests should additionally use a non-east/west geodesic whose arrival azimuth differs from its departure azimuth, preventing an accidental `arrival = reciprocal(departure)` implementation.
