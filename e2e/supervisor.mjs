// Browser walkthrough of the Supervisor Dashboard phase. Preparation (cases, geometry, documents) goes
// through the API in each officer's own signed-in session; every supervisory step is done by clicking.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';

const problems = [];
let step = 100;
const browser = await chromium.launch({ executablePath: BROWSER });
let sup;

async function signIn(username, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)$/.test(u.pathname));
  return page;
}
const shot = async (page, name, fullPage = true) => { await page.waitForTimeout(900); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) {
    problems.push(`STEP FAILED: ${label}: ${e.message.replace(/\s+/g, ' ').slice(0, 1500)}`); console.log('FAIL', label);
    await sup?.screenshot({ path: `${SHOTS}/fail-sup-${label.replace(/[^a-z]+/gi, '-').slice(0, 40)}.png` }).catch(() => {});
  }
}

/** Calls the API from the page, as its signed-in user, with the CSRF token of that session. */
async function call(page, method, path, body, upload) {
  return page.evaluate(async ({ method, path, body, upload }) => {
    const s = await (await fetch('/api/auth/session')).json();
    const opts = { method, headers: { 'X-CSRF-Token': s.csrfToken } };
    if (upload) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v);
      const bytes = Uint8Array.from(atob(upload.base64), (c) => c.charCodeAt(0));
      fd.append('file', new Blob([bytes], { type: upload.type }), upload.name);
      opts.body = fd;
    } else if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`/api${path}`, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { method, path, body, upload });
}
/** Selects the option whose text contains the given text (options load from the server). */
async function pick(select, text) {
  const option = select.locator('option', { hasText: text }).first();
  await option.waitFor({ state: 'attached' });
  await select.selectOption(await option.getAttribute('value'));
}
const file = (name, type) => ({ base64: fs.readFileSync(`${FIX}/${name}`).toString('base64'), name, type });
const expectStatus = (r, s, what) => { if (r.status !== s) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

const gis = await signIn('gis.mo');
const proc = await signIn('proc.mo');
const proc2 = await signIn('proc2.mo');

/** A Montserrado first registration, prepared and submitted (as in the integration tests). */
async function submittedCase(geojson) {
  const cs = expectStatus(await call(gis, 'POST', '/cases', { caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-SUP-E2E' }), 201, 'create case');
  expectStatus(await call(gis, 'POST', `/cases/${cs.id}/geometry`, null, { ...file(geojson, 'application/geo+json'), fields: { crs: '4326' } }), 201, 'import geometry');
  const party = (await call(proc, 'GET', '/parties?q=Hawa')).body[0];
  expectStatus(await call(proc, 'POST', `/cases/${cs.id}/rights`, { partyId: party.id, rrrType: 'ownership' }), 201, 'right');
  const plan = expectStatus(await call(gis, 'POST', `/cases/${cs.id}/documents`, null, { ...file('synthetic_document.pdf', 'application/pdf'), fields: { docType: 'survey_plan', classification: 'restricted', referenceNo: 'SP-E2E' } }), 201, 'plan');
  const deed = expectStatus(await call(proc, 'POST', `/cases/${cs.id}/documents`, null, { ...file('synthetic_document.pdf', 'application/pdf'), fields: { docType: 'deed', classification: 'restricted', referenceNo: 'D-E2E' } }), 201, 'deed');
  expectStatus(await call(proc, 'POST', `/cases/${cs.id}/documents/${plan.id}/verify`, { status: 'verified', note: 'Checked against source' }), 200, 'verify plan');
  expectStatus(await call(proc2, 'POST', `/cases/${cs.id}/documents/${deed.id}/verify`, { status: 'verified', note: 'Checked against source' }), 200, 'verify deed');
  const sub = expectStatus(await call(gis, 'POST', `/cases/${cs.id}/submit`), 200, 'submit');
  if (sub.status !== 'under_review') throw new Error(`submission ended ${sub.status}`);
  return (await call(gis, 'GET', `/cases/${cs.id}`)).body.case;
}

let clean, overlap, other;
await check('setup: three submitted Montserrado cases (one overlapping a published parcel)', async () => {
  clean = await submittedCase('valid_parcel_4326.geojson');
  overlap = await submittedCase('overlap_published_4326.geojson');
  other = await submittedCase('valid_parcel_4326.geojson');
});

sup = await signIn('sup.mo');

await check('supervisor lands on their dashboard, scoped to Montserrado', async () => {
  await sup.getByRole('heading', { name: 'Supervisor Dashboard' }).waitFor();
  await sup.locator('.stat-card').nth(9).waitFor();
  const cards = await sup.locator('.stat-card').count();
  if (cards !== 10) throw new Error(`expected 10 KPI cards, saw ${cards}`);
  await sup.getByText('Scope: Montserrado').first().waitFor();
  const awaiting = await sup.locator('.stat-card', { hasText: 'Awaiting quality review' }).locator('.stat-value').innerText();
  if (Number(awaiting) < 3) throw new Error(`awaiting quality review shows ${awaiting}`);
  await sup.locator('.chart-grid .panel').nth(5).waitFor();
  await shot(sup, 'supervisor-dashboard');
});

await check('refresh reloads figures from the server', async () => {
  const [res] = await Promise.all([sup.waitForResponse((r) => r.url().includes('/api/supervision/dashboard/summary')), sup.getByRole('button', { name: /^Refresh/ }).click()]);
  if (res.status() !== 200) throw new Error(`refresh got ${res.status()}`);
});

await check('the KPI card opens the GIS review queue, already filtered', async () => {
  await sup.locator('.stat-card', { hasText: 'Awaiting quality review' }).click();
  await sup.waitForURL(/\/supervisor\/gis-review\?status=awaiting_review/);
  await sup.locator('tbody tr', { hasText: clean.case_no }).waitFor();
  await shot(sup, 'gis-review-queue');
});

await check('GIS review: map, validation summary and records, then accept', async () => {
  await sup.locator('tbody tr', { hasText: clean.case_no }).click();
  await sup.waitForURL(new RegExp(`/supervisor/gis-review/${clean.id}`));
  await sup.locator('.leaflet-container path.leaflet-interactive').first().waitFor();
  await sup.locator('.map-legend', { hasText: 'Submitted working data (not registered)' }).waitFor();
  await sup.getByRole('button', { name: 'Zoom to' }).first().click();
  await sup.getByRole('heading', { name: 'Record 1' }).waitFor();
  await shot(sup, 'gis-review-detail');
  await sup.getByRole('button', { name: 'Accept quality review' }).click();
  const dialog = sup.getByRole('dialog', { name: /Accept quality review/ });
  await dialog.getByLabel(/Reason/).fill('Geometry, attributes and documents checked');
  await dialog.getByRole('button', { name: 'Accept' }).click();
  await sup.locator('.toast', { hasText: 'Quality review accepted' }).waitFor();
  await sup.getByText('Accepted for current results').waitFor();
});

await check('return for correction: categories, records and reason reach the GIS officer', async () => {
  await sup.goto(`${BASE}/supervisor/gis-review/${other.id}`);
  await sup.getByRole('button', { name: 'Return for correction' }).click();
  const dialog = sup.getByRole('dialog', { name: /Return .* for correction/ });
  await dialog.getByRole('button', { name: 'Return for correction' }).click();
  await dialog.getByText('Select at least one issue category').waitFor();
  await dialog.getByLabel('Invalid or empty geometry').check();
  await dialog.getByLabel('Record 1', { exact: false }).first().check();
  await dialog.getByLabel(/^Reason/).fill('The boundary does not follow the survey plan');
  await dialog.getByLabel('Correction instructions').fill('Re-digitise from the approved plan');
  await shot(sup, 'return-dialog', false);
  await dialog.getByRole('button', { name: 'Return for correction' }).click();
  await sup.locator('.toast', { hasText: 'assigned to gis.mo' }).waitFor();
  await gis.goto(`${BASE}/work/tasks`);
  await gis.locator('tbody tr', { hasText: `Correct and resubmit ${other.case_no}` }).waitFor();
});

await check('spatial conflict: evidence on the map, investigation assigned, no way to dismiss it', async () => {
  await sup.goto(`${BASE}/supervisor/conflicts`);
  const row = sup.locator('tbody tr', { hasText: overlap.case_no }).filter({ hasText: 'Potential parcel overlap' }).first();
  await row.waitFor();
  await row.click();
  const drawer = sup.getByRole('dialog', { name: /Potential parcel overlap/ });
  await drawer.getByText('Measured intersection').waitFor();
  await drawer.locator('.leaflet-container').waitFor();
  if (await drawer.getByRole('button', { name: /resolve|dismiss/i }).count()) throw new Error('a resolve or dismiss button is offered');
  await drawer.getByRole('button', { name: 'Assign investigation' }).click();
  const dialog = sup.getByRole('dialog', { name: 'Assign an investigation' });
  await dialog.getByLabel('What should be checked?').fill('Compare with the 2019 survey register');
  await pick(dialog.getByLabel('Assign to'), '(gis.mo');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await sup.locator('.toast', { hasText: 'Task created' }).waitFor();
  await drawer.getByText('Under investigation').first().waitFor();
  await shot(sup, 'conflict-drawer', false);
  await sup.keyboard.press('Escape');
});

let taskNo;
await check('tasks: create, see it on the board, the assignee completes it', async () => {
  await sup.goto(`${BASE}/supervisor/tasks`);
  await sup.getByRole('button', { name: 'Create task' }).click();
  const dialog = sup.getByRole('dialog', { name: 'Create task' });
  await dialog.getByLabel('Task type').selectOption('document_review');
  await dialog.getByLabel('Title').fill('Check the deed scans received this week');
  await pick(dialog.getByLabel('Assign to'), '(proc.mo');
  await dialog.getByLabel('Priority').selectOption('high');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  const toast = sup.locator('.toast', { hasText: /Task TSK-\d+ created/ });
  await toast.waitFor();
  taskNo = (await toast.innerText()).match(/TSK-\d+/)[0];
  await sup.getByRole('button', { name: 'Board' }).click();
  await sup.locator('.kanban-col', { hasText: 'Assigned' }).locator('.kanban-card', { hasText: taskNo }).waitFor();
  await shot(sup, 'task-board');

  await proc.goto(`${BASE}/work/tasks`);
  await proc.locator('tbody tr', { hasText: taskNo }).click();
  await proc.getByRole('button', { name: 'Start / resume' }).click();
  await proc.getByRole('button', { name: 'Mark completed' }).click();
  await proc.getByRole('dialog', { name: /Mark completed/ }).getByLabel(/Reason/).fill('All five scans match the originals');
  await proc.getByRole('dialog', { name: /Mark completed/ }).getByRole('button', { name: 'Confirm' }).click();
  await proc.locator('.toast', { hasText: 'Task updated' }).waitFor();
  await sup.reload();
  await sup.locator('.kanban-col', { hasText: 'Completed' }).locator('.kanban-card', { hasText: taskNo }).waitFor();
});

await check('workload: officers listed with transparent counts', async () => {
  await sup.goto(`${BASE}/supervisor/workload`);
  await sup.getByText('not a measure of individual performance', { exact: false }).waitFor();
  await sup.locator('tbody tr', { hasText: 'proc.mo' }).first().waitFor();
});

await check('escalation: raised from the work queue, acknowledged by the registrar', async () => {
  await sup.goto(`${BASE}/supervisor/queue?q=${overlap.case_no}`);
  await sup.locator('tbody tr', { hasText: overlap.case_no }).click();
  const drawer = sup.getByRole('dialog', { name: overlap.case_no });
  await drawer.getByRole('button', { name: 'Escalate' }).click();
  const dialog = sup.getByRole('dialog', { name: 'Raise an escalation' });
  await dialog.getByLabel('Category').selectOption('spatial_conflict');
  await dialog.getByLabel('Severity').selectOption('high');
  await dialog.getByLabel('Title').fill('Overlap with a published parcel needs a registrar');
  await dialog.getByLabel(/What happened/).fill('The submitted boundary overlaps PROV-MO parcel by several square metres.');
  await dialog.getByRole('button', { name: 'Escalate' }).click();
  await sup.locator('.toast', { hasText: /sent to the county registrar/ }).waitFor();
  await sup.keyboard.press('Escape');

  const reg = await signIn('reg.mo');
  await reg.goto(`${BASE}/escalations`);
  await reg.locator('tbody tr', { hasText: 'Overlap with a published parcel' }).click();
  await reg.getByRole('button', { name: 'Acknowledge' }).click();
  await reg.getByRole('dialog', { name: /Acknowledge/ }).getByLabel(/Reason/).fill('Taking this over');
  await reg.getByRole('dialog', { name: /Acknowledge/ }).getByRole('button', { name: 'Acknowledge' }).click();
  await reg.locator('.toast', { hasText: 'Escalation acknowledged' }).waitFor();
  await reg.context().close();
});

await check('reports: generate with id and scope, and download the CSV', async () => {
  await sup.goto(`${BASE}/supervisor/reports?report=staff_workload`);
  await sup.getByRole('button', { name: 'Generate' }).click();
  await sup.getByText(/Report [0-9a-f-]{36}/).waitFor();
  await sup.getByText(/Scope: MO · period/).waitFor();
  const [download] = await Promise.all([sup.waitForEvent('download'), sup.getByRole('button', { name: /Download CSV/ }).click()]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  if (!text.startsWith('# Staff workload') || !/synthetic demonstration data/.test(text)) throw new Error('CSV metadata missing');
  await shot(sup, 'report');
});

await check('quality and compliance page renders its reports', async () => {
  await sup.goto(`${BASE}/supervisor/quality`);
  await sup.getByRole('heading', { name: 'Repeated data-quality issues' }).waitFor();
  await sup.getByRole('heading', { name: 'Supervisory review outcomes' }).waitFor();
});

await check('activity history shows the supervisory actions', async () => {
  await sup.goto(`${BASE}/supervisor/activity`);
  await sup.locator('tbody tr', { hasText: 'supervision.accept' }).first().waitFor();
  await sup.locator('tbody tr', { hasText: 'supervision.return' }).first().waitFor();
});

await check('a county supervisor cannot open national administration pages', async () => {
  await sup.goto(`${BASE}/admin`);
  await sup.getByRole('heading', { name: 'No access' }).waitFor();
  const nav = sup.getByRole('navigation', { name: 'Main navigation' });
  if (await nav.getByRole('link', { name: 'User Management' }).count()) throw new Error('User Management offered to a county supervisor');
});

await check('the registrar sees the quality review on the case before deciding', async () => {
  const reg = await signIn('reg.mo');
  const cs = (await call(reg, 'GET', `/cases/${clean.id}`)).body;
  if (!cs.qualityReview.acceptedForCurrentRun) throw new Error('acceptance not visible to the registrar');
  await reg.context().close();
});

await check('when review is required, the registrar sees why approval is unavailable', async () => {
  const admin = await signIn('admin');
  expectStatus(await call(admin, 'PUT', '/admin/settings/workflow.supervisor_review', { value: 'required', reason: 'Walkthrough of the review gate' }), 200, 'set required');
  const reg = await signIn('reg.mo');
  try {
    await reg.goto(`${BASE}/work/cases/${overlap.id}`);
    await reg.getByRole('heading', { name: 'Supervisory quality review' }).waitFor();
    await reg.getByText('Approval is unavailable until a supervisor accepts').waitFor();
    if (!(await reg.getByRole('radio', { name: 'Approve' }).isDisabled())) throw new Error('Approve is selectable without a quality acceptance');
    await shot(reg, 'registrar-review-gate');
    await reg.goto(`${BASE}/work/cases/${clean.id}`);
    await reg.getByText(/Quality accepted by sup\.mo/).waitFor();
    if (await reg.getByRole('radio', { name: 'Approve' }).isDisabled()) throw new Error('Approve blocked although the submission was accepted');
  } finally {
    expectStatus(await call(admin, 'PUT', '/admin/settings/workflow.supervisor_review', { value: 'optional', reason: 'Back to the default' }), 200, 'reset optional');
    await reg.context().close();
    await admin.context().close();
  }
});

await check('mobile: dashboard fits a phone', async () => {
  const phone = await signIn('sup.mo', { width: 390, height: 844 });
  await phone.getByRole('heading', { name: 'Supervisor Dashboard' }).waitFor();
  await phone.waitForTimeout(800);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`page is ${overflow}px wider than the phone`);
  await shot(phone, 'supervisor-mobile', false);
  await phone.context().close();
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
