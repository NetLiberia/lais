// Browser walkthrough of a subdivision: gis.mo splits PROV-MO-000008, processors record
// documents and rights, reg.mo approves and publishes, then the lineage is checked.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';

const problems = [];
let step = 20;
const browser = await chromium.launch({ executablePath: BROWSER });

async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Checked against the survey record'));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)/.test(u.pathname));
  // GIS officers land on their GIS dashboard; this journey starts from the case list.
  if (new URL(page.url()).pathname === '/gis') await page.goto(`${BASE}/work`);
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage: true }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}

let caseUrl = '';
let newUpis = [];
const gis = await asUser('gis.mo');
await check('gis.mo opens a subdivision of PROV-MO-000008', async () => {
  await gis.getByRole('link', { name: 'New case' }).click();
  await gis.getByLabel(/Subdivision/).check();
  await gis.getByLabel('Published parcel identifier').fill('PROV-MO-000008');
  await gis.getByLabel('Survey / source record reference').fill('SYNTHETIC-SUBDIVISION-UI');
  await gis.getByRole('button', { name: 'Create draft case' }).click();
  await gis.waitForURL(/\/work\/cases\/[0-9a-f-]{36}/);
  caseUrl = gis.url();
  await gis.getByText('Interests on PROV-MO-000008').waitFor();
});
await check('gis.mo imports two new parcels', async () => {
  const form = gis.locator('form', { hasText: 'Import parcel geometry' });
  await form.locator('select').selectOption('4326');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/subdivide_mo8_halves_4326.geojson`);
  await form.getByRole('button', { name: 'Import to staging' }).click();
  await gis.getByText('New parcel 2:').waitFor();
});
await check('gis.mo uploads the survey plan', async () => {
  const form = gis.locator('form', { hasText: 'Upload' }).last();
  await form.locator('select').first().selectOption('survey_plan');
  await form.getByPlaceholder('Reference no.').fill('SP-SUB-1');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await form.getByRole('button', { name: 'Upload' }).click();
  await gis.locator('td', { hasText: 'SP-SUB-1' }).waitFor();
  await shot(gis, 'subdivision-draft');
});

const proc = await asUser('proc.mo');
await check('proc.mo copies ownership to each new parcel and verifies the plan', async () => {
  await proc.goto(caseUrl);
  await proc.getByRole('button', { name: 'Copy current ownership to each new parcel' }).click();
  await proc.locator('tbody tr', { hasText: 'Sample Trading Company' }).nth(1).waitFor();
  await proc.locator('tr', { hasText: 'SP-SUB-1' }).getByRole('button', { name: 'Verify' }).click();
  await proc.locator('tr', { hasText: 'SP-SUB-1' }).getByText(/verified by proc.mo/).waitFor();
  await shot(proc, 'subdivision-rights');
});

await check('gis.mo submits; no errors', async () => {
  await gis.goto(caseUrl);
  await gis.getByRole('button', { name: 'Submit for review' }).click();
  await gis.getByText('Under review').first().waitFor();
  const errors = await gis.locator('.findings li.error').count();
  if (errors) throw new Error(`${errors} validation error(s)`);
});

const reg = await asUser('reg.mo');
await check('reg.mo acknowledges, approves and publishes', async () => {
  await reg.goto(caseUrl);
  while (await reg.getByRole('button', { name: 'Acknowledge with note' }).count()) {
    await reg.getByRole('button', { name: 'Acknowledge with note' }).first().click();
    await reg.waitForTimeout(400);
  }
  await reg.getByLabel('Reasons (recorded permanently)').fill('Survey plan and owner consent reviewed');
  await reg.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await reg.getByRole('button', { name: 'Record decision' }).click();
  await reg.getByRole('button', { name: 'Publish approved record' }).click();
  await reg.getByText(/created PROV-MO-\d+, PROV-MO-\d+/).waitFor();
  newUpis = (await reg.getByText(/created PROV-MO-\d+, PROV-MO-\d+/).innerText()).split('created')[1].match(/PROV-MO-\d+/g);
  await shot(reg, 'subdivision-published');
});
await check('retired parent shows lineage', async () => {
  await reg.goto(`${BASE}/work/parcels/PROV-MO-000008`);
  await reg.getByText('This parcel is retired').waitFor();
  for (const u of newUpis) await reg.getByRole('link', { name: u }).first().waitFor();
  await shot(reg, 'retired-parent');
});
await check('new parcel shows its parent', async () => {
  await reg.goto(`${BASE}/work/parcels/${newUpis[0]}`);
  await reg.getByText('Created from').waitFor();
  await shot(reg, 'child-parcel');
});
await check('public search for the old identifier points to the new ones', async () => {
  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  await pub.goto(BASE);
  await pub.getByPlaceholder('e.g. PROV-MO-000001').fill('PROV-MO-000008');
  await pub.getByRole('button', { name: 'Search' }).click();
  await pub.getByText(/retired and replaced by/).waitFor();
  await shot(pub, 'public-retired');
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
