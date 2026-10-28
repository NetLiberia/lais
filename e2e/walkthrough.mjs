// Drives the README walkthrough in Edge across roles. Usage: node walkthrough.mjs
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';

const problems = [];
let step = 0;

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });

async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && !page.__expect?.(r)) problems.push(`[${username}] HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  page.on('dialog', (d) => d.accept(page.__answer ?? 'Checked against the original record'));
  if (username) {
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.pathname.startsWith('/start'), { timeout: 15000 });
    // GIS officers land on their GIS dashboard; this journey starts from the case list.
    if (new URL(page.url()).pathname === '/gis') await page.goto(`${BASE}/work`);
  }
  return page;
}

async function shot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, '0')}-${name}.png`, fullPage: true });
}

async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); }
  catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}

// 1. Public portal
const pub = await asUser(null);
await check('public map loads parcels', async () => {
  await pub.goto(BASE);
  await pub.locator('path.leaflet-interactive').first().waitFor({ timeout: 15000 });
  await pub.getByPlaceholder('e.g. PROV-MO-000001').fill('PROV-MO-000001');
  await pub.getByRole('button', { name: 'Search' }).click();
  await pub.getByRole('heading', { name: 'PROV-MO-000001' }).waitFor();
  const text = await pub.locator('body').innerText();
  if (/Testperson/.test(text)) throw new Error('owner name visible on public page');
  await shot(pub, 'public-portal');
});

// 2. GIS officer opens a case and imports geometry
const gis = await asUser('gis.mo');
let caseUrl = '';
await check('gis.mo lands on case list', async () => { await gis.getByRole('heading', { name: 'Cases' }).waitFor(); await shot(gis, 'gis-cases'); });
await check('gis.mo creates registration case', async () => {
  await gis.getByRole('link', { name: 'New case' }).click();
  await gis.getByLabel('Land use').fill('residential');
  await gis.getByLabel('Survey / source record reference').fill('SYNTHETIC-SURVEY-UI-1');
  await gis.getByRole('button', { name: 'Create draft case' }).click();
  await gis.waitForURL(/\/work\/cases\/[0-9a-f-]{36}/);
  caseUrl = gis.url();
});
await check('gis.mo imports overlapping geometry', async () => {
  const form = gis.locator('form', { hasText: 'Import parcel geometry' });
  await form.locator('select').selectOption('4326');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/overlap_published_4326.geojson`);
  await form.getByRole('button', { name: 'Import to staging' }).click();
  await gis.getByText(/Imported overlap_published_4326.geojson/).waitFor();
});
await check('gis.mo uploads survey plan', async () => {
  const form = gis.locator('form', { hasText: 'Upload' }).last();
  await form.locator('select').first().selectOption('survey_plan');
  await form.getByPlaceholder('Reference no.').fill('SP-UI-1');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await form.getByRole('button', { name: 'Upload' }).click();
  await gis.locator('td', { hasText: 'SP-UI-1' }).waitFor();
});
await check('gis.mo runs checks before submit', async () => {
  await gis.getByRole('button', { name: 'Run checks' }).click();
  await gis.getByText('NO_PROPOSED_RIGHTS').waitFor();
  await shot(gis, 'gis-case-draft');
});

// 3. Processor adds owner and deed, verifies the GIS officer's survey plan
const proc = await asUser('proc.mo');
await check('proc.mo adds owner', async () => {
  await proc.goto(caseUrl);
  await proc.getByPlaceholder('Search parties by name').fill('Hawa');
  await proc.locator('form', { has: proc.getByPlaceholder('Search parties by name') }).getByRole('button', { name: 'Search' }).click();
  await proc.getByRole('button', { name: 'Hawa Testperson' }).click();
  await proc.getByRole('button', { name: 'Add', exact: true }).click();
  await proc.locator('table', { hasText: 'Hawa Testperson' }).waitFor();
});
await check('proc.mo uploads deed', async () => {
  const form = proc.locator('form', { hasText: 'Upload' }).last();
  await form.locator('select').first().selectOption('deed');
  await form.getByPlaceholder('Reference no.').fill('DEED-UI-1');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await form.getByRole('button', { name: 'Upload' }).click();
  await proc.locator('td', { hasText: 'DEED-UI-1' }).waitFor();
});
await check('proc.mo verifies survey plan, cannot verify own deed', async () => {
  const planRow = proc.locator('tr', { hasText: 'SP-UI-1' });
  await planRow.getByRole('button', { name: 'Verify' }).click();
  await planRow.getByText(/verified by proc.mo/).waitFor();
  const deedButtons = await proc.locator('tr', { hasText: 'DEED-UI-1' }).getByRole('button', { name: 'Verify' }).count();
  if (deedButtons !== 0) throw new Error('uploader is offered Verify on own document');
  await shot(proc, 'proc-case');
});
const proc2 = await asUser('proc2.mo');
await check('proc2.mo verifies deed', async () => {
  await proc2.goto(caseUrl);
  const row = proc2.locator('tr', { hasText: 'DEED-UI-1' });
  await row.getByRole('button', { name: 'Verify' }).click();
  await row.getByText(/verified by proc2.mo/).waitFor();
});

// 4. Submit
await check('gis.mo submits; case goes under review with overlap warnings', async () => {
  await gis.goto(caseUrl);
  await gis.getByRole('button', { name: 'Submit for review' }).click();
  await gis.getByText('Under review').first().waitFor();
  const n = await gis.getByText('OVERLAP_PUBLISHED_PARCEL').count();
  if (n !== 4) throw new Error(`expected 4 overlap warnings, saw ${n}`);
  await shot(gis, 'submitted');
});

// 5. Wrong-county registrar
const regMg = await asUser('reg.mg');
regMg.__expect = (r) => r.status() === 403;
await check('reg.mg is refused', async () => {
  await regMg.goto(caseUrl);
  await regMg.getByText(/outside your assigned jurisdiction/).waitFor();
  await shot(regMg, 'reg-mg-denied');
});

// 6. Registrar acknowledges, approves, publishes
const reg = await asUser('reg.mo');
let publishedUpi = '';
await check('reg.mo sees case in review queue', async () => {
  await reg.getByRole('heading', { name: 'Cases' }).waitFor();
  await reg.locator('tbody tr').first().waitFor();
  await shot(reg, 'reg-queue');
});
await check('reg.mo cannot approve before acknowledging', async () => {
  reg.__expect = (r) => r.status() === 409;
  await reg.goto(caseUrl);
  await reg.getByLabel('Reasons (recorded permanently)').fill('Evidence reviewed; overlaps investigated');
  await reg.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await reg.getByRole('button', { name: 'Record decision' }).click();
  await reg.getByText(/Acknowledge all 4 warning/).waitFor();
  reg.__expect = undefined;
});
await check('reg.mo acknowledges all warnings', async () => {
  for (let i = 0; i < 4; i++) {
    await reg.getByRole('button', { name: 'Acknowledge with note' }).first().click();
    await reg.waitForTimeout(400);
  }
  const left = await reg.getByRole('button', { name: 'Acknowledge with note' }).count();
  if (left) throw new Error(`${left} warnings still unacknowledged`);
});
await check('reg.mo approves', async () => {
  await reg.getByLabel('Reasons (recorded permanently)').fill('Evidence reviewed; overlaps investigated');
  await reg.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await reg.getByRole('button', { name: 'Record decision' }).click();
  await reg.getByRole('button', { name: 'Publish approved record' }).waitFor();
  await shot(reg, 'approved');
});
await check('reg.mo publishes', async () => {
  await reg.getByRole('button', { name: 'Publish approved record' }).click();
  await reg.getByText(/Published as PROV-MO-\d+/).waitFor();
  publishedUpi = (await reg.getByText(/Published as PROV-MO-\d+/).first().innerText()).match(/PROV-MO-\d+/)[0];
  await shot(reg, 'published');
});
await check('reg.mo opens the new parcel record', async () => {
  await reg.goto(`${BASE}/work/parcels/${publishedUpi}`);
  await reg.getByText('Hawa Testperson').first().waitFor();
  await shot(reg, 'parcel-record');
});

// 7. Oversight, landowner, admin
const aud = await asUser('auditor');
await check('auditor verifies hash chain', async () => {
  await aud.goto(`${BASE}/work/audit`);
  await aud.getByRole('button', { name: 'Verify hash chain' }).click();
  await aud.getByText(/Chain intact/).waitFor();
  await shot(aud, 'audit');
});
const owner = await asUser('owner.demo');
await check('landowner sees own parcels', async () => {
  await owner.getByRole('heading', { name: 'My registered interests' }).waitFor();
  await owner.getByText('PROV-MO-000001').first().waitFor();
  await shot(owner, 'landowner');
});
const admin = await asUser('admin');
await check('admin lands on dashboard, no Cases tab', async () => {
  await admin.getByRole('heading', { name: /^Welcome/ }).waitFor();
  if (await admin.getByRole('link', { name: 'Cases' }).count()) throw new Error('admin sees Cases nav');
  await shot(admin, 'admin');
});
await check('parties page for processor', async () => {
  await proc.goto(`${BASE}/work/parties`);
  await proc.getByText('Unverified Applicant (synthetic)').waitFor();
  await shot(proc, 'parties');
});
await check('mobile width public page has no horizontal scroll', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const m = await ctx.newPage();
  await m.goto(BASE);
  await m.waitForTimeout(1500);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await m.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, '0')}-mobile.png` });
  if (overflow > 0) throw new Error(`page is ${overflow}px wider than the viewport`);
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
