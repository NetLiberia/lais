// Browser walkthrough of a legacy migration with quarantine of faulty features.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';
const problems = [];
let step = 50;
const browser = await chromium.launch({ executablePath: BROWSER });
async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Fault in the legacy record; to be fixed with the custodian'));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)/.test(u.pathname));
  // GIS officers land on their GIS dashboard; this journey starts from the case list.
  if (new URL(page.url()).pathname === '/gis') await page.goto(`${BASE}/work`);
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage: true }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}
let caseUrl = '';
const gis = await asUser('gis.mo');
await check('gis.mo opens a migration and imports the legacy file', async () => {
  await gis.getByRole('link', { name: 'New case' }).click();
  await gis.getByLabel(/Legacy migration/).check();
  await gis.getByLabel('Legacy register or dataset name').fill('SYNTHETIC 1990 county register extract');
  await gis.getByRole('button', { name: 'Create draft case' }).click();
  await gis.waitForURL(/\/work\/cases\/[0-9a-f-]{36}/);
  caseUrl = gis.url();
  const form = gis.locator('form', { hasText: 'Import parcel geometry' });
  await form.locator('select').selectOption('4326');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/legacy_register_problems_mo_4326.geojson`);
  await form.getByRole('button', { name: 'Import to staging' }).click();
  await gis.getByText('8 feature(s)').first().waitFor();
  const docs = gis.locator('form', { hasText: 'Upload' }).last();
  await docs.locator('select').first().selectOption('other');
  await docs.getByPlaceholder('Reference no.').fill('REGISTER-EXTRACT');
  await docs.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await docs.getByRole('button', { name: 'Upload' }).click();
  await gis.locator('td', { hasText: 'REGISTER-EXTRACT' }).waitFor();
});
const proc = await asUser('proc.mo');
await check('proc.mo verifies the register extract', async () => {
  await proc.goto(caseUrl);
  await proc.locator('tr', { hasText: 'REGISTER-EXTRACT' }).getByRole('button', { name: 'Verify' }).click();
  await proc.locator('tr', { hasText: 'REGISTER-EXTRACT' }).getByText(/verified by proc.mo/).waitFor();
});
await check('gis.mo submits; faulty features are flagged in the table', async () => {
  await gis.goto(caseUrl);
  await gis.getByRole('button', { name: 'Submit for review' }).click();
  await gis.getByText('Returned').first().waitFor();
  await gis.locator('.table-scroll .sev-error').first().waitFor();
  await shot(gis, 'migration-returned');
  const flagged = await gis.locator('.table-scroll tbody tr', { has: gis.locator('.sev-error') }).count();
  if (flagged !== 5) throw new Error(`expected 5 features with errors, saw ${flagged}`);
  await shot(gis, 'migration-returned');
});
await check('gis.mo quarantines the five faulty features and resubmits', async () => {
  for (const n of [2, 3, 4, 5, 8]) {
    await gis.locator('.table-scroll tbody tr', { has: gis.locator(`td:first-child:text-is("${n}")`) }).getByRole('button', { name: 'Exclude' }).click();
    await gis.locator('.table-scroll tbody tr', { has: gis.locator(`td:first-child:text-is("${n}")`) }).getByText('excluded').waitFor();
  }
  await gis.getByRole('button', { name: 'Submit for review' }).click();
  await gis.getByText('Under review').first().waitFor();
});
const reg = await asUser('reg.mo');
await check('reg.mo acknowledges the overlap, approves and publishes', async () => {
  try { await regFlow(); } catch (e) { await reg.screenshot({ path: `${SHOTS}/59-reg-failure.png`, fullPage: true }); throw e; }
});
async function regFlow() {
  await reg.goto(caseUrl);
  // Wait for the findings to load before counting the buttons.
  await reg.getByText('MIGRATION_INTERNAL_OVERLAP').first().waitFor();
  while (await reg.getByRole('button', { name: 'Acknowledge with note' }).count()) {
    await reg.getByRole('button', { name: 'Acknowledge with note' }).first().click();
    await reg.waitForTimeout(400);
  }
  await reg.getByLabel('Reasons (recorded permanently)').fill('Batch reviewed against the register extract');
  await reg.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await reg.getByRole('button', { name: 'Record decision' }).click();
  await reg.getByRole('button', { name: 'Publish approved record' }).click();
  await reg.getByText('3 migrated parcel(s)').first().waitFor();
  await reg.getByText('5 excluded, 3 published').waitFor();
  await shot(reg, 'migration-published');
}
await check('reconciliation report downloads', async () => {
  const [download] = await Promise.all([reg.waitForEvent('download'), reg.getByRole('link', { name: /reconciliation report/ }).click()]);
  const fs = await import('node:fs');
  const csv = fs.readFileSync(await download.path(), 'utf8');
  if (!/3 published, 5 excluded/.test(csv)) throw new Error('report totals missing');
});
await check('migrated parcel shows legacy reference and documented interest', async () => {
  await reg.locator('.table-scroll').getByRole('link').first().click();
  await reg.getByText('LR-MO-1990-0001').first().waitFor();
  await reg.getByText('documented').first().waitFor();
  await shot(reg, 'migrated-parcel');
});
await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
