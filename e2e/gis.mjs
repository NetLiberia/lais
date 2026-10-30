// Browser walkthrough of the GIS Officer phase: dashboard, import wizard (shapefile with no .prj), jobs,
// workspace map, validation center, versions and corrections, submission, returns, ArcMap sync tokens,
// conflict investigation, tasks, reports and the administrator's rule configuration. Preparation that is
// not under test (documents, rights, the supervisor's return) goes through the API in each user's session.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';

const problems = [];
let step = 200;
const browser = await chromium.launch({ executablePath: BROWSER });
let gis;

async function signIn(username, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (400|401|403|404|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
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
    await gis?.screenshot({ path: `${SHOTS}/fail-gis-${label.replace(/[^a-z]+/gi, '-').slice(0, 40)}.png` }).catch(() => {});
  }
}
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
async function pick(select, text) {
  const option = select.locator('option', { hasText: text }).first();
  await option.waitFor({ state: 'attached' });
  await select.selectOption(await option.getAttribute('value'));
}
const file = (name, type) => ({ base64: fs.readFileSync(`${FIX}/${name}`).toString('base64'), name, type });
const expectStatus = (r, s, what) => { if (r.status !== s) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const caseNo = async (page, id) => (await call(page, 'GET', `/cases/${id}`)).body.case.case_no;

gis = await signIn('gis.mo');
const proc = await signIn('proc.mo');
const proc2 = await signIn('proc2.mo');

let migrationId, migrationNo, regId, regNo, overlapId;
await check('setup: a migration case, a prepared registration, and an overlapping registration', async () => {
  migrationId = expectStatus(await call(gis, 'POST', '/cases', { caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-GIS-E2E-REGISTER' }), 201, 'migration').id;
  migrationNo = await caseNo(gis, migrationId);
  for (const [geo, assign] of [['valid_parcel_4326.geojson', (id) => { regId = id; }], ['overlap_published_4326.geojson', (id) => { overlapId = id; }]]) {
    const cs = expectStatus(await call(gis, 'POST', '/cases', { caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-GIS-E2E' }), 201, 'case');
    assign(cs.id);
    expectStatus(await call(gis, 'POST', `/cases/${cs.id}/geometry`, null, { ...file(geo, 'application/geo+json'), fields: { crs: '4326' } }), 201, 'geometry');
    const party = (await call(proc, 'GET', '/parties?q=Hawa')).body[0];
    expectStatus(await call(proc, 'POST', `/cases/${cs.id}/rights`, { partyId: party.id, rrrType: 'ownership' }), 201, 'right');
    const plan = expectStatus(await call(gis, 'POST', `/cases/${cs.id}/documents`, null, { ...file('synthetic_document.pdf', 'application/pdf'), fields: { docType: 'survey_plan', classification: 'restricted', referenceNo: 'SP-GIS' } }), 201, 'plan');
    const deed = expectStatus(await call(proc, 'POST', `/cases/${cs.id}/documents`, null, { ...file('synthetic_document.pdf', 'application/pdf'), fields: { docType: 'deed', classification: 'restricted', referenceNo: 'D-GIS' } }), 201, 'deed');
    expectStatus(await call(proc, 'POST', `/cases/${cs.id}/documents/${plan.id}/verify`, { status: 'verified', note: 'Checked against source' }), 200, 'verify');
    expectStatus(await call(proc2, 'POST', `/cases/${cs.id}/documents/${deed.id}/verify`, { status: 'verified', note: 'Checked against source' }), 200, 'verify');
  }
  regNo = await caseNo(gis, regId);
  expectStatus(await call(gis, 'POST', `/cases/${overlapId}/validate`), 200, 'validate overlap');
});

await check('the GIS officer lands on their dashboard with twelve indicators', async () => {
  await gis.goto(`${BASE}/start`);
  await gis.waitForURL(/\/gis$/);
  await gis.getByRole('heading', { name: 'GIS Officer Dashboard' }).waitFor();
  await gis.locator('.stat-card').nth(11).waitFor();
  const n = await gis.locator('.stat-card').count();
  if (n !== 12) throw new Error(`expected 12 KPI cards, saw ${n}`);
  await gis.locator('.sync-indicator', { hasText: 'not configured' }).first().waitFor();
  await shot(gis, 'gis-dashboard');
});

await check('import wizard: a shapefile without .prj needs a declared CRS and a reason', async () => {
  await gis.goto(`${BASE}/gis/import`);
  await gis.locator('input[type=file]').setInputFiles(`${FIX}/gis/synthetic_parcels_noprj_shp.zip`);
  await gis.getByRole('button', { name: 'Upload and inspect' }).click();
  await gis.getByText(/no \.prj file/).waitFor();
  await gis.getByText('PARCEL_NO').first().waitFor();
  await shot(gis, 'import-inspect');
  await gis.getByRole('button', { name: 'Next' }).click();
  await pick(gis.getByLabel('Case', { exact: true }), migrationNo);
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByLabel('Source for legacy_ref').selectOption('PARCEL_NO');
  await gis.getByLabel('Source for land_category').selectOption('CATEGORY');
  await gis.getByLabel('Source for land_use').selectOption('LANDUSE');
  await shot(gis, 'import-mapping');
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByText('LAIS will not guess').waitFor();
  if (!(await gis.getByRole('button', { name: 'Preview' }).isDisabled())) throw new Error('Preview allowed before the CRS was declared');
  await gis.getByLabel('Declared coordinate system').selectOption('4326');
  await gis.getByLabel(/How the coordinate system was established/).fill('Export settings of the synthetic survey geodatabase: WGS 84 geographic');
  await gis.getByLabel(/I confirm the coordinate system/).check();
  await shot(gis, 'import-crs');
  await gis.getByRole('button', { name: 'Preview' }).click();
  await gis.getByRole('heading', { name: /6\. Preview/ }).waitFor();
  await gis.locator('.stat-card', { hasText: 'Accepted' }).locator('.stat-value', { hasText: '3' }).waitFor();
  await gis.locator('.leaflet-container path.leaflet-interactive').first().waitFor();
  await shot(gis, 'import-preview');
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByRole('button', { name: 'Confirm import' }).click();
  await gis.getByText(/Staged as version 1/).waitFor({ timeout: 30_000 });
  await shot(gis, 'import-result');
});

await check('processing jobs: the import, its CRS declaration and diagnostic', async () => {
  await gis.getByRole('link', { name: 'Open job' }).click();
  await gis.waitForURL(/\/gis\/jobs\?job=/);
  const drawer = gis.locator('.drawer');
  await drawer.getByText(/declared: Export settings/).waitFor();
  await drawer.getByText('Diagnostic').waitFor();
  await shot(gis, 'job-detail', false);
  const [download] = await Promise.all([gis.waitForEvent('download'), drawer.getByRole('button', { name: /Error report/ }).click()]);
  if (!/report\.csv$/.test(download.suggestedFilename())) throw new Error(`downloaded ${download.suggestedFilename()}`);
});

await check('parcel workspace: layers, legend, coordinates, scale and search', async () => {
  await gis.goto(`${BASE}/gis/workspace`);
  await gis.locator('.leaflet-container path.leaflet-interactive').first().waitFor();
  await gis.locator('.map-legend', { hasText: 'Approved reference parcels' }).waitFor();
  await gis.locator('.map-legend', { hasText: 'Working staging data (not registered)' }).waitFor();
  await gis.locator('.leaflet-control-scale').waitFor();
  const box = await gis.locator('.leaflet-container').boundingBox();
  await gis.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await gis.locator('.map-coords', { hasText: 'UTM 29N' }).waitFor();
  await gis.getByLabel('Find parcel or case').fill('PROV-MO-000001');
  await gis.getByRole('button', { name: 'Find' }).click();
  await gis.waitForTimeout(1200);
  await shot(gis, 'workspace-map', false);
});

await check('validation center: findings for the migration batch, zoom and re-run', async () => {
  await gis.goto(`${BASE}/gis/validation`);
  await pick(gis.getByLabel('Case', { exact: true }), migrationNo);
  await gis.getByRole('button', { name: 'Re-run validation' }).click();
  await gis.locator('.toast', { hasText: 'Validation re-run' }).waitFor();
  await gis.locator('tbody tr').first().waitFor();
  await gis.getByRole('button', { name: 'Zoom' }).first().click();
  await shot(gis, 'validation-center');
});

await check('versions: an attribute correction creates version 2; the comparison shows it', async () => {
  await gis.goto(`${BASE}/gis/versions?case=${migrationId}`);
  await gis.getByRole('button', { name: 'Correct attributes' }).click();
  const dialog = gis.getByRole('dialog', { name: /Correct attributes/ });
  await dialog.getByLabel('Attribute').fill('land_use');
  await dialog.getByLabel('New value').fill('agriculture');
  await dialog.getByLabel(/Reason for the correction/).fill('Land use confirmed by the field team');
  await dialog.getByRole('button', { name: 'Create new version' }).click();
  await gis.locator('.toast', { hasText: 'Version 2 created' }).waitFor();
  await gis.getByText(/1 modified/).waitFor();
  await gis.locator('tr.changed', { hasText: 'land_use' }).waitFor();
  await shot(gis, 'versions-compare');
});

await check('import wizard: a GeoPackage states its own CRS (UTM 29N) and imports as version 3', async () => {
  await gis.goto(`${BASE}/gis/import`);
  await gis.locator('input[type=file]').setInputFiles(`${FIX}/gis/synthetic_parcels_utm29n.gpkg`);
  await gis.getByRole('button', { name: 'Upload and inspect' }).click();
  await gis.locator('option', { hasText: 'parcels_utm29n (3 features, MULTIPOLYGON)' }).waitFor({ state: 'attached' });
  await gis.locator('.badge-pill', { hasText: 'geopackage' }).waitFor();
  await gis.getByRole('cell', { name: 'PARCEL_NO' }).waitFor();
  await gis.getByRole('button', { name: 'Next' }).click();
  await pick(gis.getByLabel('Case', { exact: true }), migrationNo);
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByLabel('Source for legacy_ref').selectOption('PARCEL_NO');
  await gis.getByLabel('Source for land_category').selectOption('CATEGORY');
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByText(/The file states/).waitFor();
  await gis.getByText('EPSG:32629', { exact: true }).waitFor();
  if (await gis.getByLabel('Declared coordinate system').count()) throw new Error('a CRS declaration was asked for although the file states one');
  await gis.getByLabel(/I confirm the coordinate system/).check();
  await shot(gis, 'import-gpkg-crs');
  await gis.getByRole('button', { name: 'Preview' }).click();
  await gis.getByRole('button', { name: 'Next' }).click();
  await gis.getByRole('button', { name: 'Confirm import' }).click();
  await gis.getByText(/Staged as version 3/).waitFor({ timeout: 30_000 });
});

await check('submit to supervisor: checklist, acknowledgement and snapshot', async () => {
  await gis.goto(`${BASE}/gis/submit?case=${regId}`);
  await gis.getByText('No blocking validation errors').waitFor();
  await gis.getByLabel(/Summary for the supervisor/).fill('Parcel prepared from the synthetic field survey');
  const ack = gis.getByLabel(/I have reviewed these warnings/);
  if (await ack.count()) await ack.check();
  await gis.getByLabel(/I confirm the checklist/).check();
  await shot(gis, 'submit-checklist');
  await gis.getByRole('button', { name: 'Submit to supervisor' }).click();
  await gis.waitForURL(/\/gis\/submissions/);
  await gis.locator('tbody tr', { hasText: regNo }).getByText('Awaiting supervisor review').waitFor();
  await gis.locator('tbody tr', { hasText: regNo }).click();
  await gis.getByText(/Snapshot intact/).waitFor();
  await shot(gis, 'submission-detail', false);
});

await check('a supervisor return appears on Returned Submissions with its instructions', async () => {
  const sup = await signIn('sup.mo');
  try {
    expectStatus(await call(sup, 'POST', `/supervision/cases/${regId}/return`, { reason: 'Check the east boundary against the plan', issueCategories: ['geometry_invalid'], instructions: 'Re-digitise the east edge' }), 201, 'return');
  } finally { await sup.context().close(); }
  await gis.goto(`${BASE}/gis/returned`);
  await gis.locator('.panel', { hasText: regNo }).getByText('Re-digitise the east edge').waitFor();
  await shot(gis, 'returned');
});

let token;
await check('ArcMap sync: create a token (shown once), observe contact, revoke', async () => {
  await gis.goto(`${BASE}/gis/sync`);
  await gis.getByText(/No active sync token|No tokens yet/).first().waitFor();
  await gis.getByLabel('Label').fill('E2E ArcMap workstation');
  await gis.getByRole('button', { name: 'Create token' }).click();
  const modal = gis.getByRole('dialog', { name: 'Your new sync token' });
  token = (await modal.locator('.copy-value').innerText()).trim();
  if (!token.startsWith('lais_sync_')) throw new Error('no token shown');
  await shot(gis, 'sync-token', false);
  await modal.getByRole('button', { name: 'I have stored it' }).click();
  // The adapter's connection test, as ArcMap would make it (bearer token, no cookie).
  const r = await fetch(`${BASE}/api/gis/arcmap/ping`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`ping ${r.status}`);
  await gis.reload();
  await gis.getByText(/This is the last observed contact, not a live connection/).waitFor();
  await gis.getByRole('button', { name: 'Run diagnostic' }).click();
  await gis.getByText('Adapter has contacted the server', { exact: true }).waitFor();
  await shot(gis, 'sync-status');
  await gis.getByRole('button', { name: 'Revoke' }).click();
  await gis.locator('.toast', { hasText: 'Token revoked' }).waitFor();
  const after = await fetch(`${BASE}/api/gis/arcmap/ping`, { headers: { Authorization: `Bearer ${token}` } });
  if (after.status !== 401) throw new Error(`revoked token still answered ${after.status}`);
});

await check('conflict investigation: note and findings, no resolve button', async () => {
  await gis.goto(`${BASE}/gis/conflicts`);
  await gis.locator('tbody tr').first().click();
  const drawer = gis.locator('.drawer');
  await drawer.locator('.leaflet-container').waitFor();
  await drawer.getByLabel('Investigation note').fill('Compared with the synthetic survey plan: the east edge overlaps by digitising error.');
  await drawer.getByRole('button', { name: 'Submit findings' }).click();
  await gis.locator('.toast', { hasText: 'Findings submitted' }).waitFor();
  await drawer.getByText('findings submitted').waitFor();
  if (await drawer.getByRole('button', { name: /resolve/i }).count()) throw new Error('a resolve action is offered to the GIS officer');
  await shot(gis, 'conflict-investigation', false);
});

await check('tasks: acknowledge, begin, and completion refused until the case is submitted', async () => {
  const sup = await signIn('sup.mo');
  const me = (await call(gis, 'GET', '/auth/session')).body.user.id;
  try {
    expectStatus(await call(sup, 'POST', '/tasks', { taskType: 'gis_preparation', title: 'Prepare the migration batch', countyId: 1, caseId: migrationId, assigneeId: me }), 201, 'task');
  } finally { await sup.context().close(); }
  await gis.goto(`${BASE}/gis/tasks`);
  const row = gis.locator('tbody tr', { hasText: 'Prepare the migration batch' });
  await row.getByRole('button', { name: 'Acknowledge' }).click();
  await row.getByText(/Acknowledged/).waitFor();
  await row.getByRole('button', { name: 'Begin' }).click();
  await row.getByText('in progress').waitFor();
  await row.getByRole('button', { name: 'Complete' }).click();
  const dialog = gis.getByRole('dialog', { name: /Complete task/ });
  await dialog.getByLabel('What was done').fill('Batch imported and corrected');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.getByText(/has not been submitted/).waitFor();
  await shot(gis, 'task-complete-refused', false);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await check('GIS reports: on screen and as CSV and PDF', async () => {
  await gis.goto(`${BASE}/gis/reports`);
  await gis.getByLabel('Report').selectOption('import_jobs');
  await gis.locator('tbody tr').first().waitFor();
  const [csv] = await Promise.all([gis.waitForEvent('download'), gis.getByRole('button', { name: 'CSV' }).click()]);
  const [pdf] = await Promise.all([gis.waitForEvent('download'), gis.getByRole('button', { name: 'PDF' }).click()]);
  if (!csv.suggestedFilename().endsWith('.csv') || !pdf.suggestedFilename().endsWith('.pdf')) throw new Error('downloads misnamed');
  const head = fs.readFileSync(await pdf.path()).subarray(0, 5).toString();
  if (head !== '%PDF-') throw new Error(`PDF starts with ${head}`);
  await shot(gis, 'gis-reports');
});

await check('administrator: change a configurable rule with a reason; safety rules are fixed', async () => {
  const admin = await signIn('admin');
  try {
    await admin.goto(`${BASE}/gis/validation/rules`);
    const row = admin.locator('tbody tr', { hasText: 'MULTIPART_GEOMETRY' });
    await row.getByRole('button', { name: 'Make blocking' }).click();
    const dialog = admin.getByRole('dialog', { name: /Change MULTIPART_GEOMETRY/ });
    await dialog.getByLabel(/Reason/).fill('Multipart parcels must be split before submission');
    await dialog.getByRole('button', { name: /Save new rule-set version/ }).click();
    await admin.locator('.toast', { hasText: 'MULTIPART_GEOMETRY is now blocking' }).waitFor();
    if (await admin.locator('tbody tr', { hasText: 'GEOMETRY_INVALID' }).getByRole('button').count()) throw new Error('a safety rule can be changed');
    await admin.locator('table', { hasText: 'Reason' }).getByText('Multipart parcels must be split').waitFor();
    await shot(admin, 'validation-rules');
    await row.getByRole('button', { name: 'Make warning' }).click();
    await admin.getByRole('dialog').getByLabel(/Reason/).fill('Back to the default for the walkthrough');
    await admin.getByRole('dialog').getByRole('button', { name: /Save new rule-set version/ }).click();
    await admin.locator('.toast', { hasText: 'a warning' }).waitFor();
  } finally { await admin.context().close(); }
});

await check('mobile: GIS dashboard fits a phone', async () => {
  const phone = await signIn('gis.mo', { width: 390, height: 844 });
  await phone.getByRole('heading', { name: 'GIS Officer Dashboard' }).waitFor();
  await phone.waitForTimeout(800);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`page is ${overflow}px wider than the phone`);
  await shot(phone, 'gis-mobile', false);
  await phone.context().close();
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
