# Architecture

LAIS-Liberia is a research prototype of a land administration information system. It runs on synthetic data only.

```
 Browser (React SPA)                       API (Express, TypeScript)                 PostgreSQL + PostGIS
 ─────────────────────                     ─────────────────────────                 ────────────────────
 Public map ──────────── /api/public ───▶  public router (fixed field list) ──┐
 Landowner portal ────── /api/me ───────▶  ┐                                  │      lais     records, parcels, RRR,
 Staff shell ─────────── /api/cases ... ─▶ ├ session + CSRF ─▶ authorize() ───┼────▶ staging  imports, validation
 Admin dashboard ─────── /api/admin ────▶  ┘   (policy.ts)      + county scope│      audit    hash-chained events
                                                                              │
                          /api/openapi.json ◀── generated from the routers    └────▶ storage/  documents, backups
```

## Front end (`web/`)

- React 18, TypeScript and Vite. Routing uses React Router; server state uses TanStack Query; forms use React Hook Form with Zod.
- Maps use Leaflet, charts use Recharts, and icons come from lucide-react.
- **Styling** is plain CSS with custom properties (`web/src/styles.css`, `web/src/shell/shell.css`) instead of Tailwind. It gives light and dark themes, responsive layouts and visible focus states without another build step.
- **Staff shell** (`web/src/shell/AppShell.tsx`):
  - a sidebar built from the capabilities the server reports for the session;
  - breadcrumbs, global search, the notification centre, a scope indicator, the theme toggle and the profile menu;
  - a drawer menu on phones.
- **Pages are lazy-loaded.** The administrator pages are in `web/src/pages/admin/`; shared UI pieces are in `web/src/components/kit.tsx` (drawer, modal, reason dialog, table, pagination, toasts and query states).
- The interface only hides what a user can't do. Every permission is enforced again by the API.

## API (`server/`)

- Express 5, TypeScript and Zod. Each handler validates its input with a Zod schema; anything else gets a 400 with a list of fields.
- **Sessions are server-side.** The browser holds an opaque token in an HttpOnly, SameSite=Strict cookie; the database stores only its SHA-256 hash. Every state-changing request needs the `X-CSRF-Token` header.
- **MFA:** TOTP, with the secrets encrypted at rest. It can be made compulsory for privileged roles with `MFA_ENFORCED`.
- **Authorization** (`server/src/authz/policy.ts`) is defined in code as a single rule table:
  - roles, county scope, allowed case statuses, allowed case types, and separation of duties;
  - `enforce()` throws a 403 and writes an audit record of the denial;
  - the same table drives `GET /api/admin/permissions`, the Roles & Permissions page and [permission-matrix.md](permission-matrix.md).
- **Workflow:** case statuses change only through the transitions that the `lais.enforce_case_transition` trigger allows. The TypeScript transition table is tested against the trigger.
- **Publication:**
  - publishing runs in one transaction under a per-county advisory lock, so two overlapping parcels can't both be published;
  - each approved case carries a snapshot hash, which must still match at publication;
  - published parcel versions and rights are protected by triggers (no in-place edits).
- **Audit** (`audit.event`):
  - append-only; triggers forbid updates and deletes;
  - each event is hash-chained to the previous one, and `audit.verify_chain()` detects tampering;
  - every event carries the request's correlation ID (`X-Request-Id`) in its detail.
- **Logging** (`server/src/logger.ts`): one JSON line per request (method, path, status, duration, username and request ID), plus errors with stack traces. Passwords, tokens and request bodies are never logged.
- **Notifications** are in-app only (`lais.notification`). There is no email: activation links are shown once to the administrator, who passes them on.
- **Backups:** the API runs `pg_dump` in custom format, records each run in `lais.backup_run`, and can verify a backup by restoring it ([backup-restore.md](backup-restore.md)).

## Roles

- **System administrator:** accounts, roles, counties, settings, document categories, backups, reports and system health. The role carries no land-record authority.
- **Supervisor:** national read-only oversight, with a read-only view of accounts.
- **GIS officer:** county-scoped. Imports geometry into staging and runs validation.
- **LAIS processor:** county-scoped. Records rights and documents, and verifies documents uploaded by colleagues.
- **Land registrar:** county-scoped. Takes the legal decision (approve, return or reject) and publishes. Never on a case they helped prepare.
- **Auditor:** reads the full audit trail and verifies the chain.
- **Landowner:** sees their own linked parcels and requests copies of documents.

Surveyors have no accounts: survey data reaches LAIS through a GIS officer's import.

A role-combination check refuses to give one account both administration and operational roles (GIS officer, processor or registrar). Administrators cannot change their own roles or status, and the last active administrator cannot be removed.

## Data

See [database-schema.md](database-schema.md). Three schemas:
- `lais`: authoritative records and administration;
- `staging`: imported, unpublished geometry and validation runs;
- `audit`: the trail.

## Tests

- **Unit tests** (`server/test/unit`): the policy, the workflow, helpers, and the permission document.
- **Integration tests** (`server/test/integration`): every route family, run against a real PostgreSQL + PostGIS database.
- **Browser walkthroughs** (`e2e/`): the major flows, scripted with Playwright against the running stack in Microsoft Edge. Run them with `npm run e2e`.

The current results are in [status.md](status.md).
