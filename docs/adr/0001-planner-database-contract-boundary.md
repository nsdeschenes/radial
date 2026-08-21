---
status: accepted
---

# Concentrate the Planner Database Contract in a neutral module

Radial will define its public DuckDB planner relations in a neutral Planner Database Contract module shared by the Producer Schema and Route Planner. The module owns public relation names, canonical and minimum-compatible projections, compatibility validation, and contract-row interpretation; the Producer Schema retains private storage, publication, and migration mechanics, while the Route Planner retains Route Search queries and adaptation into planner domain types. This direction keeps projection facts local without coupling either adapter to the other or exposing private producer tables.

Producer Schema is the sole seam for Navaid Snapshot storage and Data Status interpretation, while candidate derivation and independent pre-publication validation remain separate in-process collaborators.

Compatible databases may add columns but must provide every required column with the required type and planner-ready row semantics. Radial's Producer Schema additionally verifies its complete canonical projection. Compatibility is capability-based rather than dependent on the private `planner_contract_version`, and Radial validates it both when opening a planner and inside each Route Plan transaction.
