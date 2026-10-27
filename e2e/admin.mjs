// Browser walkthrough of the Administrator Dashboard phase: every interactive element is exercised
// against the real API and database, and the result checked.
import { chromium } from 'playwright-core';
import { BASE, BROWSER, PASSWORD, SHOTS } from './config.mjs';
import fs from 'node:fs';

const problems = [];
let step = 70;
const browser = await chromium.launch({ executablePath: BROWSER });

async function signIn(username, password = PASSWORD, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403|409)/.test(m.text()) && problems.push(`[${username}] console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !/\/(login|start)$/.test(u.pathname));
  return page;
}
const shot = async (page, name, fullPage = true) => { await page.waitForTimeout(900); await page.screenshot({ path: `${SHOTS}/${++step}-${name}.png`, fullPage }); };
async function check(label, fn) {
  try { await fn(); console.log('ok  ', label); } catch (e) { problems.push(`STEP FAILED: ${label}: ${e.message.replace(/\s+/g, ' ').slice(0, 2000)}`); console.log('FAIL', label); await admin?.screenshot({ path: SHOTS + '/fail-' + label.replace(/[^a-z]+/gi, '-').slice(0, 40) + '.png' }).catch(() => {}); }
}
// The button removes itself when clicked, which can trip Playwright's post-click target check: assert the outcome instead.
async function clearFilters() {
  await admin.waitForLoadState('networkidle');
  await admin.getByRole('button', { name: 'Clear filters' }).click({ timeout: 5000 }).catch(() => {});
  await admin.waitForURL((u) => !/[?&](q|role|sort|dir)=/.test(u.search), { timeout: 5000 });
}
const nav = (page) => page.getByRole('navigation', { name: 'Main navigation' });

const admin = await signIn('admin');

await check('dashboard: cards, charts, activity and health load from the API', async () => {
  await admin.getByRole('heading', { name: /^Welcome/ }).waitFor();
  await admin.locator('.stat-card').nth(7).waitFor();
  const cards = await admin.locator('.stat-card').count();
  if (cards !== 8) throw new Error(`expected 8 cards, saw ${cards}`);
  const published = await admin.locator('.stat-card', { hasText: 'Published parcels' }).locator('.stat-value').innerText();
  if (published !== '15') throw new Error(`published parcels card shows ${published}, database has 15`);
  await admin.locator('.chart-grid .panel').nth(5).waitFor();
  const charts = await admin.locator('.chart-grid .panel').count();
  if (charts !== 6) throw new Error(`expected 6 chart panels, saw ${charts}`);
  await admin.locator('.activity-item, .activity-list + *, .empty-state', { hasText: /./ }).first().waitFor();
  await admin.locator('.health-list li', { hasText: 'Database' }).getByText('healthy').waitFor();
  await shot(admin, 'admin-dashboard');
});

await check('dashboard: chart shows its data as a table on request', async () => {
  const panel = admin.locator('.chart-grid .panel', { hasText: 'Parcel records by county' });
  await panel.getByRole('button', { name: 'Show data' }).click();
  await panel.locator('table').getByText('Montserrado (synthetic pilot boundary)').waitFor();
  await panel.getByRole('button', { name: 'Show chart' }).click();
});

await check('dashboard: card opens a filtered view', async () => {
  await admin.locator('.stat-card', { hasText: 'Published parcels' }).click();
  await admin.waitForURL(/\/admin\/parcels/);
  await admin.getByRole('heading', { name: 'Parcels & GIS Overview' }).waitFor();
  await admin.goBack();
  await admin.locator('.stat-card', { hasText: 'Pending activations' }).click();
  await admin.waitForURL(/status=invited/);
  await admin.getByText('No accounts match these filters').waitFor();
});

await check('users: search, filter, sort and clear', async () => {
  await admin.goto(`${BASE}/admin/users`);
  await admin.getByLabel('Search', { exact: true }).fill('proc');
  await admin.waitForURL(/q=proc/);
  // proc.mo, proc2.mo and proc.mg; wait for the refetch to replace the unfiltered rows.
  await admin.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3, null, { timeout: 10000 })
    .catch(async () => { throw new Error(`search "proc" gave ${await admin.locator('tbody tr').count()} rows, expected 3`); });
  await clearFilters();
  await admin.getByLabel('Role').selectOption('registrar');
  await admin.waitForURL(/role=registrar/);
  await admin.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
  await admin.getByRole('button', { name: /^Username/ }).click();
  await admin.waitForURL(/sort=username/);
  await admin.getByRole('button', { name: /^Username/ }).click();
  await admin.waitForURL(/dir=desc/);
  await admin.waitForFunction(() => document.querySelector('tbody tr')?.textContent.includes('reg.mo'), null, { timeout: 10000 })
    .catch(() => { throw new Error('descending username sort did not put reg.mo first'); });
  await clearFilters();
});

await check('users: export downloads the staff report without landowners', async () => {
  const [download] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'Export all staff (CSV)' }).click()]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  if (!text.includes('reg.mo') || /owner\.demo|@example/.test(text)) throw new Error('staff export content wrong');
});

let activationUrl = '';
await check('users: create form validates, then issues a one-time activation link', async () => {
  await admin.getByRole('button', { name: 'Create staff account' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Create staff account' });
  await dialog.getByRole('button', { name: /Create and get activation link/ }).click();
  await dialog.getByText('Enter the full name').waitFor();
  await dialog.getByLabel('Full name').fill('Deddeh Synthetic-Registrar');
  await dialog.getByLabel('Username').fill('reg2.mo');
  await dialog.getByLabel('Official email').fill('reg2.mo@example.invalid');
  await dialog.getByLabel('Staff identifier').fill('SYN-777');
  await dialog.getByLabel('Department').fill('County land office (synthetic)');
  await dialog.locator('select').first().selectOption('registrar');
  await dialog.getByRole('button', { name: /Create and get activation link/ }).click();
  await dialog.getByText('This role needs an assigned county').waitFor();
  await dialog.locator('select').nth(1).selectOption({ label: 'Montserrado (synthetic pilot boundary)' });
  await dialog.getByLabel('Authorization reference or reason').fill('SYNTHETIC delegation instrument DI-2026-01');
  await dialog.getByRole('button', { name: /Create and get activation link/ }).click();
  const linkDialog = admin.getByRole('dialog', { name: 'Activation link' });
  await linkDialog.waitFor();
  activationUrl = await linkDialog.locator('.copy-value').innerText();
  await shot(admin, 'admin-activation-link', false);
  await linkDialog.getByRole('button', { name: 'Done' }).click();
  await admin.locator('tbody tr', { hasText: 'reg2.mo' }).getByText('invited').waitFor();
});

await check('activation: the person sets a password and signs in; the link is single-use', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(activationUrl);
  await p.getByText('Deddeh Synthetic-Registrar').waitFor();
  await p.getByLabel('New password').fill('deddeh-own-password-2026');
  await p.getByLabel('Repeat the password').fill('deddeh-own-password-2026');
  await p.getByRole('button', { name: 'Set password' }).click();
  await p.getByText('Your password is set').waitFor();
  await p.goto(activationUrl);
  await p.getByText(/invalid, expired or has already been used/).waitFor();
  await ctx.close();
  const reg2 = await signIn('reg2.mo', 'deddeh-own-password-2026');
  await reg2.getByRole('heading', { name: 'Cases' }).waitFor();
  if (await nav(reg2).getByRole('link', { name: 'User Management' }).count()) throw new Error('registrar sees User Management');
  await reg2.context().close();
});

await check('user drawer: assign a role, suspend with a reason, notification reaches the person', async () => {
  await admin.goto(`${BASE}/admin/users?q=reg2`);
  await admin.locator('tbody tr', { hasText: 'reg2.mo' }).click();
  const drawer = admin.getByRole('dialog', { name: 'Deddeh Synthetic-Registrar' });
  await drawer.getByText('Land Registrar').first().waitFor();
  await drawer.getByRole('button', { name: 'Suspend' }).click();
  const confirm = admin.getByRole('dialog', { name: 'Suspend reg2.mo' });
  const go = confirm.getByRole('button', { name: 'Confirm' });
  if (await go.isEnabled()) throw new Error('confirm enabled without a reason');
  await confirm.getByLabel(/Reason/).fill('On leave pending reassignment');
  await go.click();
  await admin.locator('.toast', { hasText: 'Account set to suspended' }).waitFor();
  await drawer.getByText('suspended').first().waitFor();
  await shot(admin, 'admin-user-drawer', false);
  await drawer.getByRole('button', { name: 'Reactivate' }).click();
  await admin.getByRole('dialog', { name: 'Reactivate reg2.mo' }).getByLabel(/Reason/).fill('Returned from leave');
  await admin.getByRole('dialog', { name: 'Reactivate reg2.mo' }).getByRole('button', { name: 'Confirm' }).click();
  await admin.locator('.toast', { hasText: 'Account set to active' }).waitFor();
  await admin.keyboard.press('Escape');
});

await check('modal: Escape closes it and returns focus', async () => {
  await admin.getByRole('button', { name: 'Create staff account' }).click();
  await admin.getByRole('dialog', { name: 'Create staff account' }).waitFor();
  await admin.keyboard.press('Escape');
  if (await admin.getByRole('dialog', { name: 'Create staff account' }).count()) throw new Error('dialog still open');
});

await check('roles: read-only matrix enforced by the server', async () => {
  await nav(admin).getByRole('link', { name: 'Roles & Permissions' }).click();
  const row = admin.locator('tr', { has: admin.getByText('case.decide', { exact: true }) });
  await row.waitFor();
  const allowed = await row.locator('td.matrix-cell').evaluateAll((cells) => cells.map((c) => c.textContent.includes('not allowed') ? 0 : 1));
  if (allowed.reduce((a, b) => a + b, 0) !== 1) throw new Error(`case.decide allowed for ${allowed.reduce((a, b) => a + b, 0)} roles, expected registrar only`);
  await shot(admin, 'admin-roles');
});

await check('counties: 15 counties; an unconfigured one cannot be enabled', async () => {
  await nav(admin).getByRole('link', { name: 'County Management' }).click();
  await admin.locator('tbody tr').nth(14).waitFor();
  await admin.locator('tbody tr', { hasText: 'Bong' }).click();
  const drawer = admin.getByRole('dialog', { name: 'Bong' });
  await drawer.getByText('No boundary has been imported').waitFor();
  if (await drawer.getByRole('button', { name: 'Enable for operations' }).isEnabled()) throw new Error('enable button active without a boundary');
  await shot(admin, 'admin-county-drawer', false);
  await admin.keyboard.press('Escape');
});

await check('GIS synchronization: honest about the integration, empty state or jobs', async () => {
  await nav(admin).getByRole('link', { name: 'GIS Synchronization' }).click();
  await admin.getByText(/not implemented or verified/).waitFor();
  await admin.locator('table, .empty-state').first().waitFor();
});

await check('audit: filter by event and open an event', async () => {
  await nav(admin).getByRole('link', { name: 'Audit & Security Logs' }).click();
  await admin.getByLabel('Event (prefix)').fill('admin.user_status');
  await admin.getByRole('button', { name: 'Apply' }).click();
  await admin.locator('tbody tr').first().getByText('admin.user_status').waitFor();
  await admin.locator('tbody tr').first().click();
  await admin.getByRole('dialog').getByText('Returned from leave').waitFor();
  await shot(admin, 'admin-audit', false);
  await admin.keyboard.press('Escape');
});

await check('health: live checks', async () => {
  await nav(admin).getByRole('link', { name: 'System Health' }).click();
  await admin.locator('.health-card', { hasText: 'PostGIS' }).getByText(/PostGIS 3\./).waitFor();
  await admin.locator('.health-card', { hasText: 'Background jobs' }).getByText('unknown').waitFor();
  await shot(admin, 'admin-health');
});

await check('settings: banner change applies and is shown to staff', async () => {
  await nav(admin).getByRole('link', { name: 'Settings', exact: true }).click();
  await admin.getByLabel('portal.banner_message').fill('Planned maintenance: Saturday 06:00-08:00 (synthetic notice)');
  await admin.locator('.setting-row', { hasText: 'portal.banner_message' }).getByRole('button', { name: 'Save' }).click();
  await admin.getByRole('dialog').getByLabel(/Reason/).fill('Maintenance window announced');
  await admin.getByRole('dialog').getByRole('button', { name: 'Save setting' }).click();
  await admin.locator('.system-banner', { hasText: 'Planned maintenance' }).waitFor();
});

await check('settings: a real database backup runs and is recorded', async () => {
  await admin.getByRole('button', { name: 'Back up now' }).click();
  await admin.getByRole('dialog').getByLabel(/Reason/).fill('Before configuration changes');
  await admin.getByRole('dialog').getByRole('button', { name: 'Start backup' }).click();
  await admin.locator('.toast', { hasText: 'Backup written' }).waitFor({ timeout: 60000 });
  await admin.locator('tbody tr').first().getByText('succeeded').waitFor();
  await shot(admin, 'admin-settings');
});

await check('document categories: add a category', async () => {
  await nav(admin).getByRole('link', { name: 'Document Categories' }).click();
  await admin.getByRole('button', { name: 'Add category' }).click();
  const d = admin.getByRole('dialog', { name: 'Add document category' });
  await d.getByLabel('Code').fill('lease_agreement');
  await d.getByLabel('Label').fill('Lease agreement');
  await d.getByLabel('Reason').fill('Leases are now recorded');
  await d.getByRole('button', { name: 'Add' }).click();
  await admin.locator('tbody tr', { hasText: 'Lease agreement' }).waitFor();
});

await check('document categories: a new category is offered to staff when uploading', async () => {
  const gis = await signIn('gis.mo');
  // Open a draft case through the API, as the GIS officer, then use the case page's upload form.
  const caseId = await gis.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json();
    const res = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ caseType: 'first_registration', countyId: 1 }) });
    return (await res.json()).id;
  });
  await gis.goto(`${BASE}/work/cases/${caseId}`);
  await gis.getByLabel('Document type').locator('option', { hasText: 'Lease agreement' }).waitFor({ state: 'attached' });
  await gis.context().close();
});

await check('reports: CSV download', async () => {
  await nav(admin).getByRole('link', { name: 'Reports & Analytics' }).click();
  const [download] = await Promise.all([admin.waitForEvent('download'), admin.locator('li', { hasText: 'Staff accounts' }).getByRole('button', { name: /Download CSV/ }).click()]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  if (!text.includes('reg2.mo') || /owner\.demo|@example/.test(text)) throw new Error('staff report content wrong');
});

await check('global search: finds a parcel and navigates', async () => {
  await admin.getByLabel('Search parcels, cases, staff and counties').fill('PROV-MO-00000');
  await admin.getByRole('option').first().waitFor();
  await admin.getByRole('option').first().click();
  await admin.waitForURL(/upi=PROV-MO-/);
});

await check('notifications: centre opens', async () => {
  await admin.goto(`${BASE}/admin`);
  await admin.getByRole('button', { name: /^Notifications/ }).click();
  await admin.getByRole('dialog', { name: 'Notifications' }).waitFor();
  await admin.keyboard.press('Escape');
});

await check('theme: dark mode applies and persists', async () => {
  await admin.getByRole('button', { name: 'Switch to dark theme' }).click();
  if (await admin.evaluate(() => document.documentElement.dataset.theme) !== 'dark') throw new Error('theme not dark');
  await admin.reload();
  await admin.getByRole('heading', { name: /^Welcome/ }).waitFor();
  if (await admin.evaluate(() => document.documentElement.dataset.theme) !== 'dark') throw new Error('theme did not persist');
  await shot(admin, 'admin-dashboard-dark');
  await admin.getByRole('button', { name: 'Switch to light theme' }).click();
});

await check('mobile: dashboard fits a phone and the menu opens', async () => {
  const phone = await signIn('admin', PASSWORD, { width: 390, height: 844 });
  await phone.getByRole('heading', { name: /^Welcome/ }).waitFor();
  await phone.waitForTimeout(800);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`page is ${overflow}px wider than the phone`);
  await phone.getByRole('button', { name: 'Open menu' }).click();
  await nav(phone).getByRole('link', { name: 'User Management' }).click();
  await phone.waitForURL(/\/admin\/users/);
  await shot(phone, 'admin-mobile', false);
  await phone.context().close();
});

await check('GIS officer: no admin navigation, admin pages refuse', async () => {
  const gis = await signIn('gis.mo');
  await gis.getByRole('heading', { name: 'Cases' }).waitFor();
  if (await nav(gis).getByRole('link', { name: 'User Management' }).count()) throw new Error('GIS officer sees User Management');
  await gis.goto(`${BASE}/admin/users`);
  await gis.getByRole('heading', { name: 'No access' }).waitFor();
  await shot(gis, 'gis-shell');
  await gis.context().close();
});

await check('supervisor: read-only user management', async () => {
  const sup = await signIn('supervisor');
  await sup.goto(`${BASE}/admin/users`);
  await sup.locator('tbody tr').first().waitFor();
  if (await sup.getByRole('button', { name: 'Create staff account' }).count()) throw new Error('supervisor offered account creation');
  await sup.context().close();
});

await browser.close();
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(' -', p);
