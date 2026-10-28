# Security and privacy

## Limits on the administrator

These limits are enforced by the API; the interface only reflects them. Integration tests check each one.

| The administrator cannot | How it is enforced |
|---|---|
| Approve, return or reject a case, or publish one | No administrator role in the `case.decide` and `case.publish` rules (see [permission-matrix.md](permission-matrix.md)). |
| Edit authoritative geometry or rights | No `case.*` preparation rights. Published versions are also protected by triggers. |
| Act outside a registrar's county restrictions | County scope is checked against the grants of the person acting. An administrator cannot hold registrar or other operational roles, because the role-combination check refuses it. |
| Change their own roles or status | `notSelf` checks on role grants, revocations and status changes. |
| Remove the last active administrator | `assertNotLastAdmin` runs inside the same transaction as the change. |
| Read or change land-record content in the audit trail | The administrator's audit scope is technical: security, system and administration events, plus case status changes stripped of their detail. |
| Delete or edit audit events, or switch auditing off | `audit.forbid_change` trigger. No setting disables auditing. |
| Open private documents | Document access is not granted to the administrator role. Every download is audited. |
| See passwords or secrets | Accounts are created as *invited*, and the person sets their own password through a one-time link. Hashes, tokens and MFA secrets are never returned by any endpoint. |
| Make a surveyor account | No surveyor role exists. Role names are validated against a fixed list. |

Privileged changes (account status, roles, profile, settings, county enablement and boundaries, document categories, backups) all require a written reason. The reason is stored in the audit event.

## Limits on the supervisor

Supervisors can be assigned to one county or nationally. Integration tests check each of these limits.

| The supervisor cannot | How it is enforced |
|---|---|
| Approve, reject or publish a case | No supervisor role in `case.decide` and `case.publish`. Quality acceptance is a separate record (`supervisory_review`) with no legal effect; when the administrator requires it, it is an extra precondition on the registrar, never a substitute. |
| Override a registrar's decision | No route changes a decided case. A supervisor's return is only possible while a case is `under_review`. |
| Change ownership records or authoritative geometry | No `case.edit_rights`, `case.import_geometry` or publication rights. Published versions and rights are protected by triggers. |
| See or act on another county | `supervision.*`, `task.*`, `escalation.*` and `conflict.review` are county-scoped. A county the client asks for is checked against the supervisor's own grants, and a refusal is audited. National views (admin dashboard, all users, full audit trail, admin reports) need a **national** grant: a county supervisor sees only their county's audit events. |
| Widen their own scope or give themselves Administrator or Registrar rights | No `roles.assign`. The scope selector only narrows a query; the server ignores counties outside the grants. |
| Resolve, dismiss or erase a spatial conflict | There is no such action. A conflict is resolved only by a registrar's acknowledgement, or by corrected data that no longer triggers the rule. Findings and review events are append-only. |
| Bypass validation | Acceptance is refused while the latest validation has blocking errors or does not cover the current geometry. A return keeps the submission and its results. |
| Delete tasks, reviews, escalations or audit history | Database triggers refuse UPDATE and DELETE on the history tables and on `audit.event`, and refuse deleting tasks and escalations. Cancellation and closure each need a reason. |
| Give a task's assignee extra powers | A task is a work item. Assignment is limited to active staff with an eligible role in the task's county. |

The record inspector in GIS review leaves out imported attributes whose names suggest personal data (names, holders, contacts, identity numbers). The work queue shows a count of proposed holders, never their names.

## Limits on the GIS officer

GIS officers prepare spatial data in staging, in their own counties. Integration tests (`server/test/integration/gis.test.ts`) check each limit.

| The GIS officer cannot | How it is enforced |
|---|---|
| Approve, reject or publish | No GIS role in `case.decide` or `case.publish`. Submission (`case.submit`) only starts review. |
| Change ownership | No `case.edit_rights`. Attribute corrections change staging features only, never rights or published parcels. |
| Delete or rewrite a version | No route deletes a version: imports, syncs and corrections always add one. A trigger freezes the features of a submitted version, and submissions are append-only. |
| Submit with blocking errors | `POST /gis/cases/{id}/submit` re-validates and refuses with 409. No exception policy exists. |
| Weaken validation | Rule severities are changed only by administrators (`validation.configure`). Safety rules are fixed by a database CHECK, and every change is versioned and audited. |
| Resolve, dismiss or delete a conflict | Investigation adds notes, re-runs checks (only while the case is editable) and submits findings. Review events are append-only. |
| Work in another county | `gis.workspace`, `case.import_geometry`, `conflict.investigate` and `gis.reports` are county-scoped, and jobs, layers and submissions are filtered by grant. An upload can be used only by the officer who sent it. |
| Alter audit history | `audit.event` is append-only and hash-chained. |

## GIS data and the ArcMap adapter

- **Uploads are untrusted input.**
  - Files are read in memory, archive member names are checked, and only an allow-list of extensions is accepted.
  - Sizes, entries and features are limited.
  - Nothing in an upload is executed: no scripts, macros or tools.
  - Attribute values are kept as scalar text or numbers, limited to 100 per feature, and shown escaped in the interface.
  - WKT is parsed by PostGIS in a parameterised query.
  - Uploads are stored under random names outside the web root and deleted after the retention period.
- **No silent CRS assignment.** Unknown CRS means the officer must declare it, give a reason (stored with the job) and confirm. The adapter refuses layers with no or unsupported CRS.
- **Sync tokens instead of database credentials.** The ArcMap adapter has no database address, user or password; it holds only a personal LAIS token:
  - the token is random (256 bits) and stored only as a SHA-256 hash;
  - it is shown once and identified afterwards by its last four characters;
  - it expires after 7 to 90 days, and there are at most 5 per officer;
  - it can be revoked at any time.
- **What a token can do.**
  - It is accepted **only** by `/api/gis/arcmap/*`. Other endpoints ignore it, and it never creates a session.
  - Each request loads the account's **current** GIS officer grants and nothing else, so a token cannot carry another role the account may hold.
  - A suspended account or a revoked role stops the token at once.
  - The endpoints take no cookies, so CSRF does not apply, and they are rate-limited.
- **No secrets in logs.**
  - The adapter's log shows only the token's last four characters.
  - Server logs and audit details record job numbers, file names, hashes and counts, never tokens or file contents.
  - Unexpected job errors are logged server-side and summarised to the officer without internal detail.
- **Do not expose PostgreSQL.** Workstations need HTTPS access to the LAIS web server only. PostgreSQL should listen on the application host or a private network, with `pg_hba.conf` limited to the API host. Nothing in the GIS design needs a direct database connection.

## Authentication

- Passwords are hashed with scrypt (N=2^15, r=8, p=1, random salt). An account locks after 5 failed attempts.
- Sign-in attempts are rate-limited:
  - per account: 10 failed attempts per 15 minutes; successful sign-ins don't count;
  - per address: 300 per 15 minutes.
- Unknown users, wrong passwords, locked accounts and invited accounts all get the same answer.
- Sessions are server-side and stored as SHA-256 hashes. They expire after an idle period and an absolute limit. Suspending an account, or resetting its password, revokes its sessions.
- Activation and reset links are single-use, stored as hashes and expire. Issuing a new link revokes earlier ones.
- TOTP MFA is available for every account. Setting `MFA_ENFORCED=true` makes it compulsory for privileged roles.
- Every state-changing request needs the CSRF token header. The session cookie is HttpOnly and SameSite=Strict, and also Secure in production mode.

## Logging and privacy

- Request logs record the method, path, status, duration, username and request ID. Bodies, passwords and tokens are never logged.
- Error responses for unexpected failures show only a request ID; the detail goes to the server log.
- The public portal serves a fixed list of public fields; owners and rights are not public. Party national ID references are masked unless revealed through an audited request.
- The staff accounts report excludes landowner accounts.
- All seed data is synthetic and labelled as such (`is_synthetic`, the "(synthetic)" suffix on names, `example.invalid` email addresses).

## Database roles

By default the API connects as `lais_owner`, the role that owns the schemas and runs migrations.

`server/db/roles.sql` is an optional hardening script, run by a superuser after migrating. It creates a separate runtime login, `lais_app`, which:

- cannot change table structure or disable triggers;
- cannot UPDATE or DELETE audit events or published history;
- has read-only access to the migration history and sequence values, so that administrator backups still work.

Grants apply to the tables that exist when the script runs, so **re-run it after every migration or database rebuild**. It is safe to re-run: an existing `lais_app` keeps its password.

```powershell
$env:PGPASSWORD = '<postgres password>'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -U postgres -d lais -v ON_ERROR_STOP=1 -v app_password="'<new lais_app password>'" -f server\db\roles.sql
$env:PGPASSWORD = $null
```

Then set `DATABASE_URL=postgres://lais_app:<password>@localhost:5432/lais` in `server/.env` and restart the API. Keep `lais_owner` for migrations: `npm run db:migrate` must run as the owner.

**Verified on 27 October 2026** (PostgreSQL 18.6, migrations up to 010):

- The API ran as `lais_app` through three browser walkthroughs (administrator, registration end to end, supervisor). Each ran on a freshly rebuilt database with the script re-applied.
- Every operation worked, including publication, audit writes, notifications, tasks, escalations and an administrator backup.

The verification found and fixed two problems:

- backups failed because the login could use sequences but not read their values;
- the script could not be re-run because it always tried to create the role.

A failed backup now also removes its partial file.

## Row-level security

**Status: designed, not implemented.**

County scope is enforced in the API's `authorize()`. That is tested, including cross-county attempts by direct API call. Row-level security would add a second, independent layer in case an API bug skips a check.

The proposed design:

1. Run the API as `lais_app` (see *Database roles*), which does not own the tables and has no `BYPASSRLS`.
2. At the start of each transaction, the API sets `SET LOCAL lais.user_id = …` and `SET LOCAL lais.county_ids = '{1,2}'` from the session's grants. National roles set `'*'`.
3. Add policies on `land_case`, `staging.batch`, `document` and `document_request` along the lines of: `USING (current_setting('lais.county_ids') = '*' OR county_id = ANY (current_setting('lais.county_ids')::smallint[]))`. Child tables are reached through their case.
4. Leave the public parcel layer and the reference tables (`county`, `document_category`) without RLS: they are not county-private.
5. Tests: run the cross-county integration tests with the API's `authorize()` county check disabled, and expect the database to refuse.

It was deferred because every query would need to run inside a transaction carrying the settings. Pooled queries outside a transaction (dashboards, health checks) would need to be reworked first.

## Known gaps

- Public deployment needs HTTPS termination, `NODE_ENV=production`, managed secrets and a hosting assessment. None of these are in place.
- Email delivery isn't implemented. Activation links are shown once to the administrator, who passes them on through an approved channel.
- No virus scanning of uploads. Files are checked by type sniffing and size only.
