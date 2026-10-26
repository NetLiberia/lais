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
| GIS staging: GeoJSON from ArcGIS Pro / QGIS with a **declared** CRS (EPSG:4326 or 32629), stored as received, never auto-repaired | `routes/cases.ts` (`/geometry`), `002_staging.sql` |
| Validation and conflict detection: invalid / self-intersecting, swapped axes, wrong CRS, outside county, crosses county boundary, overlaps with published parcels, suspected duplicates, competing open submissions, duplicate UPIs | `services/validation.ts` |
| Conflicts are **warnings**: the registrar must acknowledge each one with a note before approving. The system never decides a dispute | `routes/cases.ts` |
| Decision snapshot: approval records a hash of exactly what was reviewed; publication refuses and reopens the case if anything changed | `services/snapshot.ts`, `services/publication.ts` |
| Atomic publication (single transaction, serialised per county) with full rollback on failure | `services/publication.ts` |
| Transfers end old interests and register new ones; history is immutable (triggers block edits and deletes) | `publication.ts`, `001_core.sql` |
| Subdivision (one parcel into 2–50) and consolidation (2+ parcels into one): new parcels must not overlap each other and must cover the source area exactly; rights are recorded per new parcel; sources are retired, never deleted, and parent→child lineage is kept. Retired identifiers on the public portal point to their replacements | `services/validation.ts` (`reshapeChecks`), `services/publication.ts` (`publishReshape`), `004_reshaping.sql` |
| Disputes: recorded by registrars, block transfers, closed with a recorded outcome | `routes/parcels.ts` |
| Protected documents: content-type sniffing, private storage, SHA-256 integrity check on every read, classification-based access, all downloads audited | `routes/cases.ts`, `routes/documents.ts` |
| Authentication: scrypt hashes, progressive lockout, server-side sessions (hash-only token storage), CSRF tokens, optional mandatory TOTP MFA for privileged roles | `server/src/auth/*`, `routes/auth.ts` |
| Append-only, hash-chained audit log with tamper detection | `003_audit.sql`, `routes/audit.ts` |
| Landowner portal: only interests registered to parties linked to the account by staff | `routes/me.ts`, `pages/MyParcels.tsx` |

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
```

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

### 2. Configure

```bash
copy server\.env.example server\.env
```

Edit `server/.env`:
- `DATABASE_URL=postgres://lais_owner:choose-a-password@localhost:5432/lais`
- `MFA_ENCRYPTION_KEY`: generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SEED_PASSWORD`: at least 12 characters; every demo account gets this password
- `TEST_DATABASE_URL=postgres://lais_owner:choose-a-password@localhost:5432/lais_test` (optional)

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

- **36 unit tests**: permission matrix, cross-county denial, separation of duties, workflow (including a check that the TypeScript transition table matches the SQL trigger), TOTP RFC test vectors, password hashing, GeoJSON/CRS intake, fractional shares, file sniffing.
- **40 integration tests**: run against `TEST_DATABASE_URL` and skipped when it is unset. They cover public-API privacy, CSRF, the full registration, transfer, subdivision and consolidation lifecycles, cross-county attempts by direct API call, all geometry fixtures in `server/fixtures/`, failed-publication rollback, SQL-level workflow and history guards, audit immutability and tamper detection, document access by classification, and admin limits.

## Demo accounts (synthetic)

All use `SEED_PASSWORD`.

| Username | Role | Scope |
|---|---|---|
| `admin` | System administrator (accounts only, no land decisions) | national |
| `gis.mo`, `gis.mg` | GIS officer | Montserrado / Margibi |
| `proc.mo`, `proc2.mo`, `proc.mg` | LAIS processor | Montserrado / Margibi |
| `reg.mo`, `reg.mg` | Land registrar | Montserrado / Margibi |
| `supervisor` | Supervisor (read-only oversight) | national |
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

## Known limits of this prototype

- One parcel per registration case; multi-parcel batch import of new registrations is a later phase. Subdivision accepts up to 50 new parcels per case.
- Subdivision and consolidation give every resulting parcel the same land category and use, set on the case.
- No malware scanning of uploads (the hook point is marked in `routes/cases.ts`), no e-mail or SMS notifications, no document-request workflow for landowners.
- Conflict tolerances (`OVERLAP_TOLERANCE_M2`, `DUPLICATE_HAUSDORFF_M`, `MIN_PARCEL_AREA_M2`, `COVERAGE_TOLERANCE_M2`) and the public field list (`PUBLIC_PARCEL_FIELDS`) are placeholders until the cadastral authority and the disclosure policy define them.
- The audit chain resists tampering by application users, but a database superuser can still alter it. For higher assurance, run `server/db/roles.sql` so the app uses a least-privilege role, and ship events to a separate log store.
- Map tiles come from OpenStreetMap's public servers, so the browser fetches them from the internet.
- Not security-audited, load-tested or usability-tested; those are Phase 7 evaluation activities. HTTPS, backups and secret management belong to the deployment environment.
