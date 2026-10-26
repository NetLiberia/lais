import { promises as fs } from 'node:fs';
import { config, isProduction } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { passwordPolicyProblem } from './auth/password.js';

/** Development only: drops all LAIS schemas and stored documents, then migrates and seeds again. */
export async function resetDatabase(password: string, log = console.log): Promise<void> {
  if (isProduction) throw new Error('Refusing to reset a production database');
  await pool.query('DROP SCHEMA IF EXISTS audit, staging, lais CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.schema_migrations');
  await fs.rm(config.documentStorageDir, { recursive: true, force: true });
  await migrate(log);
  await seed(password, log);
}

if (process.argv[1]?.endsWith('reset.ts')) {
  const password = process.env.SEED_PASSWORD ?? '';
  const problem = passwordPolicyProblem(password);
  if (problem) {
    console.error(`Set SEED_PASSWORD in server/.env first (${problem}).`);
    process.exit(1);
  }
  resetDatabase(password)
    .then(() => console.log('reset complete'))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
