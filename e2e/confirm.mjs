// Browser walkthrough: confirm the documented interest of a migrated parcel.
// Setup (migrating the clean legacy batch, verifying the holder's identity) goes through the API.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';
import fs from 'node:fs';

const problems = [];
let step = 60;
const browser = await chromium.launch({ executablePath: BROWSER });

async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Original deed and ID card seen at the county office'));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)/.test(u.pathname));
  const csrf = (await (await ctx.request.get(`${BASE}/api/auth/session`)).json()).csrfToken;
  const call = async (method, path, data, multipart) => {
    const r = await ctx.request.fetch(`${BASE}/api${path}`, { method, headers: { 'X-CSRF-Token': csrf }, data, multipart });
    if (!r.ok()) throw new Error(`${username} ${method} ${path} -> ${r.status()} ${await r.text()}`);
    return r.json();
  };
  return { page, call };
}
const shot = async (page, name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage: true }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}
const pdf = () => ({ name: 'evidence.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(`${FIX}/synthetic_document.pdf`) });

const gis = await asUser('gis.mo');
const proc = await asUser('proc.mo');
const proc2 = await asUser('proc2.mo');
const reg = await asUser('reg.mo');
let upi = '';

await check('setup: migrate the clean legacy batch', async () => {
  const cs = await gis.call('POST', '/cases', { caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC 1987 register' });
  await gis.call('POST', `/cases/${cs.id}/geometry`, undefined, {
    crs: '4326', file: { name: 'legacy.geojson', mimeType: 'application/geo+json', buffer: fs.readFileSync(`${FIX}/legacy_register_mo_4326.geojson`) },
  });
  const doc = await gis.call('POST', `/cases/${cs.id}/documents`, undefined, { docType: 'other', classification: 'restricted', file: pdf() });
  await proc.call('POST', `/cases/${cs.id}/documents/${doc.id}/verify`, { status: 'verified', note: 'Register extract checked' });
  await gis.call('POST', `/cases/${cs.id}/submit`);
  const detail = await reg.call('GET', `/cases/${cs.id}`);
  for (const f of detail.validation.findings) await reg.call('POST', `/cases/${cs.id}/findings/${f.id}/acknowledge`, { note: 'Reviewed' });
  await reg.call('POST', `/cases/${cs.id}/decision`, { decision: 'approved', reason: 'Batch matches the register', authorityBasis: 'SYNTHETIC-DELEGATION-001' });
  await reg.call('POST', `/cases/${cs.id}/publish`);
  upi = (await reg.call('GET', `/cases/${cs.id}`)).staged.features[0].published_upi;
  // The holder appears in person; a new verified party record is created and checked by a second processor.
  const party = await proc.call('POST', '/parties', { partyType: 'person', name: 'Esther Legacyname', nationalIdRef: 'SYN-ID-7781' });
  await proc2.call('POST', `/parties/${party.id}/verify-identity`, { note: 'Synthetic ID card seen' });
});

let caseUrl = '';
await check('processor starts a confirmation from the parcel page', async () => {
  const p = proc.page;
  await p.goto(`${BASE}/work/parcels/${upi}`);
  await p.getByText('documented').first().waitFor();
  await shot(p, 'documented-parcel');
  await p.getByRole('link', { name: 'Confirm these interests' }).click();
  await p.getByLabel('Published parcel identifier').waitFor();
  if ((await p.getByLabel('Published parcel identifier').inputValue()) !== upi) throw new Error('identifier not prefilled');
  await p.getByLabel('Survey / source record reference').fill('SYNTHETIC verification visit, 27 Oct');
  await p.getByRole('button', { name: 'Create draft case' }).click();
  await p.waitForURL(/\/work\/cases\/[0-9a-f-]{36}/);
  caseUrl = p.url();
  await p.getByText(/Esther Legacyname \(person, documented\)/).waitFor();
});

await check('processor records the verified holder and the deed', async () => {
  const p = proc.page;
  await p.getByPlaceholder('Search parties by name').fill('Esther');
  await p.locator('form', { has: p.getByPlaceholder('Search parties by name') }).getByRole('button', { name: 'Search' }).click();
  // Both the unverified migrated record and the new verified one are listed; pick the verified one.
  await p.locator('li', { hasText: 'identity verified' }).getByRole('button', { name: 'Esther Legacyname' }).click();
  await p.getByRole('button', { name: 'Add', exact: true }).click();
  await p.locator('table', { hasText: 'Esther Legacyname' }).waitFor();
  const form = p.locator('form', { hasText: 'Upload' }).last();
  await form.locator('select').first().selectOption('deed');
  await form.getByPlaceholder('Reference no.').fill('DEED-1987-0001');
  await form.locator('input[type=file]').setInputFiles(`${FIX}/synthetic_document.pdf`);
  await form.getByRole('button', { name: 'Upload' }).click();
  await p.locator('td', { hasText: 'DEED-1987-0001' }).waitFor();
});

await check('second processor verifies the deed; submission passes', async () => {
  await proc2.page.goto(caseUrl);
  await proc2.page.locator('tr', { hasText: 'DEED-1987-0001' }).getByRole('button', { name: 'Verify' }).click();
  await proc2.page.locator('tr', { hasText: 'DEED-1987-0001' }).getByText(/verified by proc2.mo/).waitFor();
  await proc.page.goto(caseUrl);
  await proc.page.getByRole('button', { name: 'Submit for review' }).click();
  await proc.page.getByText('Under review').first().waitFor();
  if (await proc.page.locator('.findings li.error').count()) throw new Error('validation errors');
  await shot(proc.page, 'confirmation-submitted');
});

await check('registrar approves and publishes; the parcel becomes registered', async () => {
  const p = reg.page;
  await p.goto(caseUrl);
  await p.getByText('Validation and conflict checks').waitFor();
  await p.waitForTimeout(500);
  while (await p.getByRole('button', { name: 'Acknowledge with note' }).count()) {
    await p.getByRole('button', { name: 'Acknowledge with note' }).first().click();
    await p.waitForTimeout(400);
  }
  await p.getByLabel('Reasons (recorded permanently)').fill('Identity and deed verified; name matches the legacy record');
  await p.getByLabel('Delegated authority relied on').fill('SYNTHETIC-DELEGATION-001');
  await p.getByRole('button', { name: 'Record decision' }).click();
  await p.getByRole('button', { name: 'Publish approved record' }).click();
  await p.getByText('Published').first().waitFor();
  await p.goto(`${BASE}/work/parcels/${upi}`);
  await p.getByText('Previous interests').waitFor();
  if (await p.getByText('Interests marked documented').count()) throw new Error('documented notice still shown');
  await shot(p, 'confirmed-parcel');
  const pub = await (await p.context().request.get(`${BASE}/api/public/parcels/${upi}`)).json();
  if (pub.properties.record_status !== 'registered') throw new Error(`public status is ${pub.properties.record_status}`);
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
