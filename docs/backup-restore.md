# Backup and restore

## What a backup contains

A backup is a full `pg_dump` of the database in custom format. It includes:

- the `lais` schema (records and accounts), the `staging` schema (imports and validation) and the `audit` schema (the trail);
- the migration history (`public.schema_migrations`);
- the PostGIS objects in `public`.

It does **not** include uploaded document files (`DOCUMENT_STORAGE_DIR`). Back those up separately; see the checklist below.

**Treat backup files as sensitive.** They contain password hashes, encrypted MFA secrets, personal data about parties, and the full audit trail. Session tokens and one-time link tokens are stored only as hashes, so a backup cannot be used to take over a session.

## Taking a backup

You can start one from the interface or from the command line.

**From the interface:** Administration → Settings → *Back up now*. It asks for a reason, then:

1. runs `pg_dump` (`PG_DUMP_PATH`) without a shell, passing the password through the environment;
2. writes the file to `BACKUP_DIR`;
3. records the size and SHA-256 in `lais.backup_run`;
4. writes an audit event.

If `pg_dump` fails, the run is recorded as failed and the API returns 502. The *Latest successful backup* health check warns when no backup has succeeded in the last 7 days.

**From the command line** (Windows, PostgreSQL 18):

```powershell
$env:PGPASSWORD = '<lais_owner password>'
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' -h localhost -U lais_owner -d lais -Fc -f lais-backup.dump
$env:PGPASSWORD = $null
```

## Checking that a backup restores

```bash
cd server
npm run backup:verify -- storage/backups/<file>.dump
```

The command restores the backup into a **disposable** database and checks the result:

- The target is `RESTORE_CHECK_DATABASE_URL`, or `TEST_DATABASE_URL` if that is unset. The live `DATABASE_URL` is refused.
- It drops the `lais`, `staging` and `audit` schemas and the migration history in the target, then restores them from the backup with `pg_restore`. PostGIS must already be installed in the target.
- It reports row counts for every table and the migrations recorded, re-verifies the audit hash chain, and checks every current parcel geometry.
- It exits non-zero if the chain is broken or any geometry is invalid.

### Verified result (27 October 2026)

Run on PostgreSQL 18.6 with PostGIS 3.6.2 on Windows, using a backup taken through the interface:

- 29 tables restored in 0.8 s, including the `staging` tables (22 batches, 50 features, 37 validation runs, 74 findings);
- all 9 migrations recorded;
- the audit chain intact across 354 events;
- 32 parcels, 0 invalid geometries.

`npm run db:migrate` against the restored database applied nothing, which confirms it is recognised as up to date.

## Restoring for real

1. Stop the API so nothing writes during the restore.
2. Create an empty database owned by `lais_owner` and run `CREATE EXTENSION postgis;` in it as a superuser.
3. Restore into it:
   ```powershell
   & 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -h localhost -U lais_owner -d lais_restored --no-owner --exit-on-error <file>.dump
   ```
   If the target already has PostGIS, `pg_restore` may report that the extension's objects already exist. Either restore with a list that leaves them out (see `server/scripts/restore-check.ts`), or ignore those specific messages.
4. Restore the document files to `DOCUMENT_STORAGE_DIR`.
5. Point `DATABASE_URL` at the restored database, start the API, and confirm two things:
   - System Health shows *Audit trail integrity* as healthy;
   - a known parcel opens on the public map.

## Checklist for an operational deployment (not done in the prototype)

- Schedule backups. The prototype only runs them on demand.
- Copy backups and document files off the host, and encrypt them at rest.
- Run `backup:verify` on a schedule against a scratch server, and alert on failure.
- Set a retention period agreed with the records authority.
