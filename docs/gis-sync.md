# GIS data management and synchronization

How spatial data enters LAIS, how it is versioned and validated, and how it reaches the register. For ArcMap set-up, see [arcmap-integration.md](arcmap-integration.md).

## Data lifecycle

```
upload ──▶ import job ──▶ working version (staging) ──▶ submitted snapshot ──▶ approved ──▶ published version
           queued/running/  v1, v2, … (one active;      frozen (trigger),     registrar     lais.parcel_version
           completed/…      earlier ones superseded)    hash recorded         decision      (only via publication)
```

| Stage | Where | Who | Mutable? |
|---|---|---|---|
| **Staging / working version** | `staging.batch` (with `version_no`, `source_kind`, `parent_batch_id`, `change_reason`) and `staging.feature` | GIS officer, through imports, ArcMap syncs and attribute corrections | Only while the case is a draft or returned. Exclusions can be set on the active version until it is submitted. |
| **Submitted** | `staging.submission`, numbered `SUB-000001` | GIS officer (`case.submit`) | No. A trigger freezes the features of a submitted version. A correction always creates a new version. Submissions are append-only and link to the previous one. |
| **Approved** | `lais.case_decision` with a snapshot hash | Registrar | No. Publication re-checks the hash. |
| **Published** | `lais.parcel_version` | Registrar (`case.publish`) | No. History triggers apply. |

GIS officers cannot approve, publish, change ownership, delete a version, alter the audit trail or work outside their counties. Integration tests check each of these.

## Import formats

| Format | Accepted as | CRS source |
|---|---|---|
| GeoJSON (`.geojson`, `.json`) | A file or an archive member | The `crs` member, if present. Otherwise the officer declares it (GeoJSON is WGS 84 by RFC 7946, but the officer must still confirm it). |
| Shapefile | A `.zip` holding `.shp`, `.shx`, `.dbf`, optionally `.prj` and `.cpg`. Several layers are allowed. | `.prj`: an AUTHORITY tag, or the WGS 84 / UTM 29N names |
| CSV with WKT | `.csv` with a column of WKT polygons, detected automatically or chosen in the wizard | Declared by the officer |
| LAIS ArcMap package | A `.zip` with `manifest.json` and a shapefile | `.prj`, cross-checked against the manifest |

**Not imported directly**, with an explanation in the wizard:
- **File geodatabase** (`.gdb`): needs Esri's FileGDB API or GDAL, neither of which is in the server stack. Export the layer with the ArcMap adapter, or as a shapefile or GeoJSON.
- **GeoPackage** (`.gpkg`): needs a SQLite and GDAL adapter, not in the server stack.
- **KML/KMZ, DWG/DXF, personal geodatabase** (`.mdb`): not supported.

Uploads are untrusted. They are limited to:
- 50 MB per file and 200 MB unzipped;
- 60 archive entries and 5,000 features;
- an allow-list of extensions inside archives, with safe member names (no paths, no traversal) and no duplicate layer names.

Uploads are read in memory and never executed. The raw file is kept under a random key for 24 hours (`GIS_UPLOAD_RETENTION_HOURS`) so it can be previewed and retried, then deleted.

## Coordinate reference systems

| Rule | |
|---|---|
| Accepted | **EPSG:4326** (WGS 84) and **EPSG:32629** (WGS 84 / UTM 29N). Other systems are refused; reproject in the GIS tool. |
| Never silent | When the file states its CRS, a declaration that contradicts it is refused. When it does not, the officer must declare the CRS **and** record how it was established (10 or more characters, stored as `crs_exception_reason` on the job), and confirm it in the wizard. |
| Stored | Each feature keeps the input geometry exactly as received, in the declared CRS. Valid geometry is also stored transformed to EPSG:4326 for checks and display. Invalid geometry is never repaired. |

## Import jobs

Every import, ArcMap sync and attribute correction is a job in `staging.import_job` (`GIS-000001`, …) with:

- **status**: queued, running, completed, completed with warnings, failed or cancelled;
- **source**: file name, size, SHA-256 and layer; for ArcMap, also the adapter version, dataset and export identifier;
- **CRS**: detected, declared, the exception reason, and the target;
- **field mapping**;
- **counts**: received, accepted, rejected, inserted and unchanged;
- warnings, rejections and the error summary;
- the version created, if any;
- `retry_of`, linking a retry to the failed job.

| Behaviour | |
|---|---|
| Atomic | A job stages a complete new version, or nothing. |
| Background | Jobs run in the API process. The client polls, or asks to wait up to 20 seconds. Jobs interrupted by a restart are marked failed at start-up. |
| No duplicates | A source identical to the current version (same file hash, layer, mapping and CRS) creates no new version. An ArcMap export identifier is processed once per case. |
| Retry | Failed or cancelled jobs can be retried by their owner, as a new job. |
| Error report | `GET /api/gis/jobs/{id}/report.csv` lists the rejected records and warnings. |

**Field mapping.** The LAIS targets are `source_id`, `legacy_ref`, `land_category`, `land_use`, `surveyed_area_m2`, `holder_names`, `holder_type` and `notes`. Unmapped source fields are kept under their own names. Required targets per case type (for example `legacy_ref` and `land_category` for migration) are flagged in the preview; validation decides what blocks.

## Validation rules

Rules live in `staging.validation_rule`, each with:
- a category: geometry, spatial, boundary, identifier, attribute, completeness, rights or workflow;
- a default and a current severity;
- a `configurable` flag;
- fix guidance.

**Safety rules are fixed**: invalid geometry, wrong county, CRS problems and identifier errors. A database CHECK keeps their severity at the default. Administrators can make a configurable rule blocking or advisory under **Validation Rules**, with a reason. Every change is a new row in the append-only `staging.rule_set_version`.

Each validation run records the rule-set version it applied and the county's boundary status (`synthetic`, `provisional` or `verified`). When a configured severity differs from the default, the finding keeps the default in `detail.defaultSeverity`.

Rules added in this phase:
- `MULTIPART_GEOMETRY` (warning);
- `AREA_UNUSUALLY_LARGE` (warning; `MAX_PARCEL_AREA_M2`, default 5 km²);
- `DUPLICATE_SOURCE_ID` (warning).

The **Validation Center** lists the findings of the latest run of every spatial case in scope. It can filter by severity, category, rule and case, zoom to the feature on the map, re-run validation for a case, and export CSV.

## Submission to the supervisor

`GET /api/gis/cases/{id}/submission-check` runs validation (without storing it) and returns a checklist:
- geometry and CRS;
- blocking errors;
- warnings to acknowledge;
- the case status;
- the previous submission;
- the last return reason.

`POST /api/gis/cases/{id}/submit`:
- is **refused with 409 while blocking errors remain**: there is no exception route;
- requires the checklist to be confirmed and the warnings acknowledged;
- for a resubmission, requires an explanation of what changed.

The submission records the snapshot hash of the submitted version, its validation run (with the rule-set version) and the link to the previous submission. Its status is derived, never set by hand:
- awaiting supervisor, accepted by supervisor, or information requested;
- returned, or returned by validation;
- superseded;
- approved, published, rejected or withdrawn.

`GET /api/gis/submissions/{id}` re-hashes the submitted version and reports whether the snapshot is intact.

## Administrator monitoring

**Administration → GIS Synchronization** still lists the staging batches with their latest validation. **System Health** reports active, stuck (running over 10 minutes) and recently failed GIS jobs.

## Before a real integration

- Set official tolerances and area thresholds in `server/.env`, replacing the placeholders.
- Replace the synthetic county boundaries with verified ones.
- Agree the export procedure and the field mapping with the cadastral authority.
- Decide whether file geodatabase or GeoPackage intake is needed. If so, add GDAL as a server-side adapter.
- For large volumes, move jobs from the API process to a dedicated worker. The job table already records everything a worker needs.
