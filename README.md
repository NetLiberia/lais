# LAIS — Liberia Land Information System (research prototype)

Phase 3 prototype for the MSc project *Development and Evaluation of a Privacy-Aware Web-Based Land Information System for Parcel Visualization, Ownership Verification, and Spatial Conflict Detection in Liberia*.

> **Synthetic data only.** County boundaries are simplified rectangles, parties and parcels are fictional, and identifiers use a provisional `PROV-XX-000000` pattern, not the official Liberian UPI. Roles, workflows and disclosure rules are a proposed technical control model. They are not Liberian law, and they must be validated with the Liberia Land Authority and legal advisers before any official use.

## What it does

| Capability | Where |
|---|---|
| Public cadastral map and parcel search. Only an allow-listed set of fields; no owner data | `web/src/pages/PublicPortal.tsx`, `server/src/routes/public.ts` |
| LADM-style data model: parties, rights (RRR), versioned parcels, cases, documents, decisions | `server/db/migrations/001_core.sql` |
| Four land categories (public / government / customary / private), kept separate from rights and status | `001_core.sql` |
| Joint ownership with exact fractional shares, customary tenure by communities, mortgages, leases, easements | `services/validation.ts`, `services/shares.ts` |
| RBAC + county jurisdiction + record status + separation of duties, checked on every request | `server/src/authz/policy.ts` |
| Case workflow (draft → validating → under review → approved → published, plus returned / rejected / withdrawn), also enforced by a database trigger | `authz/workflow.ts`, trigger in `001_core.sql` |
| GIS staging: GeoJSON, zipped shapefiles, CSV with WKT and ArcMap packages in EPSG:4326 or 32629. The CRS is never assigned silently: an unknown one must be declared with a recorded reason. Data is stored as received and never auto-repaired. Every import is a numbered working version created by a background job | `services/gisFormats.ts`, `services/gisJobs.ts`, `services/staging.ts`, `002_staging.sql`, `011_gis_workspace.sql`, [docs/gis-sync.md](docs/gis-sync.md) |
| GIS officer workspace, in the officer's own counties:<br>• a dashboard with 12 KPIs, tasks (acknowledge, claim, clarify, complete only after submission), and a parcel workspace map with reference, working, submitted, invalid, overlap, duplicate and boundary layers;<br>• an 8-step Data Import Center, processing jobs with diagnostics and retry, and a Validation Center with administrator-configurable, versioned rule severities;<br>• conflict investigation, version comparison on a map, attribute corrections as new versions, and submission to the supervisor with a checklist (blocking errors refused, frozen snapshots linked to the previous submission);<br>• returned submissions, and GIS reports (JSON, CSV, PDF) | `pages/gis/`, `routes/gis.ts`, `routes/gisWork.ts` |
| ArcMap 10.x synchronization: a Python toolbox and command line export validated packages with a deterministic export ID and upload them with a personal, revocable, hash-stored token (no database credentials anywhere). Resends are processed once. Tested with ArcPy 10.7 | `integrations/arcmap/`, `routes/gisSync.ts`, `auth/syncToken.ts`, [docs/arcmap-integration.md](docs/arcmap-integration.md) |
| Validation and conflict detection: invalid / self-intersecting, swapped axes, wrong CRS, outside county, crosses county boundary, overlaps with published parcels, suspected duplicates, competing open submissions, duplicate UPIs | `services/validation.ts` |
| Conflicts are **warnings**: the registrar must acknowledge each one with a note before approving. The system never decides a dispute | `routes/cases.ts` |
| Decision snapshot: approval records a hash of exactly what was reviewed; publication refuses and reopens the case if anything changed | `services/snapshot.ts`, `services/publication.ts` |
| Atomic publication (single transaction, serialised per county) with full rollback on failure | `services/publication.ts` |
| Transfers end old interests and register new ones; history is immutable (triggers block edits and deletes) | `publication.ts`, `001_core.sql` |
| Subdivision (one parcel into 2–50) and consolidation (2+ parcels into one): new parcels must not overlap each other and must cover the source area exactly; rights are recorded per new parcel; sources are retired, never deleted, and parent→child lineage is kept. Retired identifiers on the public portal point to their replacements | `services/validation.ts` (`reshapeChecks`), `services/publication.ts` (`publishReshape`), `004_reshaping.sql` |
| Corrections: fix a published boundary or attributes (land use, category, source reference, surveyed area) by publishing a new version; the erroneous version stays in the history and rights are never changed. Requires a stated reason and verified evidence (a survey plan for boundary changes). Large boundary moves are flagged (`SIGNIFICANT_BOUNDARY_CHANGE_M`, `SIGNIFICANT_AREA_CHANGE_PCT`) | `correctionChecks`, `publishCorrection`, `006_corrections.sql` |
| Legacy migration: brings up to 1000 parcels from an existing register or GIS layer through the same staging, validation and approval. Each feature carries `legacy_ref`, `land_category`, and optionally `land_use`, `surveyed_area_m2`, `holder_names` and `holder_type`. Faulty features are flagged individually and can be excluded (quarantined) with a reason; re-runs are safe (`ALREADY_MIGRATED`). Legacy holders become **documented**, not registered, interests with unverified parties, and the public map says so. A per-feature reconciliation report (CSV) gives counts in and out | `migrationChecks`, `publishMigration`, `services/legacy.ts`, `007_migration_batches.sql` |
| Confirmation: registers verified holders of a parcel whose interests are only documented (e.g. after migration). It needs verified parties, valid shares and verified evidence; it is refused if a registered owner already exists. Names that differ from the legacy record are flagged for the registrar, never matched automatically. The documented interests end and stay as history. Parcel pages with documented interests link straight to a pre-filled confirmation case | `confirmationChecks`, `008_confirmation_cases.sql` |
| Disputes: recorded by registrars, block transfers, closed with a recorded outcome | `routes/parcels.ts` |
| Protected documents: content-type sniffing, private storage, SHA-256 integrity check on every read, classification-based access, all downloads audited | `routes/cases.ts`, `routes/documents.ts` |
| Authentication: scrypt hashes, progressive lockout, sign-in rate limits per account (plus a generous per-address ceiling, so offices sharing one connection are not locked out), server-side sessions (hash-only token storage), CSRF tokens, optional mandatory TOTP MFA for privileged roles | `server/src/auth/*`, `routes/auth.ts` |
| Append-only, hash-chained audit log with tamper detection | `003_audit.sql`, `routes/audit.ts` |
| Landowner portal: only interests registered to parties linked to the account by staff | `routes/me.ts`, `pages/MyParcels.tsx` |
| Administrator dashboard: live summary cards and charts with click-through, recent activity and system health from real checks. Every number comes from the database | `pages/admin/AdminDashboard.tsx`, `routes/adminOps.ts` |
| User management without the administrator ever handling passwords: invited accounts, one-time activation and reset links, roles with county scope, suspension with reasons, last-administrator and self-change protection, and an audited staff export | `pages/admin/UsersPage.tsx`, `routes/admin.ts`, `009_admin_foundation.sql` |
| County management for all 15 counties: no invented boundaries, provisional imports, verification with provenance, and enablement gating new cases | `pages/admin/CountiesPage.tsx` |
| GIS synchronization monitoring, settings, document categories, backups with a restore check, CSV reports, in-app notifications, global search, and an audit view limited to technical events | `pages/admin/`, `routes/adminOps.ts` |
| OpenAPI 3.1 description generated from the routers (`/api/openapi.json`), with request bodies and query parameters taken from the handlers' own Zod schemas; structured JSON logs and request correlation IDs | `openapi.ts`, `logger.ts` |
| Supervisor dashboard: live KPIs and charts in the supervisor's county scope, an application work queue, GIS quality review (accept, return for correction with categories and records, request information) with a review map, spatial conflict review, tasks with a Kanban board, staff workload, overdue work and bottlenecks, 12 audited reports, escalations and activity history. Quality acceptance is not legal approval; the administrator decides whether it is required before a registrar's approval | `pages/supervisor/`, `routes/supervision*.ts`, `routes/tasks.ts`, `routes/escalations.ts`, `010_supervision.sql`, [docs/workflow.md](docs/workflow.md) |
| Landowner document requests: a landowner asks for copies on a parcel where they hold a registered interest; a processor chooses verified documents from published cases; a different registrar approves or refuses with a reason; copies can be downloaded for `DOCUMENT_RELEASE_DAYS`. Eligibility is re-checked at every download, highly sensitive documents are never released (enforced in the database too), and every download is audited | `routes/me.ts`, `routes/documentRequests.ts`, `005_document_requests.sql` |

## Architecture

```
web/   React 18 + TypeScript + Leaflet (Vite dev server proxies /api)
server/ Node.js + Express 5 + TypeScript
        ├─ src/authz      pure permission policy + workflow (unit-tested)
        ├─ src/auth       passwords, sessions, CSRF, TOTP
        ├─ src/routes     public, auth, cases, documents, parcels, parties, admin, audit, me
        ├─ src/services   validation, publication, snapshot, GeoJSON intake
        └─ db/migrations  lais (registry), staging (GIS submissions), audit (hash chain)
PostgreSQL + PostGIS — the authoritative store. ArcGIS / QGIS feed it only through staging.
e2e/    Playwright browser walkthroughs (npm run e2e)
```

More detail is in [docs/](docs/):
- [architecture](docs/architecture.md)
- [database schema](docs/database-schema.md)
- [permission matrix](docs/permission-matrix.md), generated from the code
- [security and privacy](docs/security.md)
- [GIS synchronization](docs/gis-sync.md)
- [backup and restore](docs/backup-restore.md)
- [workflow and supervision](docs/workflow.md)
- [Docker Compose](docs/install-docker.md) (unverified)
- [implementation status](docs/status.md)

## Setup on Windows

### 1. Install PostgreSQL and PostGIS

1. Download the PostgreSQL 16 (or 17) Windows installer from <https://www.enterprisedb.com/downloads/postgres-postgresql-downloads> and run it. Keep the default port **5432** and note the password you set for the `postgres` superuser.
2. At the end, let **Stack Builder** launch. Choose your PostgreSQL install → *Spatial Extensions* → **PostGIS 3.x Bundle**, and install it.
3. Open **SQL Shell (psql)** from the Start menu, sign in as `postgres`, and run:

```sql
CREATE ROLE lais_owner LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE lais OWNER lais_owner;
\c lais
CREATE EXTENSION postgis;
-- Only if you will run the integration tests (they wipe this database each run):
CREATE DATABASE lais_test OWNER lais_owner;
\c lais_test
CREATE EXTENSION postgis;
```

Creating the extension as `postgres` means the app's own account does not need superuser rights.

**Shortcut:** once PostgreSQL is running, `powershell -ExecutionPolicy Bypass -File server\scripts\setup-local-db.ps1` does steps 1.3 and 2 for you. It prompts for the `postgres` password and a new `lais_owner` password, creates both databases with PostGIS, and writes `server/.env`. Passwords are typed into the script, not stored in any shared file.

### 2. Configure

```bash
copy server\.env.example server\.env
```

Edit `server/.env`:
- `DATABASE_URL=postgres://lais_owner:choose-a-password@localhost:5432/lais`
- `MFA_ENCRYPTION_KEY`: generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SEED_PASSWORD`: at least 12 characters; every demo account gets this password
- `TEST_DATABASE_URL=postgres://lais_owner:choose-a-password@localhost:5432/lais_test` (optional)
- `PG_DUMP_PATH=C:/Program Files/PostgreSQL/18/bin/pg_dump.exe` if you want backups from the Settings page

### 3. Install, migrate, seed, run

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev:server     # terminal 1 → http://localhost:4000
npm run dev:web        # terminal 2 → http://localhost:5173
```

If another app already uses port 4000 or 5173, set `PORT=4100` in `server/.env` and start the web app with `LAIS_API_URL=http://localhost:4100` (and, if needed, `npx vite --port 5180` in `web/`). Vite will refuse a busy port, but on Windows a second server can sometimes share port 4000 with another app silently, so check that `/api/public/counties` returns a FeatureCollection.

`npm run db:reset` drops and rebuilds the development database (it refuses to run when `NODE_ENV=production`).

### 4. Tests

```bash
npm test
```

- **44 unit tests**: permission matrix (and a check that `docs/permission-matrix.md` matches it), CSV formula safety, cross-county denial, separation of duties, workflow (including a check that the TypeScript transition table matches the SQL trigger), TOTP RFC test vectors, password hashing, GeoJSON/CRS intake (including malformed files), fractional shares, file sniffing.
- **110 integration tests**: run against `TEST_DATABASE_URL` and skipped when it is unset. They cover public-API privacy, CSRF, the full registration, transfer, subdivision, consolidation, correction, legacy-migration and confirmation lifecycles, landowner document requests, rate limits, cross-county attempts by direct API call, all geometry fixtures in `server/fixtures/`, failed-publication rollback, SQL-level workflow and history guards, audit immutability and tamper detection, document access by classification, administrator limits, the account lifecycle (invitation, activation, reset, suspension), the dashboard figures against the database, county enablement, settings, backups, reports, the OpenAPI description, and supervision (county scope, no legal authority, quality review and the optional approval gate, returns, conflicts, task rules, reports and escalation closure). Two concurrency tests run only against a real multi-connection server. One publishes two overlapping parcels at the same moment and checks that the per-county lock lets only one through (verified to fail with the lock removed). The other checks that the audit hash chain survives 40 parallel writers.

- **33 GIS integration tests** (`gis.test.ts`). The shapefiles and the package come from ArcPy, in `server/fixtures/gis/`. They cover:
  - inspection of the shapefiles, CSV and packages;
  - unsafe archives, refused;
  - CRS rules (no declaration, no reason, contradiction, unsupported CRS, UTM storage);
  - jobs: preview, CSV import, duplicate source, rejected records, failure and retry, restart recovery, county isolation;
  - versions, corrections and comparison;
  - submissions: refused with errors, the snapshot frozen by a trigger, resubmission linked after a supervisor return;
  - ArcMap tokens: hash-only storage, sync scope, revocation, idempotent resend, manifest checks;
  - versioned rule configuration applied to runs;
  - GIS tasks, conflict investigation, dashboard, layers and reports.

Verified on PostgreSQL 18.6 + PostGIS 3.6.2 (Windows): 187 server tests in about 75 seconds with the default 10-connection pool.

`npm test` also runs **31 web component tests** (Vitest, Testing Library, jsdom). They cover:
- the shared dialogs: a reason is required, server refusals are shown, and focus stays where the user is typing;
- tables and paging;
- the navigation each role sees;
- the create-account form: county rules, no surveyor role, no password field, and a one-time link;
- URL filters: a filter chosen straight after clearing the search is kept;
- the GIS pages:
  - the import wizard will not preview data with an unknown CRS until it is declared, explained and confirmed;
  - submission is impossible with blocking errors;
  - a sync token is shown once;
  - the UTM 29N readout matches ArcPy to the centimetre.

`npm run lint` runs ESLint over the API, the web app and the walkthroughs. API responses are typed in `web/src/types.ts`, and `any` is a lint error outside test files.

**Browser walkthroughs.** With the API and web app running, `npm run e2e` drives Microsoft Edge through nine scripted journeys: registration, subdivision, document requests, corrections, legacy migration, confirmation, the administrator dashboard, the supervisor dashboard and the GIS officer workspace. It resets the development database before each one. Set `LAIS_WEB_URL` if the web app is not on port 5173, and `BROWSER_PATH` for another Chromium browser. Screenshots go to `e2e/shots/`. Last run: 113 steps, 0 problems.

**Backups.** `npm run backup:verify -w server -- <file>` restores a backup into `TEST_DATABASE_URL` and checks it (see [docs/backup-restore.md](docs/backup-restore.md)).

## Demo accounts (synthetic)

All use `SEED_PASSWORD`.

| Username | Role | Scope |
|---|---|---|
| `admin` | System administrator: dashboard, accounts, counties and settings; no land decisions | national |
| `gis.mo`, `gis.mg` | GIS officer | Montserrado / Margibi |
| `proc.mo`, `proc2.mo`, `proc.mg` | LAIS processor | Montserrado / Margibi |
| `reg.mo`, `reg.mg` | Land registrar | Montserrado / Margibi |
| `supervisor` | Supervisor: oversight and quality control, plus national read-only views | national |
| `sup.mo` | Supervisor assigned to one county (sees only Montserrado) | Montserrado |
| `auditor` | Independent auditor (read-only) | national |
| `owner.demo` | Landowner, linked to the synthetic party "Musu Testperson" | own interests |

## Walkthrough: register a parcel that overlaps existing ones

1. **gis.mo** → Cases → *New case* → First registration, Montserrado, private.
2. Import `server/fixtures/overlap_published_4326.geojson` with **EPSG:4326** declared. Upload `server/fixtures/synthetic_document.pdf` as a *survey plan*.
3. **proc.mo** → open the case → add *Hawa Testperson* as owner → upload the same PDF as a *deed*, then **verify the survey plan** (uploaded by gis.mo).
4. **proc2.mo** → verify the deed. (proc.mo cannot verify a document they uploaded.)
5. **gis.mo** → *Submit for review*. The case moves to *Under review* with four `OVERLAP_PUBLISHED_PARCEL` warnings.
6. **reg.mg** cannot see or decide the case: it is outside their county, and the attempt is audited.
7. **reg.mo** → acknowledge each warning with an investigation note → approve, citing a delegated-authority reference → *Publish*.
8. **auditor** → Audit → *Verify hash chain*.

Other fixtures: `adjacent_touching` (expected: no conflict), `duplicate_of_mo5`, `crosses_county`, `swapped_axes`, `self_intersecting`, `valid_parcel_4326`, and `valid_parcel_utm29n` (import with EPSG:32629). PROV-MO-000007 is seeded as disputed, so transfers of it are blocked.

**Subdivision:** as gis.mo, open a *Subdivision* of PROV-MO-000008 and import `subdivide_mo8_halves_4326.geojson`. Then, as proc.mo, use *Copy current ownership to each new parcel*. `subdivide_mo8_gap_4326` and `subdivide_mo8_overlap_4326` show the coverage and overlap errors. After publishing, `consolidate_mo8_halves_4326` merges the two halves back together.

**Correction:** as gis.mo, open a *Correction* of PROV-MO-000003, change the land use, import `correct_mo3_minor_4326.geojson`, and add a survey plan. Or import `correct_mo3_major_4326` to see the large-change warning.

**Legacy migration:** as gis.mo, open a *Legacy migration* and import `legacy_register_problems_mo_4326.geojson`. Submit it to see the per-feature faults, exclude the faulty features, resubmit, and download the reconciliation report. `legacy_register_mo_4326.geojson` is a clean batch of 10. Afterwards, open a migrated parcel as proc.mo and use *Confirm these interests* to register a verified holder.

**Document request:** documents can be released only from published cases, and seeded parcels have none. So first publish a transfer of, for example, PROV-MO-000010 to *Musu Testperson*, with a verified deed. Then sign in as owner.demo → *My land* → *Request documents*. proc.mo prepares the release under *Document requests*, reg.mo decides, and owner.demo downloads the copy.

**GIS officer:** sign in as gis.mo, which opens the *GIS Officer Dashboard*. Then:
1. Open a *Legacy migration* case under Cases.
2. In the *Data Import Center*, upload `server/fixtures/gis/synthetic_parcels_noprj_shp.zip`.
   - The wizard reports that the CRS is unknown and will not continue until you declare EPSG:4326, say how you know it, and confirm.
   - Map `legacy_ref` to `PARCEL_NO` and `land_category` to `CATEGORY`, preview, and confirm.
   - The job stages version 1. Its diagnostic and error report are under *Processing Jobs*.
3. Correct an attribute under *Versions & Compare* to create version 2, and compare the two on the map.
4. *Submit to Supervisor* refuses blocking errors. Try a registration case importing `crosses_county_4326.geojson`.
5. Under *ArcMap Sync*, create a token and follow [docs/arcmap-integration.md](docs/arcmap-integration.md) to sync from ArcMap 10.x. `synthetic_parcels_4326_shp.zip`, `synthetic_parcels_utm29n_shp.zip` and `synthetic_parcels_wkt_4326.csv` are the other samples, all produced with ArcPy.
6. As admin, *Validation Rules* changes a configurable rule's severity; each change is a new rule-set version.

## Known limits of this prototype

- One parcel per registration case. Bulk import exists only for legacy migration, where holders are documented rather than registered. Documented interests become registered through a confirmation case.
- Migration creates a new unverified party for every holder name; it never matches names to existing parties automatically, so de-duplicating parties is a manual follow-up. Subdivision accepts up to 50 new parcels per case.
- Subdivision and consolidation give every resulting parcel the same land category and use, set on the case.
- No malware scanning of uploads (the hook point is marked in `routes/cases.ts`) and no e-mail or SMS notifications; landowners check request status in the portal.
- Released documents are the stored files themselves; there is no certified-copy watermarking or fee handling.
- Conflict tolerances (`OVERLAP_TOLERANCE_M2`, `DUPLICATE_HAUSDORFF_M`, `MIN_PARCEL_AREA_M2`, `COVERAGE_TOLERANCE_M2`) and the public field list (`PUBLIC_PARCEL_FIELDS`) are placeholders until the cadastral authority and the disclosure policy define them.
- The audit chain resists tampering by application users, but a database superuser can still alter it. For higher assurance, run `server/db/roles.sql` so the app uses a least-privilege role, and ship events to a separate log store.
- Map tiles come from OpenStreetMap's public servers, so the browser fetches them from the internet. The GIS workspace map offers a *No basemap* option for offline use.
- File geodatabases and GeoPackages cannot be uploaded directly; there is no GDAL or FileGDB adapter on the server. Use the ArcMap adapter, or export as shapefile or GeoJSON. GIS jobs run in the API process rather than a separate worker. The ArcMap adapter was tested with ArcPy 10.7 from scripts, not through the toolbox dialog in ArcMap's interface.
- Not security-audited, load-tested or usability-tested; those are Phase 7 evaluation activities. HTTPS, scheduled off-host backups and secret management belong to the deployment environment. Docker Compose files are provided but unverified. What is implemented, partial or unverified is listed in [docs/status.md](docs/status.md).
