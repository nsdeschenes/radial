# Magnetic-reference sources

Research captured 2026-08-17 for [Choose reproducible magnetic-reference sources](https://github.com/nsdeschenes/radial/issues/29).

## Conclusion

Radial can produce reproducible worldwide **Local Magnetic Declination** from the public-domain World Magnetic Model 2025 (WMM2025). It cannot derive **Facility Variation of Record** from that model: facility variation is an assigned, retained operational reference, not current local declination.

The FAA's 28-Day NASR Subscription is an authoritative, reproducible source of Facility Variation of Record for VOR-family facilities represented in NASR. No single authoritative, openly reusable, machine-readable worldwide source was identified. Radial should therefore keep the two values separate, use NASR only after a conservative unique record match, and leave Facility Variation of Record absent everywhere it cannot establish an authoritative match. A product decision is still needed on whether that partial-coverage policy is acceptable or whether Radial should adopt licensed regional sources or a simulation-specific source.

## Local Magnetic Declination: use WMM2025

NOAA identifies WMM as the standard model for navigation and heading-reference systems. The current WMM2025 coefficients have epoch 2025.0 and are valid for `2025.0 <= date < 2030.0`, through 2029-12-31. NOAA publishes the coefficient file, reference software, test values, technical report, and citation. NOAA also states that the WMM source code is public domain and that the information and software may be used freely. These properties make WMM2025 authoritative, license-compatible, and reproducible. See the [official WMM product page](https://www.ncei.noaa.gov/products/world-magnetic-model), NOAA's [model-range and licensing answers](https://www.ncei.noaa.gov/products/geomagnetism-frequently-asked-questions), and the [WMM2025 test values](https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025testvalues.pdf).

The producer contract should be:

- Calculate declination `D` with double-precision WMM2025 spherical-harmonic evaluation using the exact official `WMM.COF` coefficients. Conformance is against NOAA's published WMM2025 test vectors, not against an online calculator response.
- Use each Route Point's WGS84 geodetic latitude and longitude and a fixed height of `0 km` above the WGS84 ellipsoid. A fixed ellipsoidal height avoids making results depend on optional OpenAIP elevation or a separately versioned geoid. NOAA's test vectors use WGS84 ellipsoid heights, and NOAA says the geoid correction's effect on declination is negligible.
- As a Radial reproducibility policy, select one snapshot-wide magnetic reference date: the Navaid Snapshot retrieval-start UTC calendar date. Convert it using NOAA's definition, `year + day-of-year / days-in-year`. Require the result to fall in the half-open WMM2025 interval `[2025.0, 2030.0)`; a later reload must fail until the producer supports the succeeding model.
- Store `D` as unrounded degrees east-positive, normalized to `[-180, 180)`. This agrees with the AIXM convention: magnetic north east of true north is positive and `magnetic bearing + variation = true bearing`. See the [AIXM NavaidEquipment magnetic-variation definition](https://aixm.aero/sites/default/files/imce/AIXM511HTML/AIXM/Class_NDB.html).
- Treat declination as unavailable where WMM reports horizontal intensity `H < 2000 nT`. NOAA calls these polar regions Blackout Zones and says WMM declination is inaccurate there. Values in the `2000 <= H < 6000 nT` Caution Zone may be retained, but the producer should count them in status/provenance because the model is less reliable there. See NOAA's [WMM accuracy and limitation guidance](https://www.ncei.noaa.gov/products/world-magnetic-model/accuracy-limitations-error-model).
- Persist enough provenance to reproduce every value: model `WMM`, version `WMM2025`, epoch `2025.0`, validity start/end, reference date and decimal-year input, coordinate basis and fixed height, coefficient-file SHA-256, algorithm implementation/version, official source URL/DOI, and calculation policy version. The snapshot checksum covers these metadata and the resulting values.

This is **Local Magnetic Declination** only. It must never populate Facility Variation of Record.

## Facility Variation of Record: FAA NASR where uniquely matched

FAA documentation establishes the semantics that Radial needs. FAA Technical Operations assigns and maintains the magnetic variation of record for navigation facilities. An FAA charting record states that NASR is the sanctioned source for airport and Navaid magnetic variation and explains why a VOR's assigned value may intentionally lag local magnetic variation: changing it affects airways, procedures, and ATC systems. See the FAA's [facility-program responsibility](https://www.faa.gov/air_traffic/publications/atpubs/fac/1102.html) and [charting discussion of magnetic variation of record](https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/avs/Hist_11-01-296.pdf).

The downloadable [FAA 28-Day NASR Subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/Aero_Data/NASR_Subscription/) supplies archived AIRAC-cycle datasets. Its official TXT-to-CSV mapping defines these `NAV_BASE.csv` fields:

- `NAV_ID`, `NAV_TYPE`, facility name, country/state, and latitude/longitude identify the source record;
- `EFF_DATE` is the record's effective date;
- `MAG_VARN` and `MAG_VARN_HEMIS` carry whole degrees and `E`/`W` direction;
- `MAG_VARN_YEAR` carries the magnetic-variation epoch year.

The definitions are in the FAA's [NAV TXT-to-CSV mapping](https://nfdc.faa.gov/webContent/28DaySub/TXT_to_CSV_Mapping.pdf). FAA separately notes that DME-only facilities are not assigned station-declination values in NASR and that a WMM-derived value is computed separately to support ERAM. Radial must therefore admit NASR variation only for a VOR-family facility and never infer it for standalone DME. See the [FAA CIFP readme](https://aeronav.faa.gov/Upload_313-d/cifp/CIFP%20Readme.pdf).

For a matched VOR-family record, parse `E` as positive and `W` as negative, normalize to `[-180, 180)`, preserve the whole-degree source precision, and record `MAG_VARN_YEAR` strictly as the assigned variation's **epoch year**, not as its effective date or expiry. FAA procedure guidance treats magnetic variation of record as a fixed assigned value and distinguishes its epoch from the date on which the numeric value was calculated. The AIRAC and `EFF_DATE` values say which published record version was selected; the assigned variation remains the value of record until a later authoritative cycle revises it, so no unsubstantiated expiry date should be invented. The currently active directive is [FAA Order 8260.19K](https://www.faa.gov/regulations_policies/orders_notices/index.cfm/go/document.current/documentNumber/8260.19).

NASR is publicly distributed by the FAA. To the extent an archive is a U.S. Government work, [17 USC 105](https://uscode.house.gov/view.xhtml?edition=2023&num=0&req=granuleid%3AUSC-2023-title17-section105) makes U.S. copyright protection unavailable for work prepared by federal employees as part of their duties. That statute alone does not prove the status of every archive component. Radial must retain attribution and inspect each downloaded archive's README and terms for separately identified third-party material or other restrictions before treating it as license-compatible.

Required provenance for each accepted value is: source `FAA 28-Day NASR Subscription / NAV_BASE.csv`; AIRAC cycle and record effective date; archive URL and SHA-256; raw `NAV_ID`, `NAV_TYPE`, coordinates, variation, hemisphere, and epoch-year fields; normalized value; matched OpenAIP record ID; and the matching-policy version. Only a unique conservative match may publish a value. Ambiguous, conflicting, missing, or non-VOR-family records produce no Facility Variation of Record rather than a guess.

## Why there is no accepted worldwide Facility Variation source

The AIXM model reinforces the need to keep the concepts separate, but a schema is not a dataset. `NavaidEquipment.magneticVariation` and `dateMagneticVariation` describe local measured magnetic variation and its year. A VOR's facility alignment is instead `VOR.declination`, qualified by `zeroBearingDirection`; AIXM 5.1.1 does not attach a dedicated epoch-year field to that station declination. A global AIXM source would therefore need field-level verification and a separate provenance rule rather than mapping `magneticVariation` into Facility Variation of Record. See the official [AIXM VOR model](https://aixm.aero/sites/default/files/imce/AIXM51HTML/AIXM/Class_VOR.html). National and regional AIS products are fragmented and do not share one open reuse contract.

- EUROCONTROL's EAD contains navaids and supports AIRAC downloads, but automated or commercial reuse requires an EAD agreement and can incur service, royalty, and insurance obligations. EAD Basic is limited consultation access. See the [European AIS Database service terms](https://www.eurocontrol.int/service/european-ais-database).
- NAV CANADA describes itself as the official owner of Canadian aeronautical data and sells Navaid datasets under a commercial data licence, potentially with user fees and liability-insurance requirements. See [NAV CANADA Data Sales](https://www.navcanada.ca/en/aeronautical-information/data-sales.aspx).
- OpenAIP's API exposes an optional `magneticDeclination` number but documents no source, effective date, distinction between local declination and assigned station variation, or sign convention. OpenAIP is crowd-sourced and licensed CC BY-NC 4.0. Its field is therefore unusable as Facility Variation of Record under the Route Planner contract even though OpenAIP remains the accepted raw Navaid source. See the live [OpenAIP Navaid schema](https://api.core.openaip.net/api/schemas/response/navaid/navaid-schema.json) and [OpenAIP data licence](https://www.openaip.net/).
- ICAO sells a USD 5,000, AIRAC-updated global [Airways + Waypoints + Navaids dataset](https://store.icao.int/en/airways-waypoints-navaids-dataset-one-time) under a required licence agreement. Its public catalogue does not establish that the VHF layer contains Facility Variation of Record or that Radial may redistribute derived values. It is an investigated commercial candidate, not an accepted source, unless a later licensing and field-level review proves both points.

No authoritative source found during this research combines worldwide coverage, explicit facility-of-record semantics and dates, automated reproducible access, and terms compatible with an unrestricted Radial data pipeline. Adopting ICAO or another commercial source would be a product/licensing decision and would make reproduction depend on licensed inputs.

## Decision enabled by this research

The producer specification can lock WMM2025 for Local Magnetic Declination now. Facility Variation of Record requires a follow-on scope decision among:

1. authoritative partial coverage (initially FAA NASR) with explicit missing values elsewhere;
2. licensed regional/global sources, with credentials and redistribution constraints added to the product contract; or
3. a named simulation-data source whose authority is explicitly scoped to flight simulation rather than real-world AIS.

It must not silently use model-derived Local Magnetic Declination or OpenAIP's ambiguous field as Facility Variation of Record.
