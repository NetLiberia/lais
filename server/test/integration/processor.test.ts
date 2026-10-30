import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * LAIS processor phase: application registration, applicants, documents (versions and review),
 * completeness, information requests, GIS handoff, returns and registrar decision tracking, dashboard and
 * reports. Runs against a real PostgreSQL + PostGIS database (TEST_DATABASE_URL, disposable).
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const PASSWORD = 'integration-test-password';
const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
const PDF = () => fixture('synthetic_document.pdf');
/** A tiny TIFF (little-endian header) and a PNG signature, enough for content sniffing. */
const TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), Buffer.alloc(64)]);
let unique = 0;
/** Distinct PDF bytes, so duplicate-file detection does not refuse a deliberate second upload. */
const pdfVariant = () => Buffer.concat([PDF(), Buffer.from(`\n% variant ${++unique}\n`)]);

type App = Parameters<typeof request>[0];
let app: App;
let pool: import('pg').Pool;

class Client {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor(public username: string) { this.agent = request.agent(app); }
  async login() {
    const res = await this.agent.post('/api/auth/login').send({ username: this.username, password: PASSWORD });
    expect(res.status, `login ${this.username}`).toBe(200);
    this.csrf = (await this.agent.get('/api/auth/session')).body.csrfToken;
    return this;
  }
  get(url: string) { return this.agent.get(url); }
  post(url: string, body?: object) { return this.agent.post(url).set('X-CSRF-Token', this.csrf).send(body ?? {}); }
  patch(url: string, body: object) { return this.agent.patch(url).set('X-CSRF-Token', this.csrf).send(body); }
  upload(url: string, file: Buffer, filename: string, fields: Record<string, string> = {}) {
    let r = this.agent.post(url).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, filename);
  }
}
const users: Record<string, Client> = {};
const as = (u: string) => users[u];
const userId = async (username: string) => (await pool.query('SELECT id FROM lais.app_user WHERE username = $1', [username])).rows[0].id as string;
const today = () => new Date().toISOString().slice(0, 10);

const APPLICANT = { applicantType: 'person', name: 'Comfort Testapplicant', phone: '+231 770 123 456', email: 'comfort@example.invalid', address: 'Synthetic Street 1, Monrovia', idDocumentType: 'national_id', idReference: 'SYN-NID-0001' };
const intake = (over: Record<string, unknown> = {}) => ({
  mode: 'register', categoryCode: 'first_registration', countyId: 1, landCategory: 'private',
  purpose: 'Register a family plot', submissionDate: today(), receivingOffice: 'Montserrado county office', locationDescription: 'Behind the synthetic market',
  declaredLandUse: 'residential', declaredArea: 0.25, declaredAreaUnit: 'ha', surveyReference: 'SYN-SURVEY-001', ...over,
});

async function register(over: Record<string, unknown> = {}, who = 'proc.mo') {
  const res = await as(who).post('/api/applications', { applicant: { ...APPLICANT, name: `Applicant ${++unique}` }, ...intake(over) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; caseNo: string; applicantId: string; applicantNo: string; intakeStatus: string };
}
async function addDoc(caseId: string, docType: string, who = 'proc.mo', classification = docType === 'id_document' ? 'highly_sensitive' : 'restricted', file = pdfVariant()) {
  const res = await as(who).upload(`/api/applications/${caseId}/documents`, file, `${docType}.pdf`, { docType, classification, title: `${docType} of the applicant` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; document_no: string; version_no: number };
}
const review = (docId: string, status: string, note?: string, who = 'proc2.mo') => as(who).post(`/api/documents/${docId}/review`, { status, note });

describe.skipIf(!TEST_DB)('LAIS processor phase', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.NODE_ENV = 'test';
    process.env.MFA_ENCRYPTION_KEY ||= 'a'.repeat(64);
    process.env.DOCUMENT_STORAGE_DIR = path.join(tmpdir(), `lais-test-docs-${process.pid}`);
    const { resetDatabase } = await import('../../src/reset.js');
    await resetDatabase(PASSWORD, () => undefined);
    app = (await import('../../src/app.js')).createApp();
    pool = (await import('../../src/db.js')).pool;
    for (const u of ['admin', 'gis.mo', 'gis.mg', 'proc.mo', 'proc2.mo', 'proc.mg', 'reg.mo', 'sup.mo', 'supervisor', 'auditor']) users[u] = await new Client(u).login();
  });
  afterAll(async () => { await pool?.end(); });

  describe('application registration', () => {
    it('registers an application with a new applicant and records it in the history', async () => {
      const a = await register({ externalReference: 'MO/RCPT/0001' });
      expect(a.caseNo).toMatch(/^CASE-\d{4}-\d{6}$/);
      expect(a.applicantNo).toMatch(/^APL-\d{6}$/);
      expect(a.intakeStatus).toBe('registered');
      const { rows: [c] } = await pool.query('SELECT applicant_id, category_code, intake_status, assigned_processor_id, status, declared_area, declared_area_unit FROM lais.land_case WHERE id = $1', [a.id]);
      expect(c).toMatchObject({ applicant_id: a.applicantId, category_code: 'first_registration', intake_status: 'registered', status: 'draft', declared_area_unit: 'ha' });
      expect(c.assigned_processor_id).toBe(await userId('proc.mo'));
      const timeline = await as('proc.mo').get(`/api/applications/${a.id}/timeline`);
      expect(timeline.body.map((e: any) => e.event)).toEqual(expect.arrayContaining(['create', 'register_application']));
    });

    it('refuses a receipt reference already used in the county', async () => {
      const res = await as('proc.mo').post('/api/applications', { applicant: { ...APPLICANT, name: 'Another person' }, ...intake({ externalReference: 'mo/rcpt/0001' }) });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already used/);
    });

    it('checks required fields when registering, and saves incomplete drafts', async () => {
      const missing = await as('proc.mo').post('/api/applications', { applicant: { ...APPLICANT, name: 'Draft person' }, ...intake({ purpose: null, receivingOffice: null }) });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/Purpose of the application.*Receiving office|Receiving office.*Purpose/);
      const draft = await register({ mode: 'draft', purpose: null });
      expect(draft.intakeStatus).toBe('draft');
      expect((await as('proc.mo').get(`/api/applications/${draft.id}/completeness`)).body.status).toBe('draft');
      expect((await as('proc.mo').post(`/api/applications/${draft.id}/register`)).status).toBe(400);
      expect((await as('proc.mo').patch(`/api/applications/${draft.id}`, { purpose: 'Register a family plot' })).status).toBe(200);
      const reg = await as('proc.mo').post(`/api/applications/${draft.id}/register`);
      expect(reg.body.intakeStatus, JSON.stringify(reg.body)).toBe('registered');
      // Registered applications keep their earlier values: a change needs a reason and is recorded.
      expect((await as('proc.mo').patch(`/api/applications/${draft.id}`, { district: 'Greater Monrovia' })).status).toBe(400);
      expect((await as('proc.mo').patch(`/api/applications/${draft.id}`, { district: 'Greater Monrovia', reason: 'Applicant corrected the district' })).status).toBe(200);
      const { rows } = await pool.query(`SELECT note FROM lais.case_event WHERE case_id = $1 AND action = 'update_application' ORDER BY id`, [draft.id]);
      expect(rows.at(-1).note).toMatch(/district: "" → "Greater Monrovia" \(Applicant corrected the district\)/);
    });

    it('refuses counties outside the processor\'s assignment, unknown and disabled counties', async () => {
      expect((await as('proc.mo').post('/api/applications', { applicant: APPLICANT, ...intake({ countyId: 2 }) })).status).toBe(403);
      expect((await as('proc.mo').post('/api/applications', { applicant: APPLICANT, ...intake({ countyId: 99 }) })).status).toBe(400);
      const { rows: [disabled] } = await pool.query('SELECT id FROM lais.county WHERE NOT enabled LIMIT 1');
      expect((await as('admin').post('/api/applications', { applicant: APPLICANT, ...intake({ countyId: disabled.id }) })).status).toBe(403);
      expect((await as('gis.mo').post('/api/applications', { applicant: APPLICANT, ...intake() })).status).toBe(403);
      expect((await as('reg.mo').post('/api/applications', { applicant: APPLICANT, ...intake() })).status).toBe(403);
    });

    it('holds possible duplicates for review and records the decision to register anyway', async () => {
      const first = await register({ declaredParcelRef: 'DECL-MO-77' });
      const again = await as('proc.mo').post('/api/applications', { applicantId: first.applicantId, ...intake({ declaredParcelRef: 'DECL-MO-77' }) });
      expect(again.status).toBe(409);
      expect(again.body.details.duplicates[0]).toMatchObject({ caseNo: first.caseNo });
      // Nothing was created by the refused attempt.
      expect((await pool.query('SELECT count(*)::int AS n FROM lais.land_case WHERE declared_parcel_ref = $1', ['DECL-MO-77'])).rows[0].n).toBe(1);
      const ok = await as('proc.mo').post('/api/applications', { applicantId: first.applicantId, duplicateReview: { reason: 'Second plot of the same family, different boundary' }, ...intake({ declaredParcelRef: 'DECL-MO-77' }) });
      expect(ok.status).toBe(201);
      const { rows } = await pool.query('SELECT match_reason, reason FROM lais.application_duplicate_review WHERE case_id = $1', [ok.body.id]);
      expect(rows[0].reason).toMatch(/Second plot/);
    });
  });

  describe('applicants', () => {
    let applicantId: string;
    beforeAll(async () => { applicantId = (await register()).applicantId; });

    it('searches by name and number, and by contact only for officers allowed to see contacts', async () => {
      const byName = await as('proc.mo').get(`/api/applicants?q=${encodeURIComponent('Applicant')}`);
      expect(byName.body.items.length).toBeGreaterThan(0);
      const byPhone = await as('proc.mo').get('/api/applicants?q=770%20123');
      expect(byPhone.body.items.some((a: any) => a.id === applicantId)).toBe(true);
      expect(byPhone.body.items[0].phone).toBe('+231 770 123 456');
      const supervisor = await as('sup.mo').get('/api/applicants?q=770%20123');
      expect(supervisor.body.items).toEqual([]);
      const masked = (await as('sup.mo').get(`/api/applicants/${applicantId}`)).body.applicant;
      expect(masked.phone).toMatch(/\*\*\*/);
      expect(masked.email).toMatch(/^c\*\*\*@/);
      expect(masked.address).toBeNull();
    });

    it('keeps applicants inside the county', async () => {
      expect((await as('proc.mg').get(`/api/applicants/${applicantId}`)).status).toBe(403);
      expect((await as('proc.mg').get('/api/applicants?countyId=1')).status).toBe(403);
      expect((await as('gis.mo').get(`/api/applicants/${applicantId}`)).status).toBe(403);
    });

    it('records corrections with previous values and a reason, and never loses identity history', async () => {
      expect((await as('proc.mo').patch(`/api/applicants/${applicantId}`, { name: 'Comfort T. Applicant' })).status).toBe(400);
      expect((await as('proc.mo').patch(`/api/applicants/${applicantId}`, { name: 'Comfort T. Applicant', reason: 'Spelling corrected from the identity card' })).status).toBe(200);
      expect((await as('proc.mo').patch(`/api/applicants/${applicantId}`, { phone: '+231 880 000 111' })).status).toBe(200);
      expect((await as('proc.mo').patch(`/api/applicants/${applicantId}`, { idReference: 'SYN-NID-0002', reason: 'Card replaced; new number from the office copy' })).status).toBe(200);
      const profile = (await as('proc.mo').get(`/api/applicants/${applicantId}`)).body;
      const nameChange = profile.history.find((h: any) => h.field === 'name');
      expect(nameChange).toMatchObject({ new_value: 'Comfort T. Applicant', reason: 'Spelling corrected from the identity card', changed_by: 'proc.mo' });
      expect(nameChange.old_value).toMatch(/^Applicant \d+$/);
      expect(profile.history.find((h: any) => h.field === 'id_reference')).toMatchObject({ old_value: 'SYN-NID-0001', new_value: 'SYN-NID-0002' });
      // A supervisor sees that it changed, not the values.
      const sup = (await as('sup.mo').get(`/api/applicants/${applicantId}`)).body;
      expect(sup.history.find((h: any) => h.field === 'id_reference')).toMatchObject({ old_value: '(hidden)', new_value: '(hidden)' });
      expect(sup.history.find((h: any) => h.field === 'phone').new_value).toBe('(hidden)');
      // The audit records which fields changed, never the values.
      const { rows } = await pool.query(`SELECT detail::text AS d FROM audit.event WHERE action = 'applicant.update' AND entity_id = $1`, [applicantId]);
      expect(rows.map((r) => r.d).join()).not.toMatch(/SYN-NID|880 000/);
      await expect(pool.query('UPDATE lais.applicant_change SET new_value = $1 WHERE applicant_id = $2', ['x', applicantId])).rejects.toThrow();
      await expect(pool.query('DELETE FROM lais.applicant WHERE id = $1', [applicantId])).rejects.toThrow();
    });

    it('reveals an identification reference only to permitted officers, and audits it', async () => {
      expect((await as('sup.mo').get(`/api/applicants/${applicantId}/identity`)).status).toBe(403);
      const res = await as('proc.mo').get(`/api/applicants/${applicantId}/identity`);
      expect(res.body.idReference).toBe('SYN-NID-0002');
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit.event WHERE action = 'applicant.identity_revealed' AND entity_id = $1`, [applicantId]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('documents', () => {
    let app1: { id: string; caseNo: string };
    let deed: { id: string; document_no: string };

    it('accepts PDF and TIFF by their content and refuses other content whatever its name', async () => {
      app1 = await register();
      deed = await addDoc(app1.id, 'deed');
      expect(deed.document_no).toMatch(/^DOC-\d{6}$/);
      const tiff = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, TIFF, 'scan.tif', { docType: 'other', classification: 'restricted' });
      expect(tiff.status).toBe(201);
      expect((await pool.query('SELECT mime_type FROM lais.document WHERE id = $1', [tiff.body.id])).rows[0].mime_type).toBe('image/tiff');
      const script = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, Buffer.from('<script>alert(1)</script>'), 'deed.pdf', { docType: 'deed', classification: 'restricted' });
      expect(script.status).toBe(400);
      const exe = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, Buffer.from('MZ\x90\x00 not a document'), 'plan.png', { docType: 'other', classification: 'restricted' });
      expect(exe.status).toBe(400);
      const same = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, readFileSync(path.join(FIXTURES, 'synthetic_document.pdf')), 'again.pdf', { docType: 'other', classification: 'restricted' });
      expect(same.status).toBe(201);
      const dup = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, readFileSync(path.join(FIXTURES, 'synthetic_document.pdf')), 'again2.pdf', { docType: 'other', classification: 'restricted' });
      expect(dup.status).toBe(409);
    });

    it('refuses downloads outside the officer\'s county or classification', async () => {
      expect((await as('gis.mg').get(`/api/documents/${deed.id}/file`)).status).toBe(403);
      expect((await as('proc.mg').get(`/api/documents/${deed.id}`)).status).toBe(403);
      const id = await addDoc(app1.id, 'id_document');
      expect((await as('gis.mo').get(`/api/documents/${id.id}/file`)).status).toBe(403);
      const meta = await as('gis.mo').get(`/api/documents/${id.id}`);
      expect(meta.body.document).toMatchObject({ title: null, original_name: null, restricted: true });
      expect(meta.body.can.download).toBe(false);
      expect((await as('proc2.mo').get(`/api/documents/${id.id}/file`)).status).toBe(200);
      // The repository never lists another county's documents.
      expect((await as('proc.mg').get('/api/documents')).body.items.some((d: any) => d.case_id === app1.id)).toBe(false);
    });

    it('keeps every version: a replacement is new, the old one is superseded, never overwritten', async () => {
      expect((await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, pdfVariant(), 'deed-v2.pdf', { docType: 'deed', classification: 'restricted', supersedesId: deed.id })).status).toBe(400);
      const v2 = await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, pdfVariant(), 'deed-v2.pdf', { docType: 'deed', classification: 'restricted', supersedesId: deed.id, replacementReason: 'Clearer copy received at the office' });
      expect(v2.status).toBe(201);
      expect(v2.body.version_no).toBe(2);
      const detail = await as('proc.mo').get(`/api/documents/${v2.body.id}`);
      expect(detail.body.versions.map((v: any) => [v.version_no, v.review_status])).toEqual([[1, 'superseded'], [2, 'not_reviewed']]);
      expect((await review(deed.id, 'accepted')).status).toBe(409);
      expect((await as('proc.mo').upload(`/api/applications/${app1.id}/documents`, pdfVariant(), 'deed-v3.pdf', { docType: 'deed', classification: 'restricted', supersedesId: deed.id, replacementReason: 'Replacing the old one again' })).status).toBe(409);
      await expect(pool.query('UPDATE lais.document SET storage_key = $1 WHERE id = $2', ['f'.repeat(32), deed.id])).rejects.toThrow(/cannot be altered/);
      await expect(pool.query('DELETE FROM lais.document WHERE id = $1', [deed.id])).rejects.toThrow(/never deleted/);
      const repo = await as('proc.mo').get(`/api/documents?caseId=${app1.id}&category=deed`);
      expect(repo.body.items.map((d: any) => d.version_no)).toEqual([2]);
      deed = v2.body;
    });

    it('records administrative reviews with a history; the uploader cannot review their own document', async () => {
      expect((await review(deed.id, 'accepted', undefined, 'proc.mo')).status).toBe(403);
      expect((await review(deed.id, 'unreadable')).status).toBe(400);
      expect((await review(deed.id, 'under_review')).status).toBe(200);
      expect((await review(deed.id, 'requires_clarification', 'Seller name differs from the application')).status).toBe(200);
      expect((await review(deed.id, 'accepted', 'Clarified by the applicant')).status).toBe(200);
      const detail = await as('proc.mo').get(`/api/documents/${deed.id}`);
      expect(detail.body.history.map((h: any) => h.to_status)).toEqual(['superseded', 'under_review', 'requires_clarification', 'accepted']);
      const { rows: [d] } = await pool.query('SELECT verification_status, review_status FROM lais.document WHERE id = $1', [deed.id]);
      expect(d).toEqual({ verification_status: 'verified', review_status: 'accepted' });
      await expect(pool.query('DELETE FROM lais.document_review_event WHERE document_id = $1', [deed.id])).rejects.toThrow();
      // Referral: a legal question is flagged for an authorized decision, not judged here.
      const plan = await addDoc(app1.id, 'survey_plan');
      expect((await as('proc2.mo').post(`/api/documents/${plan.id}/review`, { status: 'requires_clarification', note: 'Boundary dispute mentioned on the plan', refer: true })).status).toBe(200);
      expect((await pool.query('SELECT referred FROM lais.document_review_event WHERE document_id = $1 ORDER BY id DESC LIMIT 1', [plan.id])).rows[0].referred).toBe(true);
    });
  });

  describe('completeness, information requests and GIS handoff', () => {
    let a: { id: string; caseNo: string };
    let plan: { id: string };

    it('lists missing documents and fields from the configured requirements', async () => {
      a = await register({ declaredParcelRef: 'DECL-MO-HANDOFF' });
      const c = (await as('proc.mo').get(`/api/applications/${a.id}/completeness`)).body;
      expect(c.status).toBe('incomplete');
      const missing = c.items.filter((i: any) => i.state === 'missing').map((i: any) => i.req_key);
      expect(missing).toEqual(expect.arrayContaining(['document:survey_plan', 'document:id_document', 'document:deed']));
      expect(c.items.find((i: any) => i.req_key === 'document:customary_certificate')).toMatchObject({ mandatory: false });
      expect(c.notice).toMatch(/not legal verification/);
    });

    it('refuses a GIS handoff while a required document is missing', async () => {
      const check = (await as('proc.mo').get(`/api/applications/${a.id}/handoff-check`)).body;
      expect(check.ready).toBe(false);
      expect(check.items.find((i: any) => i.key === 'documents').ok).toBe(false);
      const res = await as('proc.mo').post(`/api/applications/${a.id}/handoff`, { instructions: 'Digitise the parcel from the survey plan' });
      expect(res.status).toBe(409);
      expect((await pool.query('SELECT count(*)::int AS n FROM lais.task WHERE case_id = $1', [a.id])).rows[0].n).toBe(0);
    });

    it('tracks information requests without claiming that anything was sent', async () => {
      const email = await as('proc.mo').post(`/api/applications/${a.id}/info-requests`, {
        category: 'missing_document', items: 'Survey plan', docCategories: ['survey_plan'], explanation: 'Please bring the signed survey plan to the office.', channel: 'email', dueDate: today(),
      });
      expect(email.status).toBe(201);
      expect(email.body.deliveryStatus).toBe('not_sent_no_provider');
      const letter = await as('proc.mo').post(`/api/applications/${a.id}/info-requests`, {
        category: 'clarification', items: 'Seller name', explanation: 'Please confirm the seller name on the deed.', channel: 'letter',
      });
      expect(letter.body.deliveryStatus).toBe('awaiting_manual_delivery');
      expect((await as('proc.mo').get(`/api/applications/${a.id}/completeness`)).body.status).toBe('awaiting_information');
      expect((await as('proc.mo').post(`/api/info-requests/${letter.body.id}/delivered`, { note: 'Letter handed to the applicant at the counter' })).status).toBe(200);
      // Overdue: past its due date and still open.
      await pool.query(`UPDATE lais.info_request SET due_date = current_date - 3 WHERE id = $1`, [email.body.id]);
      expect((await as('proc.mo').get('/api/info-requests?status=overdue')).body.map((r: any) => r.id)).toContain(email.body.id);
      // A response with the plan; satisfied after review; reopen needs a reason.
      plan = await addDoc(a.id, 'survey_plan');
      expect((await as('proc.mo').post(`/api/info-requests/${email.body.id}/status`, { to: 'satisfied' })).status).toBe(409);
      expect((await as('proc.mo').post(`/api/info-requests/${email.body.id}/responses`, { note: 'Plan received at the office', channel: 'in_person', documentIds: [plan.id] })).status).toBe(201);
      expect((await as('proc.mo').post(`/api/info-requests/${email.body.id}/status`, { to: 'satisfied' })).status).toBe(200);
      expect((await as('proc.mo').post(`/api/info-requests/${email.body.id}/status`, { to: 'reopened' })).status).toBe(400);
      expect((await as('proc.mo').post(`/api/info-requests/${letter.body.id}/status`, { to: 'closed', note: 'Clarified by phone; no longer needed' })).status).toBe(200);
      const detail = (await as('proc.mo').get(`/api/info-requests/${email.body.id}`)).body;
      expect(detail.events.map((e: any) => e.action)).toEqual(['created', 'response_recorded', 'satisfied']);
      expect(detail.events[1].document_nos).toHaveLength(1);
      expect((await as('gis.mg').get(`/api/info-requests/${email.body.id}`)).status).toBe(403);
    });

    it('allows the handoff after a supervisor\'s justified exception, and creates a linked GIS task', async () => {
      // The plan is received but not yet reviewed: still blocking.
      expect((await as('proc.mo').post(`/api/applications/${a.id}/handoff`, { instructions: 'Digitise the parcel from the survey plan' })).status).toBe(409);
      expect((await as('proc.mo').post(`/api/applications/${a.id}/exceptions`, { stage: 'gis_handoff', requirementKeys: ['document:survey_plan'], reason: 'Plan accepted by the survey office directly; copy to follow' })).status).toBe(403);
      expect((await as('sup.mo').post(`/api/applications/${a.id}/exceptions`, { stage: 'gis_handoff', requirementKeys: ['document:survey_plan'], reason: 'too short' })).status).toBe(400);
      const ex = await as('sup.mo').post(`/api/applications/${a.id}/exceptions`, { stage: 'gis_handoff', requirementKeys: ['document:survey_plan'], reason: 'Plan accepted by the survey office directly; review to follow' });
      expect(ex.status).toBe(201);
      const gisMo = await userId('gis.mo');
      const res = await as('proc.mo').post(`/api/applications/${a.id}/handoff`, { instructions: 'Digitise the parcel from the survey plan', documentIds: [plan.id], assigneeId: gisMo, priority: 'high' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.handoffNo).toMatch(/^HO-\d{6}$/);
      const { rows: [task] } = await pool.query('SELECT task_type, case_id, assignee_id, created_by, status, priority, reference FROM lais.task WHERE id = $1', [res.body.taskId]);
      expect(task).toMatchObject({ task_type: 'gis_preparation', case_id: a.id, assignee_id: gisMo, created_by: await userId('proc.mo'), status: 'assigned', priority: 'high' });
      const { rows: [h] } = await pool.query('SELECT exception_id, checklist FROM lais.application_handoff WHERE handoff_no = $1', [res.body.handoffNo]);
      expect(h.exception_id).toBe(ex.body.id);
      const { rows: notes } = await pool.query(`SELECT title FROM lais.notification WHERE user_id = $1 AND title LIKE $2`, [gisMo, `%${res.body.taskNo}%`]);
      expect(notes).toHaveLength(1);
      // One open GIS task at a time; the handoff record cannot be changed.
      expect((await as('proc.mo').post(`/api/applications/${a.id}/handoff`, { instructions: 'Again please, same parcel' })).status).toBe(409);
      await expect(pool.query('DELETE FROM lais.application_handoff WHERE handoff_no = $1', [res.body.handoffNo])).rejects.toThrow();
      const ws = (await as('proc.mo').get(`/api/applications/${a.id}`)).body;
      expect(ws.application.stage).toBe('awaiting_gis');
      expect(ws.handoffs[0]).toMatchObject({ task_no: res.body.taskNo, gis_officer: 'gis.mo', with_exception: true });
    });

    it('never lets the processor touch geometry', async () => {
      const res = await as('proc.mo').upload(`/api/cases/${a.id}/geometry`, fixture('valid_parcel_4326.geojson'), 'p.geojson', { crs: '4326' });
      expect(res.status).toBe(403);
      expect((await as('proc.mo').upload('/api/gis/uploads', fixture('valid_parcel_4326.geojson'), 'p.geojson')).status).toBe(403);
      expect((await as('proc.mo').post(`/api/gis/cases/${a.id}/corrections`, { reason: 'Changing an attribute', changes: [{ featureIndex: 0, set: { a: 1 } }] })).status).toBe(403);
    });

    it('shows a GIS clarification as returned work until the processor answers it', async () => {
      const ws = (await as('proc.mo').get(`/api/applications/${a.id}`)).body;
      const taskId = ws.handoffs[0].task_id;
      expect((await as('gis.mo').post(`/api/tasks/${taskId}/clarification`, { question: 'Which corner beacon is the starting point?' })).status).toBe(201);
      const returned = (await as('proc.mo').get('/api/processor/returned')).body;
      expect(returned.find((r: any) => r.id === a.id)).toMatchObject({ source: 'gis_officer', reason: 'Which corner beacon is the starting point?' });
      expect((await as('proc.mo').post(`/api/tasks/${taskId}/comments`, { note: 'Beacon B1 at the north-west corner, per the plan' })).status).toBe(201);
      expect((await as('proc.mo').get('/api/processor/returned')).body.some((r: any) => r.id === a.id)).toBe(false);
      const timeline = (await as('proc.mo').get(`/api/applications/${a.id}/timeline`)).body;
      const sources = new Set(timeline.map((e: any) => e.source));
      for (const s of ['case', 'info_request', 'gis', 'exception']) expect(sources.has(s), s).toBe(true);
      expect(timeline.some((e: any) => e.event === 'upload_document')).toBe(true);
      const times = timeline.map((e: any) => new Date(e.at).getTime());
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    });
  });

  describe('registrar decisions', () => {
    let a: { id: string; caseNo: string };

    it('a complete application goes through submission; completeness never creates a decision', async () => {
      a = await register({ declaredParcelRef: 'DECL-MO-DECIDE' });
      expect((await as('gis.mo').upload(`/api/cases/${a.id}/geometry`, fixture('valid_parcel_4326.geojson'), 'p.geojson', { crs: '4326' })).status).toBe(201);
      const party = (await as('proc.mo').get('/api/parties?q=Hawa')).body[0];
      expect((await as('proc.mo').post(`/api/cases/${a.id}/rights`, { partyId: party.id, rrrType: 'ownership' })).status).toBe(201);
      // Submission is refused while required documents are missing.
      const early = await as('proc.mo').post(`/api/cases/${a.id}/submit`);
      expect(early.status).toBe(409);
      expect(early.body.details.missing.map((m: any) => m.key)).toEqual(expect.arrayContaining(['document:deed', 'document:id_document']));
      const plan = await addDoc(a.id, 'survey_plan', 'gis.mo');
      const deed = await addDoc(a.id, 'deed');
      const id = await addDoc(a.id, 'id_document');
      expect((await review(plan.id, 'accepted', undefined, 'proc.mo')).status).toBe(200);
      for (const d of [deed, id]) expect((await review(d.id, 'accepted')).status).toBe(200);
      const c = (await as('proc.mo').get(`/api/applications/${a.id}/completeness`)).body;
      expect(c.status).toBe('complete');
      expect((await pool.query('SELECT count(*)::int AS n FROM lais.case_decision WHERE case_id = $1', [a.id])).rows[0].n).toBe(0);
      expect((await pool.query('SELECT status FROM lais.land_case WHERE id = $1', [a.id])).rows[0].status).toBe('draft');
      const sub = await as('proc.mo').post(`/api/cases/${a.id}/submit`);
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      expect(sub.body.status, JSON.stringify(sub.body.findings)).toBe('under_review');
    });

    it('the processor cannot decide, publish or change a decision; tracking reflects the registrar\'s record', async () => {
      expect((await as('proc.mo').post(`/api/cases/${a.id}/decision`, { decision: 'approved', reason: 'Looks complete to me', authorityBasis: 'none' })).status).toBe(403);
      let tracking = (await as('proc.mo').get('/api/processor/decisions')).body;
      expect(tracking.items.find((i: any) => i.id === a.id).tracking_status).toBe('awaiting_registrar_review');
      const ws = (await as('reg.mo').get(`/api/cases/${a.id}`)).body;
      for (const f of ws.validation.findings) if (f.severity === 'warning') await as('reg.mo').post(`/api/cases/${a.id}/findings/${f.id}/acknowledge`, { note: 'Reviewed for this test' });
      const decision = await as('reg.mo').post(`/api/cases/${a.id}/decision`, { decision: 'approved', reason: 'Evidence reviewed and consistent', authorityBasis: 'Synthetic delegation TEST-001' });
      expect(decision.status, JSON.stringify(decision.body)).toBe(200);
      tracking = (await as('proc.mo').get('/api/processor/decisions')).body;
      const row = tracking.items.find((i: any) => i.id === a.id);
      expect(row).toMatchObject({ tracking_status: 'approved', decision: 'approved', registrar: 'reg.mo', decision_summary: 'Evidence reviewed and consistent' });
      expect((await as('proc.mo').post(`/api/cases/${a.id}/decision`, { decision: 'rejected', reason: 'Changing my mind', authorityBasis: 'none' })).status).toBe(403);
      expect((await as('proc.mo').post(`/api/cases/${a.id}/publish`)).status).toBe(403);
      expect((await as('proc.mo').patch(`/api/applications/${a.id}`, { remarks: 'Late remark', reason: 'Adding a remark after approval' })).status).toBe(403);
      await expect(pool.query(`UPDATE lais.land_case SET purpose = 'changed' WHERE id = $1`, [a.id])).rejects.toThrow(/can no longer be changed/);
    });
  });

  describe('dashboard, reports and scope', () => {
    it('reports the same numbers as the database', async () => {
      const res = await as('proc.mo').get('/api/processor/summary');
      expect(res.status).toBe(200);
      const k = res.body.kpis;
      expect(Object.keys(k)).toHaveLength(13);
      const { rows: [db] } = await pool.query(
        `SELECT count(*) FILTER (WHERE intake_status = 'registered')::int AS total,
                count(*) FILTER (WHERE status IN ('validating', 'under_review'))::int AS awaiting_registrar,
                count(*) FILTER (WHERE status IN ('draft', 'returned') AND lais.application_completeness(id) = 'complete')::int AS complete,
                count(*) FILTER (WHERE assigned_processor_id = $1 AND status IN ('draft', 'validating', 'under_review', 'returned', 'approved'))::int AS mine
           FROM lais.land_case WHERE applicant_id IS NOT NULL AND county_id = 1`, [await userId('proc.mo')]);
      expect(k.total_registered).toBe(db.total);
      expect(k.awaiting_registrar).toBe(db.awaiting_registrar);
      expect(k.complete).toBe(db.complete);
      expect(k.my_open).toBe(db.mine);
      expect(k.awaiting_gis).toBe(1);
      expect(k.overdue_tasks).toBeGreaterThanOrEqual(0);
      // Another county sees none of these.
      const mg = (await as('proc.mg').get('/api/processor/summary')).body.kpis;
      expect(mg.total_registered).toBe(0);
      expect((await as('proc.mg').get('/api/applications?pageSize=100')).body.items).toEqual([]);
      expect((await as('proc.mg').get('/api/processor/summary?countyId=1')).status).toBe(403);
    });

    it('filters the application list', async () => {
      const all = (await as('proc.mo').get('/api/applications?pageSize=100')).body;
      expect(all.total).toBeGreaterThan(5);
      const gis = (await as('proc.mo').get('/api/applications?stage=awaiting_gis')).body;
      expect(gis.items.every((i: any) => i.stage === 'awaiting_gis')).toBe(true);
      const mine = (await as('proc2.mo').get('/api/applications?processor=me')).body;
      expect(mine.items).toEqual([]);
      const q = (await as('proc.mo').get('/api/applications?q=DECL-MO-77')).body;
      expect(q.items).toHaveLength(2);
    });

    it('generates reports without personal data, as JSON, CSV and PDF', async () => {
      const list = (await as('proc.mo').get('/api/processor/reports')).body;
      expect(list).toHaveLength(10);
      for (const r of list) {
        const json = await as('proc.mo').get(`/api/processor/reports/${r.key}`);
        expect(json.status, r.key).toBe(200);
        expect(JSON.stringify(json.body)).not.toMatch(/Comfort|770 123|example\.invalid|SYN-NID/);
      }
      const csv = await as('proc.mo').get('/api/processor/reports/registered.csv');
      expect(csv.text).toMatch(/synthetic/);
      expect(csv.text).not.toMatch(/Applicant \d+|770 123/);
      const pdf = await as('proc.mo').get('/api/processor/reports/incomplete.pdf').buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((await as('gis.mo').get('/api/processor/reports/registered')).status).toBe(403);
      const analytics = (await as('proc.mo').get('/api/processor/analytics')).body;
      expect(analytics.registeredOverTime.length).toBeGreaterThan(20);
      expect(analytics.byCategory[0].count).toBeGreaterThan(0);
    });

    it('lets only administrators configure categories and requirements, with a versioned reason', async () => {
      expect((await as('proc.mo').post('/api/application-config/categories', { code: 'lease_registration', label: 'Lease registration', caseType: 'transfer', reason: 'Requested by the office' })).status).toBe(403);
      expect((await as('admin').post('/api/application-config/categories', { code: 'lease_registration', label: 'Lease registration', caseType: 'transfer', reason: 'Requested by the office' })).status).toBe(201);
      const req = await as('admin').post('/api/application-config/requirements', { categoryCode: 'lease_registration', kind: 'document', docCategory: 'deed', stage: 'submission', reason: 'Lease agreement must be attached' });
      expect(req.status).toBe(201);
      const cfg = (await as('proc.mo').get('/api/application-config')).body;
      expect(cfg.canManage).toBe(false);
      expect(cfg.history.slice(0, 2).map((h: any) => h.entity)).toEqual(['requirement', 'category']);
      expect((await as('proc.mo').get('/api/applications/categories')).body.categories.some((c: any) => c.code === 'lease_registration')).toBe(true);
    });
  });
});
