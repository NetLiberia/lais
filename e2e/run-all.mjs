// Runs every browser walkthrough against the running stack, resetting the development database
// before each one (`npm run db:reset`, refused in production mode). Exits non-zero on any problem.
//
//   npm run e2e                       all walkthroughs
//   npm run e2e -- admin confirm      only these
//
// Needs the API and web app running (see README) and SEED_PASSWORD in server/.env.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALL = ['walkthrough', 'subdivide', 'docrequest', 'correct', 'migrate', 'confirm', 'admin', 'supervisor'];
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const root = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;

for (const name of chosen) {
  if (!ALL.includes(name)) throw new Error(`Unknown walkthrough "${name}". Choose from: ${ALL.join(', ')}`);
  const reset = spawnSync('npm', ['run', 'db:reset'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (reset.status !== 0) throw new Error(`Database reset failed:\n${reset.stderr}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { cwd: root, encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const problems = /(\d+) problem\(s\)/.exec(out);
  const ok = run.status === 0 && problems?.[1] === '0';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${(out.match(/^ok /gm) ?? []).length} steps ok)`);
  if (!ok) console.log(out.split('\n').filter((l) => /^(FAIL| - )/.test(l) || !problems).join('\n'));
}
console.log(failed ? `\n${failed} walkthrough(s) failed` : '\nall walkthroughs passed');
process.exit(failed ? 1 : 0);
