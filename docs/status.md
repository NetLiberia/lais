# Implementation status

As of 28 October 2026. "Verified" means it was exercised by automated tests, browser walkthroughs or a recorded manual run on PostgreSQL 18.6 with PostGIS 3.6.2 on Windows 11.

## Test results

| Suite | Result |
|---|---|
| `npm test`: unit tests (policy, workflow, helpers, CSV safety, permission document) | 44 passed |
| `npm test`: integration tests against a real PostgreSQL + PostGIS database, including 17 for supervision and 33 for the GIS workspace and ArcMap sync (`gis.test.ts`) | 143 passed |
| `npm test`: web component tests (shared dialogs and tables, permission-aware navigation, account creation, URL filters, supervisor dashboard empty and error states, return dialog, task moves, GIS dashboard, import CRS gating, submission blocking, one-time token display, UTM readout) in jsdom | 31 passed |
| `npm run lint` (ESLint with typescript-eslint and the React hooks rules) | 0 errors, 0 warnings. `any` is an error outside test files |
| `npm run e2e`: browser walkthroughs in Microsoft Edge (9 scripts, including the supervisor and GIS officer journeys) | 113 steps passed, 0 problems |
| ArcMap adapter with ArcPy 10.7 (ArcGIS Desktop 10.7.1) | Toolbox and CLI run against the live API; see [arcmap-integration.md](arcmap-integration.md#6-what-was-tested-and-how) |
| `npm run backup:verify` on a backup taken through the interface | Restored and verified (see [backup-restore.md](backup-restore.md)) |
| `npm run typecheck`, `npm run build` | Clean |

## Implemented and verified

**Administrator dashboard**
- Eight summary cards, each opening a filtered view, with loading, empty and error states.
- Six charts computed from the database, each with date and county filters, tooltips, a data-table view and click-through: applications by status, applications over time, parcels by county, GIS import outcomes, conflicts by review status, and staff sign-ins.
- A recent-activity feed and a system-health summary.

**Staff shell**
- A sidebar built from the session's capabilities, breadcrumbs, global search, the notification centre with an unread count, and a scope indicator.
- A profile menu, a light/dark theme that persists, and a help page.
- On phones, a drawer menu with no horizontal page scroll.

**User management**
- Search, filters, sorting, paging, page size and clear filters.
- Export of all staff accounts as CSV: no landowners, no secrets, formula-safe cells, and audited.
- Accounts are created as *invited* and activated through a one-time link. Password resets also use one-time links.
- Suspend, deactivate and reactivate, with a reason.
- Role grants and revocations, including county.
- Last-administrator and self-change protection.
- A detail drawer with recent activity and no secrets.

**Roles & Permissions**
- A read-only matrix served from the enforced policy.
- [permission-matrix.md](permission-matrix.md) is generated from the same policy, and a test fails when it drifts.

**County management**
- All 15 counties. 13 are unconfigured (no invented boundaries); Montserrado and Margibi have labelled synthetic boundaries.
- Provisional boundary import, verification that records provenance, and enable/disable with a reason.
- A case can be opened only in an enabled county.

**Overviews and monitoring**
- Read-only overviews of applications, parcels and spatial conflicts.
- GIS Synchronization monitoring of staging batches and their findings: read-only, with no retry that bypasses validation.

**System pages**
- Audit & Security Logs, with the administrator's technical scope, filters, cursor paging and event detail.
- System Health from live checks: database, PostGIS, API, GIS queue, storage, latest backup, security events and audit-chain integrity. Background jobs report GIS job activity, stuck jobs and recent failures from the job table.
- Allow-listed settings, including the portal banner shown to staff.
- Document categories: add, and activate or deactivate. System categories are protected. The case upload form lists the active categories, so new ones are offered to staff at once.
- Backups: `pg_dump` from the interface, recorded with SHA-256, and a restore check. A failed backup leaves no partial file.
- Least-privilege database login (`server/db/roles.sql`, `lais_app`): verified by running the API as `lais_app` through the administrator, registration and supervisor walkthroughs, backup included.
- An "Escalations for administration" card on the admin dashboard counts open escalations routed to system administration.
- Reports as CSV: staff accounts, land applications (metadata only), GIS import jobs and county configuration. Each export is audited.

**Platform**
- In-app notifications: account events, validation returns, decisions and account lockouts.
- Structured JSON request logs, and a correlation ID (`X-Request-Id`) in every audit event and in 500 responses.
- OpenAPI 3.1 at `GET /api/openapi.json`, generated from the mounted routers:
  - request bodies, upload fields and query parameters come from the same Zod schemas the handlers validate with (38 operations with a body, 13 with query parameters);
  - a test checks that every route has a summary, that every write route has a documented body or is marked as taking none, and that the document passes an OpenAPI 3.1 schema validator.
- Sign-in rate limit per account (failed attempts only) plus a per-address ceiling.
- All the earlier land-administration features (see the README), unchanged and still covered by their tests and walkthroughs.

## Supervisor phase (Prompt 2)

### Implemented and verified

**Scope and permissions**
- Supervisors can be assigned nationally or to one county. A new `national` rule scope keeps national data (admin dashboard, all users, full audit trail, admin reports) away from county supervisors.
- A county the client asks for is checked against the grants, and refusals are audited. The top-bar scope selector only narrows the view.
- A county supervisor's audit view is limited to their county.

**Dashboard**
- Ten KPI cards with click-through to filtered pages. Rates and averages show "—" with an explanation when nothing was measured.
- Six charts from live queries: stages, work completed, GIS quality, processing time by stage, staff workload, conflict status.
- Refresh, date range, last-updated time.

**Application work queue**
- Search, stage, type, priority, assignee (when a county is chosen), date range, overdue only, sorting, paging, clear filters.
- Audited CSV export; row selection with bulk priority and due date.
- Detail drawer: supervision panel, GIS status, documents (only those the role may download), workflow history.

**GIS quality review**
- Queue with record counts, validation and review status.
- Detail page:
  - submission metadata, source and target CRS, SHA-256;
  - validation results grouped as geometry, spatial conflicts, boundary, identifiers, attributes, completeness;
  - record table and record inspector (personal attributes hidden);
  - correction history and case notes.
- Review map: working data drawn distinctly from published parcels, overlap areas, county boundary, layer control, legend, zoom to record, fit to submission.
- Accept, return for correction (categories, affected records, findings, instructions, correction task to the responsible officer), request information (tracked as a task).
- Optional admin setting that makes acceptance required before a registrar can approve.

**Spatial conflict review**
- Table-driven categories and rules with version.
- Derived review status (new, investigating, awaiting correction, escalated, resolved, closed) followed across re-validations.
- Evidence map with the measured geodesic intersection.
- Notes, investigation or GIS-check tasks, return, escalate. There is no resolve or dismiss.

**Tasks**
- Nine task types with eligible roles; eligibility is checked against role, county and account status.
- Create, assign, reassign with reason, priority and due date, comments with references, follow-ups, complete with note, return, cancel with reason.
- Table and Kanban board. Board moves are checked by the server; the database enforces transitions and forbids deletion.
- "My tasks" for GIS officers and processors.

**Staff workload, overdue work and bottlenecks**
- Workload per officer, explicitly not a ranking, with current assignments and reassignment.
- Overdue tasks and applications, with follow-up, follow-up task, reassignment and escalation.
- Bottlenecks from case history. They are labelled informational while no stage targets are configured; targets are an admin setting, not a statutory deadline.

**Reports**
- 12 reports with filters (county, period, stage, task type, role).
- Each carries an id, generation time, scope, filters, a synthetic-data notice and column kinds (count, value, derived).
- JSON preview, CSV with a metadata header, and print / save as PDF from the browser. Every generation is audited.
- A Quality & Compliance page groups the compliance reports.

**Escalations**
- Eight categories routed to a default responsible role.
- Acknowledge, assign (picker of eligible holders), investigate (optional task), escalate further, comment, close. The closure policy requires acknowledgement, the responsible role, finished linked tasks and a 10-character reason.
- History is append-only; facts are not editable.

**Notifications and activity**
- Notification page with category and unread filters, mark read, mark all read, and links to records.
- In-app notifications for returns, information requests, new and changed tasks, escalations and acceptances.
- Activity history of supervisory actions from the audit trail.

### Partial or not implemented

| Item | Notes |
|---|---|
| Separate document-review and GIS-processing stages | The case workflow has no such states. Both are shown as "Draft / in preparation" (see [workflow.md](workflow.md)). |
| Request and response tracking for information requests | Tracked as a task: the request is the task, the response is its completion note. There is no separate thread. |
| Workload by leave or complexity | Not recorded, so the workload view states that raw counts are not a performance measure. |
| PDF export | Supervision reports print from the browser. GIS reports have server-generated PDF. |
| Stale-version detection as a conflict category | No validation rule flags it. A changed record is caught at publication by the decision snapshot, which returns the case for review. |

## GIS officer phase (Prompt 3)

Full record: [prompt3-completion-report.md](prompt3-completion-report.md).

### Implemented and verified

- **Dashboard and tasks**
  - The dashboard has 12 KPI cards with click-through.
  - My GIS Tasks: acknowledge, claim, ask for clarification, begin, block, note and complete. Preparation tasks complete only after the case is submitted.
- **Parcel Workspace map**
  - Layers: approved reference parcels, working staging, submitted staging, invalid geometry as received, overlap areas, duplicate identifiers and county boundary.
  - OpenStreetMap or no basemap, a scale bar, WGS 84 and UTM 29N coordinates, a legend and search.
- **Data Import Center** (8 steps)
  - Formats: GeoJSON, zipped shapefile, CSV with WKT and ArcMap packages. File geodatabase and GeoPackage are explained as unsupported.
  - An unknown CRS requires a declaration, a recorded reason and confirmation.
- **Processing jobs**
  - Statuses: queued, running, completed, completed with warnings, failed, cancelled.
  - Atomic staging, restart recovery, duplicate-source detection, retry as a linked job, a diagnostic and a CSV error report.
- **ArcMap 10.x adapter**
  - A toolbox and a command line: polygon, CRS and field checks; manifest; deterministic export ID; idempotent upload.
  - Personal, hash-stored, revocable tokens valid only for the sync endpoints.
  - A sync page with the observed status and a diagnostic.
- **Versions**
  - Every import, sync and correction is a numbered version; submitted versions are frozen by a trigger.
  - Feature-by-feature comparison with a map overlay; attribute corrections create new versions.
- **Validation Center**
  - Filters, zoom, CSV, re-run.
  - Rule severities are administrator-configurable, with versioned history; each run records the rule-set version and the boundary status.
  - New rules: multipart, unusually large area, duplicate source ID.
- **Submission**
  - A checklist; blocking errors are refused with no exception route; warnings acknowledged; resubmissions explained.
  - The snapshot hash is linked to the previous submission, with a derived status and an integrity check.
- **Returned submissions, conflict investigation (notes, re-run, findings; no resolve), and GIS reports** as JSON, CSV and server-side PDF.
- **System Health** now reports GIS job activity, stuck jobs and failures, instead of *unknown*.

### Partial or not implemented

| Item | Notes |
|---|---|
| File geodatabase / GeoPackage upload | No GDAL or FileGDB adapter on the server; use the ArcMap adapter or a shapefile/GeoJSON export. |
| Dedicated job worker | Jobs run asynchronously in the API process. |
| ArcMap toolbox run from the ArcMap interface | Run through `arcpy.ImportToolbox` and the CLI with ArcPy 10.7; not by hand in the ArcMap interface. ArcGIS Pro not tested. |
| Remote HTTPS sync | Tested against the local API over `http://localhost`. |

## Partial

| Item | What is missing |
|---|---|
| OpenAPI responses | Requests are described field by field; responses only in outline (status codes and errors). Their TypeScript shapes are in `web/src/types.ts`. |
| Front-end component tests | Cover the shared kit, the shell navigation and user management. The other pages rely on the browser walkthroughs. |
| Styling | Plain CSS with design tokens rather than Tailwind (documented in [architecture.md](architecture.md)). |
| Backups | On demand only. No schedule, no off-host copy, no encryption at rest. Document files are not included. |
| MFA | Available for every account; compulsory for privileged roles only when `MFA_ENFORCED=true`. |
| Notifications | In-app only. No email or SMS, so activation links are passed on by the administrator. |

## Not implemented

| Item | Notes |
|---|---|
| Live ArcSDE / ArcGIS Server connection | Not provided by design: ArcMap pushes packages through the adapter ([arcmap-integration.md](arcmap-integration.md)). |
| Separate background job worker | GIS jobs run asynchronously in the API process; validation runs during the request. |
| Row-level security | Designed in [security.md](security.md#row-level-security). |
| Verified county boundaries | No official boundaries are loaded. Only the two synthetic pilot counties are enabled. |
| Upload virus scanning | |

## Unverified

| Item | Why |
|---|---|
| Docker Compose (`docker-compose.yml`, `Dockerfile`, `deploy/nginx.conf`) | No Docker on the development machine; never built or run. |
| Production mode | Needs HTTPS termination and a hosting environment. |
| Performance at national scale | Not load-tested. |
| Browsers other than Edge | The walkthroughs drive Microsoft Edge (Chromium) only. |
