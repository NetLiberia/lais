// Browser walkthrough of a landowner document request. Setup (a published transfer of
// PROV-MO-000010 to the landowner's party, with a deed) is done through the API.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';
const PDF = `${FIX}/synthetic_document.pdf`;

const problems = [];
let step = 30;
const browser = await chromium.launch({ executablePath: BROWSER });

async function asUser(username) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
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
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage: true }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.split('\n')[0]}`); console.log('FAIL', label); }
}

const proc = await asUser('proc.mo');
const proc2 = await asUser('proc2.mo');
const reg = await asUser('reg.mo');
const owner = await asUser('owner.demo');

await check('setup: transfer PROV-MO-000010 to the landowner with a verified deed', async () => {
  const fs = await import('node:fs');
  const musu = (await proc.call('GET', '/parties?q=Musu'))[0].id;
  const cs = await proc.call('POST', '/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000010', sourceReference: 'SYNTHETIC-TRANSFER-DR' });
  await proc.call('POST', `/cases/${cs.id}/rights`, { partyId: musu, rrrType: 'ownership' });
  const deed = await proc.call('POST', `/cases/${cs.id}/documents`, undefined, {
    docType: 'deed', classification: 'restricted', referenceNo: 'DEED-2026-0042',
    file: { name: 'deed.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(PDF) },
  });
  await proc2.call('POST', `/cases/${cs.id}/documents/${deed.id}/verify`, { status: 'verified', note: 'Deed checked' });
  await proc.call('POST', `/cases/${cs.id}/submit`);
  await reg.call('POST', `/cases/${cs.id}/decision`, { decision: 'approved', reason: 'Transfer deed verified', authorityBasis: 'SYNTHETIC-DELEGATION-001' });
  await reg.call('POST', `/cases/${cs.id}/publish`);
});

await check('landowner requests the deed', async () => {
  const p = owner.page;
  await p.goto(`${BASE}/me`);
  const card = p.locator('section', { has: p.getByRole('heading', { name: 'PROV-MO-000010' }) });
  await card.getByRole('button', { name: 'Request documents' }).click();
  await card.getByLabel('Why do you need them? (10+ characters)').fill('Needed for a bank loan application');
  await card.getByRole('button', { name: 'Send request' }).click();
  await p.getByText('Received, awaiting preparation').waitFor();
  await shot(p, 'landowner-request');
});

await check('processor prepares the release', async () => {
  const p = proc.page;
  await p.goto(`${BASE}/work/document-requests`);
  await p.locator('tbody tr').first().click();
  await p.getByText('Needed for a bank loan application').waitFor();
  await p.getByRole('checkbox', { name: /Release deed DEED-2026-0042/ }).check();
  await p.getByLabel(/Note for the registrar/).fill('Deed from the published transfer case; requester is the registered owner');
  await p.getByRole('button', { name: /Send to registrar \(1 document\)/ }).click();
  await p.getByText('Awaiting decision').first().waitFor();
  await shot(p, 'processor-prepared');
});

await check('registrar approves', async () => {
  const p = reg.page;
  await p.goto(`${BASE}/work/document-requests`);
  await p.locator('tbody tr').first().click();
  await p.getByLabel('Reason (shown to the requester)').fill('You hold the registered interest; copy released for 30 days');
  await p.getByRole('button', { name: 'Record decision' }).click();
  await p.getByText('Release ends').waitFor();
  await shot(p, 'registrar-approved');
});

await check('landowner downloads the released deed', async () => {
  const p = owner.page;
  await p.goto(`${BASE}/me`);
  const link = p.getByRole('link', { name: /deed DEED-2026-0042/ });
  const [download] = await Promise.all([p.waitForEvent('download'), link.click()]);
  const path = await download.path();
  const fs = await import('node:fs');
  if (!fs.readFileSync(path).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('downloaded file is not the PDF');
  await shot(p, 'landowner-released');
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
