# ArcMap 10.x integration: installation and operation

LAIS integrates with ArcMap through a **push adapter**. The officer's workstation exports a layer as a package and uploads it over HTTPS with a personal token. LAIS never connects to ArcMap, ArcSDE or a geodatabase, and ArcMap never connects to the LAIS database.

```
ArcMap 10.x (officer's PC)                       LAIS server
┌──────────────────────────────┐   HTTPS POST     ┌────────────────────────────────────────┐
│ LAIS.pyt / lais_sync_cli.py  │ ───────────────▶ │ /api/gis/arcmap/packages (bearer token)│
│  • check polygons, CRS,      │  package.zip     │  → import job (queued → running → …)   │
│    mapped fields             │  + caseNo        │  → manifest checks (case, county, CRS) │
│  • export shapefile          │                  │  → new working version in staging      │
│  • manifest.json + export id │ ◀─────────────── │  → validation (rule set vN)            │
└──────────────────────────────┘  job status      └────────────────────────────────────────┘
```

## 1. Install

The adapter's files are in `integrations/arcmap/`. GIS officers can also download them from **ArcMap Sync → Download adapter**; that zip never contains a token.

| Item | Notes |
|---|---|
| ArcGIS Desktop 10.x | Tested with 10.7.1. ArcMap's Python is `C:\Python27\ArcGIS10.x\python.exe` (2.7, 32-bit). |
| ArcGIS Pro (optional) | The same toolbox and command line run under Pro's Python 3. |
| Network | HTTPS to the LAIS server. Plain HTTP is refused except to `localhost`. |
| Licence | Any ArcGIS Desktop licence level. The tools use `arcpy.da` cursors, `CreateFeatureclass` and `AddField` only. |

Copy the folder to the workstation, for example `C:\GIS\lais-arcmap`, then add `LAIS.pyt` in the Catalog window (**Add Toolbox**).

## 2. Configure: least privilege, no database passwords

1. The officer signs in to LAIS and creates a token under **GIS workspace → ArcMap Sync**. Tokens:
   - are personal;
   - expire after 7 to 90 days, chosen at creation (at most 5 active per officer);
   - can be revoked at any time;
   - are stored by LAIS only as a SHA-256 hash.
2. The token authenticates **only** the `/api/gis/arcmap/*` endpoints. The other endpoints refuse it, and it carries no session.
3. A sync job runs with the officer's **current** GIS officer grants. It can stage data only on draft or returned cases in the officer's own counties. Revoking the role or the token stops the adapter at once.
4. Configure the workstation with `LAIS_URL`, plus either `LAIS_SYNC_TOKEN` or a token file. The file is `%USERPROFILE%\.lais\sync_token` or the path in `LAIS_SYNC_TOKEN_FILE`. On Windows, protect the file with NTFS permissions so only its owner can read it; on Linux and macOS the adapter refuses a token file that other users can read.
5. Nothing in the adapter, the toolbox or the packages contains a database address or password. The PostgreSQL server should not be reachable from workstations at all (see [security.md](security.md#gis-data-and-the-arcmap-adapter)).

## 3. Operate

| Step | Toolbox tool | What happens |
|---|---|---|
| Check | **Test connection** | `GET /api/gis/arcmap/ping`: the account and the counties it can sync. LAIS records the contact time, so the sync page can show *last contact*. |
| Export | **Export LAIS package** | Checks that the layer has polygons, that its CRS is EPSG:4326 or 32629, and that the mapped fields exist; it never assigns a CRS. Writes `parcels.shp` with fixed field names (`SRC_ID`, `LEGACY_REF`, `LAND_CAT`, `LAND_USE`, `SURV_AREA`, `HOLDERS`, `HOLDER_TYP`, `NOTES`) and `manifest.json`, then zips them. |
| Sync | **Sync to LAIS** | Export, then upload. The tool reports the job number, its status and the new version. |

The manifest records:
- `adapter_version`, `export_id`, `case_no`, `county_code`, `srid` and `crs_name`;
- `feature_count` and `skipped_without_geometry`;
- `field_map` (LAIS target → shapefile field);
- `source_dataset`, `source_version`, `exported_at` and `warnings`.

### What the server checks before staging anything

All inside one transaction: if any check fails, nothing is staged and the job records why.

- The package is a zip with safe member names and allowed extensions only. Nothing in it is executed.
- The `.prj` CRS is accepted (4326 or 32629) and agrees with the manifest's `srid`.
- The manifest's case number and county match the case; the county is taken from the case, never from the file.
- The manifest's feature count matches the shapefile.
- Each record has a polygon with finite coordinates. Other records are rejected and listed in the job's error report.
- The case is still a draft or returned, and its feature limits are respected (for example, exactly one parcel for a first registration).

### Idempotency and retry

- **Same data, same identifier.** The export identifier is a SHA-256 hash of the case, county, CRS and each feature's geometry (WKT) and mapped attributes, in OID order. Exporting unchanged data again yields the same identifier.
- **Processed once.** A database unique index allows one *completed* job per case and export identifier. A resend returns the earlier job (`duplicate: true`) and stages nothing. Two simultaneous resends cannot both complete.
- **Safe retries.** The adapter retries network and 5xx failures three times with back-off. A failed job can be retried from **Processing Jobs**; the retry is a new job linked to the failed one. Jobs left running by a server restart are marked failed at start-up, so a job never half-finishes.

## 4. Monitoring and diagnostics

**ArcMap Sync** page:
- **Status**:
  - *not configured*: no active token;
  - *token not used yet*;
  - *configured*: the adapter has made contact; the page shows when.
- Last success and last failure, and the number of syncs in the last 7 days.
- Recent sync jobs with their export identifier and adapter version.
- **Diagnostic**:
  - role;
  - active token, and tokens expiring within 7 days;
  - whether the adapter has made contact;
  - adapter version;
  - server upload storage;
  - the last job.
- The page never claims a live connection: the server can see only the requests it receives.

**Processing Jobs** shows every import, sync and correction job with its status (queued, running, completed, completed with warnings, failed, cancelled). Each job opens a step-by-step diagnostic, a CSV error report, and retry.

**System Health** (administrators) reports active, stuck and recently failed jobs.

## 5. Troubleshooting

| Message | Cause and fix |
|---|---|
| *The coordinate reference system is unknown. The adapter never assigns one…* | The layer has no spatial reference. Confirm the CRS from the survey documentation, set it with **Define Projection**, and export again. |
| *The data is in … (EPSG:3857). LAIS accepts EPSG:4326 or EPSG:32629* | Project the data (**Data Management → Projections → Project**), check the result against the source, and export the projected layer. |
| *Mapped field(s) not in the feature class* | Correct the field mapping: `target=SourceField`, with targets from the list in the adapter's README. |
| *The server refused the token (401)* | The token expired, was revoked or was mistyped. Create a new token. |
| *403 … outside your assigned jurisdiction* | The case is in a county where you have no GIS officer role. |
| Job failed: *The package says county MG, but … is in MO* | The case number or county code in the tool does not match the case. |
| Job failed: *A registration case takes exactly one parcel feature* | Select or export only the parcel of that case. |
| Job *completed with warnings* | Records were rejected or attributes are missing. Open the job's error report. |

## 6. What was tested, and how

All on ArcGIS Desktop 10.7.1, ArcMap's Python 2.7.16 with ArcPy (32-bit), against the LAIS API on PostgreSQL 18.6 / PostGIS 3.6.2, on Windows 11, 28 October 2026:

- `tests/make_samples.py` built a file geodatabase with ArcPy, containing feature classes in EPSG:4326, EPSG:32629, EPSG:3857 and with no CRS. It derived the shapefile, CSV and package samples in `server/fixtures/gis/`. The adapter **refused** the unknown-CRS and Web Mercator layers.
- The toolbox `LAIS.pyt` was loaded with `arcpy.ImportToolbox`. **Export LAIS package** ran successfully, and refused the unknown-CRS layer with the expected message.
- `lais_sync_cli.py ping` and `sync` ran against the live API with a token created in the web application. The package became job GIS-000001, staged as version 1 with mapped attributes. A **resend returned the same job** and staged nothing; an invalid token was refused (401).
- Exporting the same data twice, with the field mapping in a different order, produced the same export identifier.
- Under Python 3.14 (no ArcPy), `ping` and `upload` worked.
- The server side (manifest checks, idempotency, token scope, revocation, county limits) is covered by `server/test/integration/gis.test.ts`.

**Not tested:**
- running the tools from the ArcMap toolbox dialog by hand (the same code ran through `arcpy.ImportToolbox`);
- ArcGIS Pro's Python environment;
- other ArcMap 10.x releases;
- a remote HTTPS deployment (the tests used `http://localhost`).
