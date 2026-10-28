# Prompt 3 completion report: GIS Officer Dashboard, ArcMap integration and spatial data management

Date: 28 October 2026. Environment: Windows 11, PostgreSQL 18.6 with PostGIS 3.6.2, Node.js 24, ArcGIS Desktop 10.7.1 (ArcMap Python 2.7.16 with ArcPy), Microsoft Edge.

This prototype runs on synthetic data. "Verified" below means exercised by automated tests, the browser walkthroughs, or a recorded run with ArcPy, as stated in each row.

## Results

| Check | Result |
|---|---|
| Server unit tests | 44 passed |
| Server integration tests (110 existing + 32 new GIS tests) | 142 passed |
| Web component tests (24 existing + 7 new GIS tests) | 31 passed |
| ESLint, TypeScript, production build | 0 problems, clean, clean |
| Browser walkthroughs (`npm run e2e`, 9 scripts including the new `gis` walkthrough of 15 steps) | 113 steps passed, 0 problems. The GIS officer now lands on the GIS dashboard, so four older scripts open the case list explicitly |
| ArcMap adapter with real ArcPy 10.7 | Toolbox loaded and run, packages exported, uploaded to the live API, resend deduplicated (details in [arcmap-integration.md](arcmap-integration.md#6-what-was-tested-and-how)) |

## Delivered

| Requirement | Implementation | Verified by |
|---|---|---|
| GIS Officer dashboard, 12 KPI cards | `GET /api/gis/summary`, `pages/gis/GisDashboard.tsx` | integration test (12 keys, county scope), web test, walkthrough |
| My GIS Tasks: acknowledge, begin, note, block, clarify, complete (not before the workflow step is done) | `/tasks/{id}/acknowledge`, `/claim`, `/clarification`; completion of preparation tasks refused until the case is submitted; conflict investigations need submitted findings | integration test, walkthrough |
| Parcel Workspace map | Layers: approved reference, working, submitted, invalid geometry, overlaps, duplicate identifiers, county boundary. Also a basemap switch (OpenStreetMap or none), a scale bar, WGS 84 and UTM 29N coordinates (checked against ArcPy), a legend and search | integration test, web test, walkthrough |
| Data Import Center, 8 steps | Upload & inspect → layer → target case → field mapping → CRS → preview → confirm → result with error report | web test (CRS gating), walkthrough |
| Formats | GeoJSON, zipped shapefile, CSV with WKT, LAIS ArcMap package. File geodatabase and GeoPackage are explained as unsupported: no adapter in the server stack | integration tests |
| CRS: never silent | An unknown CRS needs a declaration, a 10+ character reason (stored on the job) and confirmation. Contradictions with file metadata and unsupported systems are refused | integration tests, web test, adapter run |
| ArcMap 10.x adapter | `integrations/arcmap/`: `LAIS.pyt` toolbox, `lais_arcmap.py`, CLI. It checks polygons, CRS and fields; writes a shapefile with a manifest and a deterministic export ID; uploads with retry | ArcPy 10.7 runs, Python 3 run, integration tests |
| Idempotent, safe retry | Export ID from a content hash. A unique index allows one completed job per case and export. A resend returns the earlier job. Retries are new jobs linked to the failed one. Interrupted jobs are failed at start-up | integration tests, live resend |
| Least-privilege authentication, no database passwords | Personal sync tokens: hash-only, expiring, revocable, valid only on `/gis/arcmap/*`, carrying the current GIS officer grants only | integration tests, walkthrough |
| Sync dashboard | Status as observed (never "live"), tokens, recent sync jobs, diagnostic, adapter download; manual package upload through the import wizard | web test, walkthrough |
| PostGIS lifecycle: staging → working → submitted → published | Numbered versions (`staging.batch.version_no`, `parent_batch_id`). Submitted versions frozen by a trigger. Publication remains the only path to the register | integration tests |
| Validation Center | Filters, zoom to the feature, CSV export, re-run. Rule severities are admin-configurable, with an append-only version history; each run records its rule-set version and the boundary status. New rules: multipart, unusually large, duplicate source ID | integration tests, walkthrough |
| Conflict investigation | Notes, re-run checks, submit findings. No resolve, dismiss or delete | integration test, walkthrough |
| Versions and comparison | Feature-by-feature comparison (geometry shift, area, exclusion, attributes) with a map overlay. Corrections create new versions | integration test, walkthrough |
| Submission with checklist | Blocking errors are refused (409) with no exception route; warnings must be acknowledged; resubmissions explain changes. The snapshot hash is linked to the previous submission; the status is derived | integration tests, web test, walkthrough |
| Returned submissions | Reviewer notes, instructions, issue categories, affected features, open task | integration test, walkthrough |
| GIS Processing Jobs | Queued, running, completed, completed with warnings, failed, cancelled. Diagnostics, CSV error report, retry, cancel (queued only) | integration tests, walkthrough |
| GIS reports | Five reports as JSON, CSV and **server-generated PDF** | integration test, walkthrough |
| API and OpenAPI | 46 new endpoints with summaries; bodies and queries from Zod; bearer security scheme for the sync endpoints; validated against the OpenAPI 3.1 schema | OpenAPI test |
| Constraints on GIS officers | Cannot approve or publish, change ownership, delete versions, alter audit, or reach another county | integration tests ([security.md](security.md#limits-on-the-gis-officer)) |
| Docs | [arcmap-integration.md](arcmap-integration.md) (install, configuration, operation, troubleshooting, test record), [gis-sync.md](gis-sync.md) (formats, lifecycle, jobs, rules, submission), [security.md](security.md) (GIS officer limits, uploads, tokens, database exposure), README, status | |
| Synthetic sample datasets | `server/fixtures/gis/`: shapefile with and without `.prj`, UTM 29N shapefile, CSV with WKT, an ArcMap package. All produced by ArcPy (`integrations/arcmap/tests/make_samples.py`) | used by the tests and the walkthrough |

## Security constraints

| Constraint | How it is met |
|---|---|
| No secrets in source control | Tokens exist only in the database (as hashes) and on the officer's workstation (environment variable or a private file). Test tokens are generated at run time. `.env` stays ignored. |
| No database passwords in Python scripts or configuration | The adapter has no database connection at all. |
| No claim of a live ArcMap connection that was not configured and tested | The sync page reports the last observed contact and says it is not a live connection. The adapter was tested against the local API only, and the docs say so. |
| Never assign a CRS silently | Enforced in the wizard, the API (declaration, reason, confirmation, contradiction check) and the adapter (refuses unknown and unsupported CRSs). |
| No passwords, tokens or document contents in logs | Logs and audit details carry job numbers, file names, hashes and counts. The adapter logs only the token's last four characters. |
| Uploaded files are untrusted and never executed | In-memory parsing, an extension allow-list, path-traversal checks, size and feature limits, scalar-only attributes, parameterised WKT parsing. |
| PostgreSQL not exposed | Workstations need only HTTPS to the API; deployment guidance is in [security.md](security.md#gis-data-and-the-arcmap-adapter). |

## Not done, partial or changed

| Item | Status |
|---|---|
| File geodatabase and GeoPackage upload | Not supported: no GDAL or FileGDB adapter in the server stack. The wizard explains this and points to the ArcMap adapter or a shapefile/GeoJSON export. |
| Job worker | Jobs run in the API process (asynchronously, with restart recovery), not in a separate worker. |
| ArcMap toolbox dialog | The tools ran through `arcpy.ImportToolbox`, not by hand in the ArcMap interface. ArcGIS Pro's Python and other 10.x releases were not tested. |
| Remote HTTPS deployment | The sync was tested against `http://localhost` only. |
| Geometry editing in the browser | Not provided on purpose. Geometry changes come back through ArcMap or a file import; attributes can be corrected in LAIS as new versions. |
| Previously "unknown" background jobs health | Now derived from the job table (active, stuck, failed). |
| Supervisor reports PDF | Still printed from the browser. GIS reports have server-side PDF. |
| `a.button` styling bug | Found during this phase: link-buttons had text the same colour as their background, which also affected *New case* on the case list. Fixed globally. |

## Main files

**Server**
- Migration: `db/migrations/011_gis_workspace.sql`.
- Services: `services/gisFormats.ts`, `gisJobs.ts`, `staging.ts`, `pdf.ts`; changes to `validation.ts` and `conflicts.ts`.
- Routes: `routes/gis.ts`, `gisWork.ts`, `gisSync.ts`, plus changes to `tasks.ts` and `adminOps.ts`.
- Auth and policy: `auth/syncToken.ts`, `authz/policy.ts`.
- Tests: `test/integration/gis.test.ts`.

**Web**
- Pages: `pages/gis/*` (dashboard, tasks, workspace, import wizard, ArcMap sync, jobs, validation center and rules, conflicts, versions, submissions, returned, reports), with tests in `pages/gis/Gis.test.tsx`.
- Shared: `components/WorkspaceMap.tsx`, plus navigation and routes.

**Adapter**
- `integrations/arcmap/LAIS.pyt`, `lais_arcmap.py`, `lais_sync_cli.py`, `tests/make_samples.py`, `README.md`.

**Walkthrough**
- `e2e/gis.mjs`.
