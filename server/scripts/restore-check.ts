// Restore test: restores a backup into a DISPOSABLE database and checks it is usable.
//
//   npm run backup:verify -- storage/backups/<file>.dump
//
// The target is RESTORE_CHECK_DATABASE_URL, or TEST_DATABASE_URL when that is unset. Everything in the
// target's lais, staging and audit schemas, and its migration history, is replaced. The live DATABASE_URL is
// refused as a target. pg_restore is taken from the same folder as PG_DUMP_PATH (or PATH). Passwords
// travel in the environment of the child process, never on its command line.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const file = process.argv[2];
const target = process.env.RESTORE_CHECK_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!file || !existsSync(file)) throw new Error('Usage: npm run backup:verify -- <backup file>');
if (!target) throw new Error('Set RESTORE_CHECK_DATABASE_URL (or TEST_DATABASE_URL) to a disposable database');
const t = new URL(target);
const live = new URL(process.env.DATABASE_URL!);
if (t.host === live.host && t.pathname === live.pathname) throw new Error('Refusing to restore over the live database');

const dumpPath = process.env.PG_DUMP_PATH || 'pg_dump';
const pgRestore = dumpPath.includes('/') || dumpPath.includes('\\')
  ? path.join(path.dirname(dumpPath), path.basename(dumpPath).replace('pg_dump', 'pg_restore'))
  : 'pg_restore';

function run(cmd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, PGPASSWORD: decodeURIComponent(t.password) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// The backup holds the whole database. Restore the application's schemas (lais, staging, audit) and the migration history;
// PostGIS and other extensions belong to the target server and are installed there, not restored.
const toc = await run(pgRestore, ['--list', file]);
if (toc.code !== 0) throw new Error(`pg_restore --list failed: ${toc.stderr.trim()}`);
const wanted = toc.stdout.split(/\r?\n/).filter((l) => !l.startsWith(';') && / (lais|audit|staging) |public schema_migrations /.test(l));
const listFile = path.join(os.tmpdir(), `lais-restore-${process.pid}.list`);
writeFileSync(listFile, wanted.join('\n') + '\n');

const db = new pg.Client({ connectionString: target });
await db.connect();
// Start from an empty target so the check proves the backup alone is enough.
await db.query('DROP SCHEMA IF EXISTS lais CASCADE; DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA IF EXISTS staging CASCADE; DROP TABLE IF EXISTS public.schema_migrations');
const started = Date.now();
const { code, stderr } = await run(pgRestore, [
  '--host', t.hostname, '--port', t.port || '5432', '--username', decodeURIComponent(t.username),
  '--dbname', t.pathname.slice(1), '--no-owner', '--no-privileges', '--exit-on-error', '--use-list', listFile, file,
]);
rmSync(listFile, { force: true });
if (code !== 0) {
  console.error(stderr.trim());
  throw new Error(`pg_restore failed with exit code ${code}`);
}
const ms = Date.now() - started;

const { rows: tables } = await db.query(
  `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('lais', 'audit', 'staging') AND table_type = 'BASE TABLE' ORDER BY 1`,
);
const counts: Record<string, number> = {};
for (const { name } of tables) {
  const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM ${name.split('.').map((p: string) => `"${p}"`).join('.')}`);
  counts[name] = r.n;
}
const { rows: migrations } = await db.query('SELECT name FROM public.schema_migrations ORDER BY name');
const { rows: [chain] } = await db.query('SELECT * FROM audit.verify_chain()');
const { rows: [geom] } = await db.query(
  `SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT ST_IsValid(v.geom))::int AS invalid
     FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id`,
);
await db.end();

console.log(JSON.stringify({
  file: path.basename(file),
  restoredInto: `${t.host}${t.pathname}`,
  restoreMs: ms,
  tables: Object.keys(counts).length,
  rowCounts: counts,
  migrationsRecorded: migrations.map((m: { name: string }) => m.name),
  auditChain: { checked: Number(chain.checked), intact: chain.first_bad_seq === null },
  parcels: { count: geom.n, invalidGeometries: geom.invalid },
}, null, 2));
if (chain.first_bad_seq !== null || geom.invalid > 0) process.exit(1);
