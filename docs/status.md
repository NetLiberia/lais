# Implementation status

As of 27 October 2026. "Verified" means it was exercised by automated tests, browser walkthroughs or a recorded manual run on PostgreSQL 18.6 with PostGIS 3.6.2 on Windows 11.

## Test results

| Suite | Result |
|---|---|
| `npm test`: unit tests (policy, workflow, helpers, CSV safety, permission document) | 44 passed |
| `npm test`: integration tests against a real PostgreSQL + PostGIS database | 93 passed |
| `npm test`: web component tests (shared dialogs and tables, permission-aware navigation, account creation) in jsdom | 18 passed |
| `npm run lint` (ESLint with typescript-eslint and the React hooks rules) | 0 errors, 0 warnings. `any` is an error outside test files |
| `npm run e2e`: browser walkthroughs in Microsoft Edge (7 scripts) | 81 steps passed, 0 problems |
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
- System Health from live checks: database, PostGIS, API, GIS queue, storage, latest backup, security events and audit-chain integrity. Background jobs are honestly reported as *unknown*.
- Allow-listed settings, including the portal banner shown to staff.
- Document categories: add, and activate or deactivate. System categories are protected. The case upload form lists the active categories, so new ones are offered to staff at once.
- Backups: `pg_dump` from the interface, recorded with SHA-256, and a restore check.
- Reports as CSV: staff accounts, land applications (metadata only), GIS import jobs and county configuration. Each export is audited.

**Platform**
- In-app notifications: account events, validation returns, decisions and account lockouts.
- Structured JSON request logs, and a correlation ID (`X-Request-Id`) in every audit event and in 500 responses.
- OpenAPI 3.1 at `GET /api/openapi.json`, generated from the mounted routers. A test checks that every route has a summary.
- Sign-in rate limit per account (failed attempts only) plus a per-address ceiling.
- All the earlier land-administration features (see the README), unchanged and still covered by their tests and walkthroughs.

## Partial

| Item | What is missing |
|---|---|
| OpenAPI | Operations, parameters, security and error responses are described. Request and response bodies are not described field by field; they are enforced by Zod schemas in the code. |
| Front-end component tests | Cover the shared kit, the shell navigation and user management. The other pages rely on the browser walkthroughs. |
| Styling | Plain CSS with design tokens rather than Tailwind (documented in [architecture.md](architecture.md)). |
| Backups | On demand only. No schedule, no off-host copy, no encryption at rest. Document files are not included. |
| MFA | Available for every account; compulsory for privileged roles only when `MFA_ENFORCED=true`. |
| Notifications | In-app only. No email or SMS, so activation links are passed on by the administrator. |

## Not implemented

| Item | Notes |
|---|---|
| Live ArcMap / ArcGIS integration | Data enters as GeoJSON files through staging. See [gis-sync.md](gis-sync.md). |
| Background job queue | Imports and validation run during the request. |
| Row-level security | Designed in [security.md](security.md#row-level-security). |
| Verified county boundaries | No official boundaries are loaded. Only the two synthetic pilot counties are enabled. |
| Upload virus scanning | |

## Unverified

| Item | Why |
|---|---|
| Docker Compose (`docker-compose.yml`, `Dockerfile`, `deploy/nginx.conf`) | No Docker on the development machine; never built or run. |
| `server/db/roles.sql` with migration 009 | Needs a superuser run, which wasn't done for this phase. |
| Production mode | Needs HTTPS termination and a hosting environment. |
| Performance at national scale | Not load-tested. |
| Browsers other than Edge | The walkthroughs drive Microsoft Edge (Chromium) only. |
