// Browser walkthrough of a boundary correction on PROV-MO-000003.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';
const problems = [];
let step = 40;
const browser = await chromium.launch({ executablePath: BROWSER });
async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Checked against the field survey'));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)/.test(u.pathname));
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage: true }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}
let caseUrl = '';
const gis = await asUser('gis.mo');
await check('gis.mo opens a correction of PROV-MO-000003', async () => {
  await gis.getByRole('link', { name: 'New case' }).click();
  await gis.getByLabel(/Correction/).check();
  await gis.getByLabel('Published parcel identifier').fill('PROV-MO-000003');
  await gis.getByLabel('What is wrong, and how was it established?').fill('East boundary beacon mis-recorded by about 2 m; confirmed by 2026 field survey');
  await gis.getByRole('button', { name: 'Create draft case' }).click();
  await gis.waitForURL(/\/work\/cases\/[0-9a-f-]{36}/);
  caseUrl = gis.url();
  await gis.getByRole('heading', { name: 'Corrected record' }).waitFor();
});
await check('gis.mo changes the land use and sees the published value', async () => {
  await gis.getByLabel(/^Land use/).fill('agricultural (rice)');
  await gis.getByRole('button', { name: 'Save details' }).click();
  await gis.getByText('(published: agricultural)').first().waitFor();
});
await check('gis.mo imports the corrected boundary and a survey plan', async () => {
  const form = gis.locator('form', { hasText: 'Import parcel geometry' });
  await form.locator('select').selectOption('4326');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/correct_mo3_minor_4326.geojson`);
  await form.getByRole('button', { name: 'Import to staging' }).click();
  await gis.getByText(/Imported correct_mo3_minor_4326.geojson/).waitFor();
  const docs = gis.locator('form', { hasText: 'Upload' }).last();
  await docs.locator('select').first().selectOption('survey_plan');
  await docs.getByPlaceholder('Reference no.').fill('SP-CORR-1');
  await docs.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await docs.getByRole('button', { name: 'Upload' }).click();
  await gis.locator('td', { hasText: 'SP-CORR-1' }).waitFor();
  await shot(gis, 'correction-draft');
});
const proc = await asUser('proc.mo');
await check('proc.mo verifies the survey plan; no rights controls', async () => {
  await proc.goto(caseUrl);
  await proc.getByText('A correction never changes who holds an interest').waitFor();
  if (await proc.getByPlaceholder('Search parties by name').count()) throw new Error('rights editor shown on a correction');
  await proc.locator('tr', { hasText: 'SP-CORR-1' }).getByRole('button', { name: 'Verify' }).click();
  await proc.locator('tr', { hasText: 'SP-CORR-1' }).getByText(/verified by proc.mo/).waitFor();
});
await check('gis.mo submits without errors', async () => {
  await gis.goto(caseUrl);
  await gis.getByRole('button', { name: 'Submit for review' }).click();
  await gis.getByText('Under review').first().waitFor();
  if (await gis.locator('.findings li.error').count()) throw new Error('validation errors');
});
const reg = await asUser('reg.mo');
await check('reg.mo approves and publishes version 2', async () => {
  await reg.goto(caseUrl);
  while (await reg.getByRole('button', { name: 'Acknowledge with note' }).count()) {
    await reg.getByRole('button', { name: 'Acknowledge with note' }).first().click();
    await reg.waitForTimeout(400);
  }
  await reg.getByLabel('Reasons (recorded permanently)').fill('Field survey supports the corrected beacon position');
  await reg.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await reg.getByRole('button', { name: 'Record decision' }).click();
  await reg.getByRole('button', { name: 'Publish approved record' }).click();
  await reg.getByText(/Published as PROV-MO-000003 \(version 2\)/).waitFor();
});
await check('parcel record shows both versions', async () => {
  await reg.goto(`${BASE}/work/parcels/PROV-MO-000003`);
  const versions = reg.locator('section', { has: reg.getByRole('heading', { name: 'Versions' }) });
  await versions.getByText('agricultural (rice)').first().waitFor().catch(() => undefined);
  const rows = await versions.locator('tbody tr').count();
  if (rows !== 2) throw new Error(`expected 2 versions, saw ${rows}`);
  await shot(reg, 'corrected-parcel');
});
await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
