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

`server/db/roles.sql` is an optional hardening script, run once by a superuser after migrating. It creates a separate runtime login, `lais_app`, which:

- cannot change table structure or disable triggers;
- cannot UPDATE or DELETE audit events or published history;
- has read-only access to the migration history, so that backups still work.

**Status: unverified.** The script predates the administrator features. It grants on all tables that exist when it is run, but it has not been re-run or tested against migration 009.

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
