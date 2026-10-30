// Browser walkthrough of the LAIS Processor phase: dashboard, the registration wizard (new applicant,
// declared parcel, documents), document review by a second processor, an information request recorded but
// not sent, a supervisor's exception and the GIS handoff, a GIS clarification answered from the queue,
// applicant correction with history, a new document version, reports, decision tracking, the
// administrator's category configuration, and the dashboard on a phone.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE, BROWSER, FIX, PASSWORD, SHOTS } from './config.mjs';

const problems = [];
let step = 300;
const browser = await chromium.launch({ executablePath: BROWSER });
let proc;

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
const shot = async (page, name, fullPage = true) => { await page.waitForTimeout(800); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) {
    problems.push(`STEP FAILED: ${label}: ${e.message.replace(/\s+/g, ' ').slice(0, 1500)}`); console.log('FAIL', label);
    await proc?.screenshot({ path: `${SHOTS}/fail-proc-${label.replace(/[^a-z]+/gi, '-').slice(0, 40)}.png` }).catch(() => {});
  }
}
async function call(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const s = await (await fetch('/api/auth/session')).json();
    const opts = { method, headers: { 'X-CSRF-Token': s.csrfToken } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`/api${path}`, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { method, path, body });
}
const expectStatus = (r, s, what) => { if (r.status !== s) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const pdf = (n) => { const p = `${SHOTS}/../synthetic-${n}.pdf`; fs.writeFileSync(p, Buffer.concat([fs.readFileSync(`${FIX}/synthetic_document.pdf`), Buffer.from(`\n% e2e ${n}\n`)])); return p; };

proc = await signIn('proc.mo');
let appId, caseNo;

await check('the processor lands on the Processor Dashboard with twelve indicators', async () => {
  await proc.goto(`${BASE}/start`);
  await proc.waitForURL(/\/processor$/);
  await proc.getByRole('heading', { name: 'LAIS Processor Dashboard' }).waitFor();
  await proc.locator('.stat-card').nth(11).waitFor();
  const n = await proc.locator('button.stat-card').count();
  if (n !== 12) throw new Error(`expected 12 KPI cards, saw ${n}`);
  await shot(proc, 'processor-dashboard');
});

await check('registration wizard: applicant, application, declared parcel, then a draft', async () => {
  await proc.getByRole('link', { name: 'New application' }).first().click();
  await proc.waitForURL(/\/processor\/new/);
  await proc.getByLabel('Full name or registered name (required)').fill('Josephine Testapplicant');
  await proc.getByLabel('Telephone (optional)').fill('+231 770 555 010');
  await proc.getByLabel('Identification document type (only if the process requires it)').selectOption('voter_card');
  await proc.getByLabel('Identification reference (restricted)').fill('SYN-VC-4410');
  await shot(proc, 'wizard-applicant');
  await proc.getByRole('button', { name: 'Next' }).click();
  await proc.getByLabel('Application category (required)').selectOption('first_registration');
  await proc.getByLabel('Land category (if known)').selectOption('private');
  await proc.getByLabel(/^Purpose of the application/).fill('Register a residential plot bought in 2019');
  await proc.getByLabel(/^Office receipt number/).fill('MO/E2E/0001');
  await proc.getByRole('button', { name: 'Next' }).click();
  await proc.getByText(/stays unverified/).waitFor();
  await proc.getByLabel(/^Declared parcel identifier/).fill('DECL-E2E-01');
  await proc.getByLabel(/^Community or locality/).fill('Synthetic Town');
  await proc.getByLabel(/^Declared size/).fill('0.18');
  await proc.getByLabel(/^Existing survey reference/).fill('SYN-SURVEY-E2E');
  await proc.getByLabel(/^Location description/).fill('Two plots east of the synthetic market road');
  await shot(proc, 'wizard-parcel');
  await proc.getByRole('button', { name: 'Save draft and continue' }).click();
  await proc.locator('.toast', { hasText: /saved as a draft/ }).waitFor();
  caseNo = (await proc.locator('.toast', { hasText: /saved as a draft/ }).innerText()).match(/CASE-\d{4}-\d{6}/)[0];
});

await check('wizard: upload documents with drag-and-drop area, then register', async () => {
  for (const [type, label] of [['survey_plan', 'Survey plan'], ['deed', 'Deed'], ['id_document', 'Identity document']]) {
    await proc.getByRole('button', { name: 'Upload a document' }).click();
    const dialog = proc.getByRole('dialog', { name: 'Upload a document' });
    await dialog.getByTestId('doc-file').setInputFiles(pdf(type));
    await dialog.getByLabel('Document category').selectOption(type);
    await dialog.getByLabel('Title (optional)').fill(`${label} of Josephine Testapplicant`);
    await dialog.getByRole('button', { name: /^Upload/ }).click();
    await proc.locator('.toast', { hasText: 'uploaded' }).last().waitFor();
    await dialog.waitFor({ state: 'detached' });
  }
  await proc.locator('tbody tr').nth(2).waitFor();
  await shot(proc, 'wizard-documents');
  await proc.getByRole('button', { name: 'Next' }).click();
  await proc.getByText('Needed before GIS processing').waitFor();
  for (const l of [/county .* is correct/, /category .* is correct/, /checked the uploaded documents/]) await proc.getByLabel(l).check();
  await shot(proc, 'wizard-review');
  await proc.getByRole('button', { name: 'Register application' }).click();
  await proc.waitForURL(/\/processor\/applications\/[0-9a-f-]{36}/);
  appId = proc.url().split('/').pop().split('?')[0];
  await proc.getByRole('heading', { name: caseNo }).waitFor();
  await proc.getByText('Document review').first().waitFor();
});

await check('workspace: provenance is labelled and the completeness checklist shows documents awaiting review', async () => {
  await proc.getByRole('tab', { name: 'Declared parcel' }).click();
  await proc.getByText('Provided by the applicant').waitFor();
  await proc.getByText(/Declared by the applicant and unverified/).waitFor();
  await proc.getByRole('tab', { name: 'Completeness' }).click();
  await proc.getByText('Received, awaiting review').first().waitFor();
  await shot(proc, 'workspace-completeness');
});

const proc2 = await signIn('proc2.mo');
await check('a second processor reviews the documents (the uploader cannot)', async () => {
  const docs = expectStatus(await call(proc, 'GET', `/applications/${appId}`), 200, 'workspace').documents;
  const own = await call(proc, 'POST', `/documents/${docs[0].id}/review`, { status: 'accepted' });
  if (own.status !== 403) throw new Error(`uploader review answered ${own.status}`);
  await proc2.goto(`${BASE}/processor/verification`);
  await proc2.locator('tbody tr', { hasText: caseNo }).first().waitFor();
  for (let i = 0; i < 3; i++) {
    await proc2.locator('tbody tr', { hasText: caseNo }).first().click();
    const drawer = proc2.locator('.drawer');
    await drawer.getByRole('button', { name: 'Preview' }).click();
    await drawer.locator('iframe.doc-preview').waitFor();
    if (i === 0) await shot(proc2, 'document-preview', false);
    for (const l of ['Readable', 'Required pages present', 'Required information present', 'Details match the application']) await drawer.getByRole('checkbox', { name: l, exact: true }).check();
    await drawer.getByLabel('Outcome').selectOption('accepted');
    await drawer.getByRole('button', { name: 'Record review' }).click();
    await proc2.locator('.toast', { hasText: 'Review recorded' }).last().waitFor();
    await drawer.getByRole('button', { name: /close/i }).first().click();
  }
  await proc2.getByText('Nothing awaiting review').waitFor();
});

await check('an e-mail information request is recorded as NOT sent; the response is recorded and satisfied', async () => {
  await proc.goto(`${BASE}/processor/applications/${appId}?tab=requests`);
  await proc.getByRole('button', { name: 'New request' }).click();
  const dialog = proc.getByRole('dialog', { name: 'Request additional information' });
  await dialog.getByLabel('Request category').selectOption('clarification');
  await dialog.getByLabel('Communication channel').selectOption('email');
  await dialog.getByText(/nothing is sent/).waitFor();
  await dialog.getByLabel('What is missing').fill('Date of purchase');
  await dialog.getByLabel('Explanation for the applicant').fill('Please confirm the date the plot was bought.');
  await dialog.getByRole('button', { name: 'Record request' }).click();
  await proc.locator('.toast', { hasText: /no e-mail\/SMS provider/ }).waitFor();
  await proc.locator('tbody tr', { hasText: 'Date of purchase' }).click();
  const drawer = proc.locator('.drawer');
  await drawer.getByLabel('Note').fill('Applicant confirmed 12 March 2019 by phone');
  await drawer.getByLabel('Received by').selectOption('phone');
  await drawer.getByRole('button', { name: 'Record response' }).click();
  await proc.locator('.toast', { hasText: 'Response recorded' }).waitFor();
  await drawer.getByRole('button', { name: 'Satisfied', exact: true }).click();
  await proc.locator('.toast', { hasText: 'Marked satisfied' }).waitFor();
  await shot(proc, 'info-request', false);
  await drawer.getByRole('button', { name: /close/i }).first().click();
});

let taskNo;
await check('GIS handoff from the workspace creates a GIS task for the county queue', async () => {
  await proc.goto(`${BASE}/processor/applications/${appId}?tab=gis`);
  await proc.getByText('No GIS task already open').waitFor();
  await proc.getByLabel('Processing instructions').fill('Digitise the plot from the accepted survey plan SYN-SURVEY-E2E.');
  await proc.locator('.check-grid label', { hasText: 'Survey plan' }).locator('input').check();
  await shot(proc, 'handoff');
  await proc.getByRole('button', { name: 'Hand off to GIS' }).click();
  const toast = proc.locator('.toast', { hasText: /GIS task TSK-/ });
  await toast.waitFor();
  taskNo = (await toast.innerText()).match(/TSK-\d+/)[0];
  await proc.getByText('county queue').first().waitFor();
});

await check('a GIS officer asks for clarification; the processor answers from the GIS queue', async () => {
  const gis = await signIn('gis.mo');
  try {
    const tasks = expectStatus(await call(gis, 'GET', '/gis/tasks'), 200, 'gis tasks');
    const t = tasks.claimable.find((x) => x.task_no === taskNo);
    if (!t) throw new Error(`${taskNo} is not claimable by gis.mo`);
    expectStatus(await call(gis, 'POST', `/tasks/${t.id}/claim`), 200, 'claim');
    expectStatus(await call(gis, 'POST', `/tasks/${t.id}/clarification`, { question: 'Is the eastern boundary the road edge or the drain?' }), 201, 'clarify');
  } finally { await gis.context().close(); }
  await proc.goto(`${BASE}/processor/returned`);
  await proc.getByText('Is the eastern boundary the road edge or the drain?').waitFor();
  await shot(proc, 'returned');
  await proc.goto(`${BASE}/processor/gis-queue`);
  await proc.getByRole('button', { name: 'Answer' }).click();
  await proc.getByRole('textbox', { name: 'Answer' }).fill('The drain, per the survey plan sheet 2');
  await proc.getByRole('button', { name: 'Send answer' }).click();
  await proc.locator('.toast', { hasText: 'Answer sent' }).waitFor();
  await proc.goto(`${BASE}/processor/returned`);
  await proc.getByText('Nothing returned').waitFor();
});

await check('applicant correction keeps the previous value with a reason', async () => {
  await proc.goto(`${BASE}/processor/applicants`);
  await proc.getByRole('textbox', { name: 'Search', exact: true }).fill('Josephine');
  await proc.getByRole('button', { name: 'Search' }).click();
  await proc.locator('tbody tr', { hasText: 'Josephine Testapplicant' }).click();
  const drawer = proc.locator('.drawer');
  await drawer.getByRole('button', { name: 'Update details' }).click();
  await drawer.getByLabel(/^Name/).fill('Josephine K. Testapplicant');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await drawer.getByText(/give the reason/).waitFor();
  await drawer.getByLabel(/^Reason/).fill('Middle initial added from the voter card');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await proc.locator('.toast', { hasText: 'previous values are kept' }).waitFor();
  await drawer.locator('table', { hasText: 'Previous' }).getByText('Josephine Testapplicant', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: /Reveal reference/ }).click();
  await drawer.getByText('SYN-VC-4410').waitFor();
  await shot(proc, 'applicant-history', false);
});

await check('replacing a document creates version 2 and keeps version 1 as superseded', async () => {
  await proc.goto(`${BASE}/processor/documents?q=${caseNo}&category=deed`);
  await proc.locator('tbody tr', { hasText: caseNo }).first().click();
  const drawer = proc.locator('.drawer');
  await drawer.getByRole('button', { name: 'Upload a new version' }).click();
  const dialog = proc.getByRole('dialog', { name: /Replace DOC-/ });
  await dialog.getByTestId('doc-file').setInputFiles(pdf('deed-v2'));
  await dialog.getByLabel('Reason for replacing (required)').fill('Signed copy received at the counter');
  await dialog.getByRole('button', { name: /^Upload/ }).click();
  await proc.locator('.toast', { hasText: '(version 2) replaces' }).waitFor();
  await proc.goto(`${BASE}/processor/documents?q=${caseNo}&category=deed&all=1`);
  await proc.locator('tbody tr').nth(1).waitFor();
  await proc.locator('tbody tr', { hasText: 'Superseded' }).waitFor();
  await shot(proc, 'document-versions');
});

await check('workflow timeline is generated from stored events of every part of the process', async () => {
  await proc.goto(`${BASE}/processor/applications/${appId}?tab=timeline`);
  for (const t of ['Application', 'Document review', 'Information request', 'GIS processing']) await proc.locator('.workflow-timeline .badge-pill', { hasText: t }).first().waitFor();
  await shot(proc, 'timeline');
});

await check('reports and analytics, with CSV and PDF downloads', async () => {
  await proc.goto(`${BASE}/processor/reports`);
  await proc.getByText('Applications registered over time').waitFor();
  await proc.getByLabel('Report').selectOption('handoffs');
  await proc.locator('table.small tbody tr').first().waitFor();
  const [csv] = await Promise.all([proc.waitForEvent('download'), proc.getByRole('button', { name: 'CSV' }).click()]);
  const [pdfFile] = await Promise.all([proc.waitForEvent('download'), proc.getByRole('button', { name: 'PDF' }).click()]);
  if (!csv.suggestedFilename().endsWith('.csv') || !pdfFile.suggestedFilename().endsWith('.pdf')) throw new Error('bad download names');
  const text = fs.readFileSync(await csv.path(), 'utf8');
  if (/Josephine|770 555/.test(text)) throw new Error('personal data in the report');
  await shot(proc, 'processor-reports');
});

await check('decision tracking is read-only and shows the registrar\'s records only', async () => {
  await proc.goto(`${BASE}/processor/decisions`);
  await proc.getByText(/Read-only/).waitFor();
  if (await proc.getByRole('button', { name: /approve|reject/i }).count()) throw new Error('decision controls shown to a processor');
});

await check('administrator configures a category requirement with a reason', async () => {
  const admin = await signIn('admin');
  try {
    await admin.goto(`${BASE}/admin/application-config`);
    await admin.getByText('Working defaults, not a statutory checklist', { exact: false }).waitFor();
    await admin.getByRole('row', { name: /Customary land certificate/ }).getByRole('button', { name: 'Make required' }).click();
    await admin.getByRole('dialog').getByLabel(/Reason/).fill('Customary claims need the certificate');
    await admin.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await admin.locator('.toast', { hasText: 'Requirement updated' }).waitFor();
    await admin.locator('table', { hasText: 'Reason' }).getByText('Customary claims need the certificate').waitFor();
    await shot(admin, 'application-config');
  } finally { await admin.context().close(); }
});

await check('mobile: processor dashboard fits a phone', async () => {
  const phone = await signIn('proc.mo', { width: 390, height: 844 });
  await phone.getByRole('heading', { name: 'LAIS Processor Dashboard' }).waitFor();
  await phone.waitForTimeout(900);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`page is ${overflow}px wider than the phone`);
  await shot(phone, 'processor-mobile', false);
  await phone.context().close();
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
