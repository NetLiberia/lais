import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end API tests against a real PostgreSQL + PostGIS database.
 * Set TEST_DATABASE_URL to a DISPOSABLE database: every run drops and recreates its schemas.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const PASSWORD = 'integration-test-password';
const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

type App = Parameters<typeof request>[0];
let app: App;
let pool: import('pg').Pool;

class Client {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor(public username: string) {
    this.agent = request.agent(app);
  }
  async login() {
    const res = await this.agent.post('/api/auth/login').send({ username: this.username, password: PASSWORD });
    expect(res.status, `login ${this.username}`).toBe(200);
    const s = await this.agent.get('/api/auth/session');
    this.csrf = s.body.csrfToken;
    return this;
  }
  get(url: string) {
    return this.agent.get(url);
  }
  post(url: string, body?: object) {
    return this.agent.post(url).set('X-CSRF-Token', this.csrf).send(body ?? {});
  }
  put(url: string, body: object) {
    return this.agent.put(url).set('X-CSRF-Token', this.csrf).send(body);
  }
  patch(url: string, body: object) {
    return this.agent.patch(url).set('X-CSRF-Token', this.csrf).send(body);
  }
  upload(url: string, file: Buffer, filename: string, fields: Record<string, string>) {
    let r = this.agent.post(url).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, filename);
  }
}

const users: Record<string, Client> = {};
const as = (u: string) => users[u];

async function partyId(name: string): Promise<string> {
  const res = await as('proc.mo').get(`/api/parties?q=${encodeURIComponent(name)}`);
  expect(res.status).toBe(200);
  return res.body[0].id;
}

/** Prepares a first-registration case in Montserrado up to the point of submission. */
async function prepareRegistration(geojson: string, opts: { srid?: string; owner?: string; withDocs?: boolean } = {}) {
  const created = await as('gis.mo').post('/api/cases', {
    caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-SURVEY-TEST',
  });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const imp = await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture(geojson), geojson, { crs: opts.srid ?? '4326' });
  expect(imp.status).toBe(201);

  const right = await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId(opts.owner ?? 'Hawa'), rrrType: 'ownership' });
  expect(right.status).toBe(201);

  if (opts.withDocs !== false) {
    const plan = await as('gis.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'plan.pdf', { docType: 'survey_plan', classification: 'restricted', referenceNo: 'SP-1' });
    expect(plan.status).toBe(201);
    const deed = await as('proc.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'deed.pdf', { docType: 'deed', classification: 'restricted', referenceNo: 'D-1' });
    expect(deed.status).toBe(201);
    expect((await as('proc.mo').post(`/api/cases/${id}/documents/${plan.body.id}/verify`, { status: 'verified', note: 'Checked against source' })).status).toBe(200);
    expect((await as('proc2.mo').post(`/api/cases/${id}/documents/${deed.body.id}/verify`, { status: 'verified', note: 'Checked against source' })).status).toBe(200);
  }
  return id;
}

async function submit(id: string) {
  const res = await as('gis.mo').post(`/api/cases/${id}/submit`);
  expect(res.status).toBe(200);
  return res.body as { status: string; findings: { code: string; severity: string }[] };
}

async function caseDetail(id: string, who = 'reg.mo') {
  const res = await as(who).get(`/api/cases/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function approve(id: string) {
  return as('reg.mo').post(`/api/cases/${id}/decision`, { decision: 'approved', reason: 'Evidence reviewed and consistent', authorityBasis: 'Synthetic delegation ref TEST-001' });
}

/** Registrar acknowledges every warning on the latest validation run. */
async function acknowledgeAll(id: string) {
  for (const f of (await caseDetail(id)).validation.findings) {
    if (f.severity === 'warning') {
      expect((await as('reg.mo').post(`/api/cases/${id}/findings/${f.id}/acknowledge`, { note: 'Reviewed for this test' })).status).toBe(200);
    }
  }
}

describe.skipIf(!TEST_DB)('LAIS API (integration)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.NODE_ENV = 'test';
    process.env.MFA_ENCRYPTION_KEY ||= 'a'.repeat(64);
    process.env.DOCUMENT_STORAGE_DIR = path.join(tmpdir(), `lais-test-docs-${process.pid}`);
    const { resetDatabase } = await import('../../src/reset.js');
    await resetDatabase(PASSWORD, () => undefined);
    app = (await import('../../src/app.js')).createApp();
    pool = (await import('../../src/db.js')).pool;
    for (const u of ['admin', 'gis.mo', 'gis.mg', 'proc.mo', 'proc2.mo', 'proc.mg', 'reg.mo', 'reg.mg', 'supervisor', 'sup.mo', 'auditor', 'owner.demo']) {
      users[u] = await new Client(u).login();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('public portal privacy', () => {
    it('serves only the public field list and no personal data', async () => {
      const res = await request(app).get('/api/public/parcels?bbox=-10.81,6.29,-10.79,6.31');
      expect(res.status).toBe(200);
      expect(res.body.features.length).toBeGreaterThan(0);
      for (const f of res.body.features) {
        expect(Object.keys(f.properties).sort()).toEqual(['county', 'land_category', 'land_use', 'record_status', 'upi']);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/Testperson|SYN-ID|Bank/);
    });

    it('does not rate-limit signed-in staff using the map', async () => {
      // More requests than the anonymous per-address limit (300 a minute).
      const statuses = new Set<number>();
      for (let i = 0; i < 310; i++) {
        statuses.add((await as('reg.mo').get(`/api/public/parcels?bbox=-10.81,6.29,-10.79,${(6.31 + i * 1e-6).toFixed(6)}`)).status);
      }
      expect([...statuses]).toEqual([200]);
    });

    it('refuses very large bounding boxes', async () => {
      const res = await request(app).get('/api/public/parcels?bbox=-12,4,-7,9');
      expect(res.body.features).toEqual([]);
      expect(res.body.truncated).toBe(true);
    });
  });

  describe('authentication and request protection', () => {
    it('requires a session for internal endpoints', async () => {
      expect((await request(app).get('/api/cases')).status).toBe(401);
    });

    it('rejects state-changing requests without the CSRF token', async () => {
      const res = await as('gis.mo').agent.post('/api/cases').send({ caseType: 'first_registration', countyId: 1 });
      expect(res.status).toBe(403);
    });

    it('limits sign-in attempts per account without locking out colleagues on the same network', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await request(app).post('/api/auth/login').send({ username: 'guessed.account', password: `wrong-${i}` })).status).toBe(401);
      }
      expect((await request(app).post('/api/auth/login').send({ username: 'guessed.account', password: 'wrong-again' })).status).toBe(429);
      // Same address, different account: unaffected.
      expect((await new Client('supervisor').agent.post('/api/auth/login').send({ username: 'supervisor', password: PASSWORD })).status).toBe(200);
    });

    it('does not count successful sign-ins towards the per-account limit', async () => {
      for (let i = 0; i < 12; i++) {
        expect((await request(app).post('/api/auth/login').send({ username: 'auditor', password: PASSWORD })).status).toBe(200);
      }
    });

    it('gives the same answer for unknown users and wrong passwords', async () => {
      const a = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
      const b = await request(app).post('/api/auth/login').send({ username: 'gis.mo', password: 'wrong-password' });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body.error).toBe(b.body.error);
    });
  });

  describe('first registration end to end', () => {
    let caseId: string;

    it('validates a clean submission into review', async () => {
      caseId = await prepareRegistration('valid_parcel_4326.geojson');
      const result = await submit(caseId);
      expect(result.findings).toEqual([]);
      expect(result.status).toBe('under_review');
    });

    it('blocks a registrar from another county, even with a direct API call, and audits it', async () => {
      const res = await as('reg.mg').post(`/api/cases/${caseId}/decision`, { decision: 'approved', reason: 'Trying across county', authorityBasis: 'none' });
      expect(res.status).toBe(403);
      const view = await as('reg.mg').get(`/api/cases/${caseId}`);
      expect(view.status).toBe(403);
      const { rows } = await pool.query(`SELECT * FROM audit.event WHERE action = 'authz.denied' AND case_id = $1 AND actor_username = 'reg.mg'`, [caseId]);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('does not let an administrator or supervisor approve', async () => {
      for (const u of ['admin', 'supervisor']) {
        expect((await as(u).post(`/api/cases/${caseId}/decision`, { decision: 'approved', reason: 'Not my role', authorityBasis: 'none' })).status).toBe(403);
      }
    });

    it('approves and publishes atomically, creating a registered right', async () => {
      expect((await approve(caseId)).status).toBe(200);
      const pub = await as('reg.mo').post(`/api/cases/${caseId}/publish`);
      expect(pub.status).toBe(200);
      expect(pub.body.upi).toMatch(/^PROV-MO-\d{6}$/);

      const parcel = await as('reg.mo').get(`/api/parcels/${pub.body.upi}`);
      expect(parcel.status).toBe(200);
      expect(parcel.body.currentRights).toHaveLength(1);
      expect(parcel.body.currentRights[0]).toMatchObject({ party_name: 'Hawa Testperson', interest_status: 'registered' });
      expect(Number(parcel.body.versions[0].area_m2_calculated)).toBeGreaterThan(10_000);

      const pub2 = await request(app).get(`/api/public/parcels/${pub.body.upi}`);
      expect(pub2.status).toBe(200);
      expect(JSON.stringify(pub2.body)).not.toMatch(/Hawa/);
    });

    it('cannot publish the same case twice', async () => {
      expect((await as('reg.mo').post(`/api/cases/${caseId}/publish`)).status).toBe(403);
    });
  });

  describe('spatial validation and conflict detection', () => {
    const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

    it('flags overlaps with published parcels as warnings that must be acknowledged', async () => {
      const id = await prepareRegistration('overlap_published_4326.geojson');
      const result = await submit(id);
      expect(result.status).toBe('under_review');
      const overlaps = result.findings.filter((f) => f.code === 'OVERLAP_PUBLISHED_PARCEL');
      expect(overlaps.length).toBe(4);

      const blocked = await approve(id);
      expect(blocked.status).toBe(409);

      const detail = await caseDetail(id);
      for (const f of detail.validation.findings) {
        expect((await as('reg.mo').post(`/api/cases/${id}/findings/${f.id}/acknowledge`, { note: 'Field check arranged; boundary difference documented' })).status).toBe(200);
      }
      expect((await approve(id)).status).toBe(200);
    });

    it('does not treat a shared boundary as a conflict', async () => {
      const id = await prepareRegistration('adjacent_touching_4326.geojson');
      expect(codes(await submit(id))).toEqual([]);
    });

    it('flags a near-identical geometry as a suspected duplicate', async () => {
      const id = await prepareRegistration('duplicate_of_mo5_4326.geojson');
      expect(codes(await submit(id))).toContain('DUPLICATE_GEOMETRY_SUSPECTED');
    });

    it('returns invalid, swapped and cross-boundary geometries without repairing them', async () => {
      const cases: [string, string][] = [
        ['self_intersecting_4326.geojson', 'GEOMETRY_INVALID'],
        ['swapped_axes_4326.geojson', 'AXIS_ORDER_SWAPPED_SUSPECTED'],
        ['crosses_county_4326.geojson', 'CROSSES_COUNTY_BOUNDARY'],
      ];
      for (const [file, code] of cases) {
        const id = await prepareRegistration(file);
        const result = await submit(id);
        expect(result.status, file).toBe('returned');
        expect(codes(result), file).toContain(code);
      }
    });

    it('catches a wrong CRS declaration (metres declared as degrees)', async () => {
      const id = await prepareRegistration('valid_parcel_utm29n.geojson', { srid: '4326' });
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toContain('GEOMETRY_INVALID');
    });

    it('catches degrees declared as UTM metres', async () => {
      const id = await prepareRegistration('valid_parcel_4326.geojson', { srid: '32629' });
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toContain('OUTSIDE_NATIONAL_EXTENT');
    });

    it('accepts and transforms a correctly declared UTM 29N file', async () => {
      const id = await prepareRegistration('valid_parcel_utm29n.geojson', { srid: '32629' });
      const result = await submit(id);
      expect(codes(result).filter((c) => /GEOMETRY|EXTENT|COUNTY|AXIS/.test(c))).toEqual([]);
    });

    it('requires a declared CRS', async () => {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'first_registration', countyId: 1 });
      const res = await as('gis.mo').upload(`/api/cases/${created.body.id}/geometry`, fixture('valid_parcel_4326.geojson'), 'a.geojson', {});
      expect(res.status).toBe(400);
    });

    it('blocks submission when identity, shares or documents are missing', async () => {
      const id = await prepareRegistration('valid_parcel_4326.geojson', { owner: 'Unverified', withDocs: false });
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toEqual(expect.arrayContaining(['PARTY_IDENTITY_UNVERIFIED', 'MISSING_SURVEY_PLAN', 'MISSING_EVIDENCE_OF_INTEREST']));
    });
  });

  describe('data integrity', () => {
    it('rolls back a failed publication completely', async () => {
      const id = await prepareRegistration('valid_parcel_4326.geojson', { owner: 'Varney' });
      // Overlaps the parcel published earlier in this run; acknowledge so it can be approved.
      await submit(id);
      for (const f of (await caseDetail(id)).validation.findings) {
        await as('reg.mo').post(`/api/cases/${id}/findings/${f.id}/acknowledge`, { note: 'Acknowledged for rollback test' });
      }
      expect((await approve(id)).status).toBe(200);
      const before = (await pool.query('SELECT count(*)::int AS n FROM lais.parcel')).rows[0].n;
      const res = await as('reg.mo').post(`/api/cases/${id}/publish`, { simulateFailure: true });
      expect(res.status).toBe(500);
      expect((await pool.query('SELECT count(*)::int AS n FROM lais.parcel')).rows[0].n).toBe(before);
      expect((await caseDetail(id)).case.status).toBe('approved');
      const { rows } = await pool.query(`SELECT * FROM audit.event WHERE case_id = $1 AND action = 'case.publish' AND outcome = 'failure'`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('refuses a status change that skips the workflow, even in SQL', async () => {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'first_registration', countyId: 1 });
      await expect(pool.query(`UPDATE lais.land_case SET status = 'published' WHERE id = $1`, [created.body.id])).rejects.toThrow(/Illegal case status transition/);
    });

    it('keeps published history immutable', async () => {
      await expect(pool.query(`DELETE FROM lais.parcel_version`)).rejects.toThrow(/cannot be deleted/);
      await expect(pool.query(`UPDATE lais.rrr SET party_id = party_id`)).rejects.toThrow(/immutable/);
    });

    it('keeps the audit log append-only and the hash chain intact', async () => {
      await expect(pool.query(`UPDATE audit.event SET outcome = 'success'`)).rejects.toThrow(/append-only/);
      await expect(pool.query(`DELETE FROM audit.event`)).rejects.toThrow(/append-only/);
      const v = await as('auditor').get('/api/audit/verify');
      expect(v.status).toBe(200);
      expect(v.body.intact).toBe(true);
      expect(v.body.checked).toBeGreaterThan(10);
    });

    it('detects tampering with the audit chain', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit.event DISABLE TRIGGER event_no_update');
        await client.query(`UPDATE audit.event SET detail = '{"tampered": true}' WHERE chain_seq = 2`);
        const { rows: [r] } = await client.query('SELECT * FROM audit.verify_chain()');
        expect(r.first_bad_seq).toBe('2');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('transfers', () => {
    async function prepareTransfer(upi: string, toParty: string) {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: upi, sourceReference: 'SYNTHETIC-TRANSFER' });
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect((await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId(toParty), rrrType: 'ownership' })).status).toBe(201);
      const deed = await as('proc.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'deed.pdf', { docType: 'deed', classification: 'restricted' });
      expect((await as('proc2.mo').post(`/api/cases/${id}/documents/${deed.body.id}/verify`, { status: 'verified', note: 'Deed checked' })).status).toBe(200);
      return id;
    }

    it('ends the old interest, registers the new one and keeps history', async () => {
      const id = await prepareTransfer('PROV-MO-000001', 'Comfort');
      const sub = await as('proc.mo').post(`/api/cases/${id}/submit`);
      expect(sub.body.status).toBe('under_review');
      expect((await approve(id)).status).toBe(200);
      expect((await as('reg.mo').post(`/api/cases/${id}/publish`)).status).toBe(200);

      const parcel = (await as('reg.mo').get('/api/parcels/PROV-MO-000001')).body;
      expect(parcel.currentRights.map((r: any) => r.party_name)).toEqual(['Comfort Testperson']);
      expect(parcel.historicalRights.map((r: any) => r.party_name)).toContain('Musu Testperson');
      expect(parcel.versions).toHaveLength(1); // a transfer does not change the boundary
    });

    it('updates what the landowner portal shows', async () => {
      const mine = await as('owner.demo').get('/api/me/parcels');
      expect(mine.status).toBe(200);
      expect(mine.body.map((p: any) => p.upi)).toEqual(['PROV-MO-000011']);
      expect((await as('owner.demo').get('/api/parcels/PROV-MO-000011')).status).toBe(403);
    });

    it('blocks transfers of disputed parcels', async () => {
      const id = await prepareTransfer('PROV-MO-000007', 'Hawa');
      const sub = await as('proc.mo').post(`/api/cases/${id}/submit`);
      expect(sub.body.status).toBe('returned');
      expect(sub.body.findings.map((f: any) => f.code)).toContain('PARCEL_DISPUTED');
    });

    it('reopens an approval when the parcel changed before publication', async () => {
      const a = await prepareTransfer('PROV-MO-000009', 'Hawa');
      const b = await prepareTransfer('PROV-MO-000009', 'Joseph');
      for (const id of [a, b]) {
        await as('proc.mo').post(`/api/cases/${id}/submit`);
        await acknowledgeAll(id); // each case is warned that the other acts on the same parcel
        expect((await approve(id)).status).toBe(200);
      }
      expect((await as('reg.mo').post(`/api/cases/${a}/publish`)).status).toBe(200);
      const second = await as('reg.mo').post(`/api/cases/${b}/publish`);
      expect(second.status).toBe(409);
      expect((await caseDetail(b)).case.status).toBe('under_review');
    });
  });

  describe('subdivision and consolidation', () => {
    const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

    async function addVerifiedSurveyPlan(id: string) {
      const plan = await as('gis.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'plan.pdf', { docType: 'survey_plan', classification: 'restricted' });
      expect(plan.status).toBe(201);
      expect((await as('proc.mo').post(`/api/cases/${id}/documents/${plan.body.id}/verify`, { status: 'verified', note: 'Survey plan checked' })).status).toBe(200);
    }

    it('rejects a split that leaves a gap, and one whose parts overlap', async () => {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'subdivision', parcelUpi: 'PROV-MO-000008', sourceReference: 'SYNTHETIC-SUBDIVISION' });
      expect(created.status).toBe(201);
      const id = created.body.id;

      await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('subdivide_mo8_gap_4326.geojson'), 'gap.geojson', { crs: '4326' });
      let result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toContain('COVERAGE_GAP');

      await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('subdivide_mo8_overlap_4326.geojson'), 'overlap.geojson', { crs: '4326' });
      result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toContain('NEW_PARCELS_OVERLAP');
      expect(codes(result)).not.toContain('COVERAGE_GAP');

      expect((await as('gis.mo').post(`/api/cases/${id}/withdraw`, { reason: 'Superseded by a corrected survey' })).status).toBe(200);
    });

    it('requires at least two new parcels', async () => {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'subdivision', parcelUpi: 'PROV-MO-000008' });
      const res = await as('gis.mo').upload(`/api/cases/${created.body.id}/geometry`, fixture('consolidate_mo8_halves_4326.geojson'), 'one.geojson', { crs: '4326' });
      expect(res.status).toBe(400);
      await as('gis.mo').post(`/api/cases/${created.body.id}/withdraw`, { reason: 'Test case not needed' });
    });

    let children: string[] = [];

    it('subdivides a parcel: retires it, creates the parts and records lineage', async () => {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'subdivision', parcelUpi: 'PROV-MO-000008', sourceReference: 'SYNTHETIC-SUBDIVISION' });
      const id = created.body.id;
      expect((await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('subdivide_mo8_halves_4326.geojson'), 'halves.geojson', { crs: '4326' })).status).toBe(201);
      await addVerifiedSurveyPlan(id);

      // Rights must name a target parcel; the copy helper proposes the parent's ownership on each part.
      expect((await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId('Hawa'), rrrType: 'ownership' })).status).toBe(400);
      const copied = await as('proc.mo').post(`/api/cases/${id}/rights/copy-from-source`);
      expect(copied.status).toBe(201);
      expect(copied.body.created).toBe(2);

      const result = await submit(id);
      expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(result.status).toBe('under_review');

      await acknowledgeAll(id);
      expect((await approve(id)).status).toBe(200);
      const pub = await as('reg.mo').post(`/api/cases/${id}/publish`);
      expect(pub.status).toBe(200);
      children = pub.body.upi.split(', ');
      expect(children).toHaveLength(2);

      const parent = (await as('reg.mo').get('/api/parcels/PROV-MO-000008')).body;
      expect(parent.parcel.status).toBe('retired');
      expect(parent.currentRights).toEqual([]);
      expect(parent.children.map((c: any) => c.upi)).toEqual(children);
      expect(parent.versions[0].valid_to).not.toBeNull();

      for (const upi of children) {
        const child = (await as('reg.mo').get(`/api/parcels/${upi}`)).body;
        expect(child.parents.map((p: any) => p.upi)).toEqual(['PROV-MO-000008']);
        expect(child.currentRights.map((r: any) => r.party_name)).toEqual(['Sample Trading Company (synthetic)']);
        expect(Number(child.versions[0].area_m2_calculated)).toBeGreaterThan(5000);
      }

      const old = await request(app).get('/api/public/parcels/PROV-MO-000008');
      expect(old.status).toBe(404);
      expect(old.body.error).toContain(children[0]);
    });

    it('refuses new cases on a retired parcel', async () => {
      const res = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000008' });
      expect(res.status).toBe(409);
    });

    it('consolidates the parts back into one parcel', async () => {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'consolidation', parcelUpis: children, sourceReference: 'SYNTHETIC-CONSOLIDATION' });
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect((await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('consolidate_mo8_halves_4326.geojson'), 'merged.geojson', { crs: '4326' })).status).toBe(201);
      await addVerifiedSurveyPlan(id);
      expect((await as('proc2.mo').post(`/api/cases/${id}/rights`, { partyId: (await as('proc.mo').get('/api/parties?q=Trading')).body[0].id, rrrType: 'ownership' })).status).toBe(201);

      const result = await submit(id);
      expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
      await acknowledgeAll(id);
      expect((await approve(id)).status).toBe(200);
      const pub = await as('reg.mo').post(`/api/cases/${id}/publish`);
      expect(pub.status).toBe(200);
      expect(pub.body.upi).toMatch(/^PROV-MO-\d{6}$/);

      const merged = (await as('reg.mo').get(`/api/parcels/${pub.body.upi}`)).body;
      expect(merged.parents.map((p: any) => p.upi).sort()).toEqual([...children].sort());
      for (const upi of children) expect((await as('reg.mo').get(`/api/parcels/${upi}`)).body.parcel.status).toBe('retired');
      // History stays intact: the retired parcels keep their closed versions and ended rights.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM lais.rrr r JOIN lais.parcel p ON p.id = r.parcel_id WHERE p.upi = ANY($1) AND r.valid_to IS NOT NULL`,
        [children],
      );
      expect(rows[0].n).toBe(2);
    });

    it('rejects a consolidation that does not match the merged parcels', async () => {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'consolidation', parcelUpis: ['PROV-MO-000011', 'PROV-MO-000012'] });
      const id = created.body.id;
      await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('valid_parcel_4326.geojson'), 'wrong.geojson', { crs: '4326' });
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toEqual(expect.arrayContaining(['COVERAGE_GAP', 'COVERAGE_EXCEEDS_SOURCE']));
      // A lease on PROV-MO-000012 ends at retirement unless re-recorded, so the officer is warned.
      expect(codes(result)).toContain('ENCUMBRANCE_PRESENT');
    });
  });

  describe('corrections', () => {
    const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

    async function openCorrection(upi: string, reason?: string) {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'correction', parcelUpi: upi, correctionReason: reason });
      expect(created.status).toBe(201);
      return created.body.id as string;
    }

    async function addVerified(id: string, docType: string) {
      const doc = await as('gis.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'evidence.pdf', { docType, classification: 'restricted' });
      expect((await as('proc.mo').post(`/api/cases/${id}/documents/${doc.body.id}/verify`, { status: 'verified', note: 'Evidence checked' })).status).toBe(200);
    }

    async function approveAndPublish(id: string) {
      await acknowledgeAll(id);
      expect((await approve(id)).status).toBe(200);
      return as('reg.mo').post(`/api/cases/${id}/publish`);
    }

    it('rejects a correction that changes nothing or gives no reason', async () => {
      const id = await openCorrection('PROV-MO-000004');
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result)).toEqual(expect.arrayContaining(['NO_CHANGE', 'CORRECTION_REASON_MISSING', 'MISSING_CORRECTION_EVIDENCE']));
      await as('gis.mo').post(`/api/cases/${id}/withdraw`, { reason: 'Opened in error' });
    });

    it('never changes rights', async () => {
      const id = await openCorrection('PROV-MO-000004', 'Land use was recorded incorrectly at initial load');
      const res = await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId('Hawa'), rrrType: 'ownership' });
      expect(res.status).toBe(403);
      await as('gis.mo').post(`/api/cases/${id}/withdraw`, { reason: 'Test case not needed' });
    });

    it('corrects attributes by publishing a new version and keeping the old one', async () => {
      const id = await openCorrection('PROV-MO-000004', 'Land use and surveyed area were transcribed incorrectly from the 2019 register');
      expect((await as('gis.mo').patch(`/api/cases/${id}`, { landUse: 'institutional (school)', areaM2Surveyed: 12200 })).status).toBe(200);
      await addVerified(id, 'other');
      const result = await submit(id);
      expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
      const pub = await approveAndPublish(id);
      expect(pub.status).toBe(200);

      const record = (await as('reg.mo').get('/api/parcels/PROV-MO-000004')).body;
      expect(record.versions).toHaveLength(2);
      const [v2, v1] = record.versions;
      expect(v2).toMatchObject({ version_no: 2, land_use: 'institutional (school)', valid_to: null });
      expect(Number(v2.area_m2_surveyed)).toBe(12200);
      expect(v1.land_use).toBe('institutional');
      expect(v1.valid_to).not.toBeNull();
      expect(v2.area_m2_calculated).toBe(v1.area_m2_calculated); // boundary unchanged
      expect(record.currentRights.map((r: any) => r.party_name)).toEqual(['Example Ministry (synthetic government entity)']);
    });

    it('needs a survey plan for a boundary correction, and accepts a minor fix without a warning', async () => {
      const id = await openCorrection('PROV-MO-000003', 'East boundary beacon was mis-recorded by about 2 metres');
      await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('correct_mo3_minor_4326.geojson'), 'minor.geojson', { crs: '4326' });
      await addVerified(id, 'other');
      let result = await submit(id);
      expect(codes(result)).toContain('MISSING_SURVEY_PLAN');

      await addVerified(id, 'survey_plan');
      result = await submit(id);
      expect(result.status).toBe('under_review');
      expect(codes(result)).not.toContain('SIGNIFICANT_BOUNDARY_CHANGE');
      const before = (await as('reg.mo').get('/api/parcels/PROV-MO-000003')).body.versions[0];
      expect((await approveAndPublish(id)).status).toBe(200);
      const after = (await as('reg.mo').get('/api/parcels/PROV-MO-000003')).body.versions[0];
      expect(after.version_no).toBe(2);
      expect(Number(after.area_m2_calculated)).toBeGreaterThan(Number(before.area_m2_calculated));
    });

    it('flags a large boundary change for the registrar', async () => {
      const id = await openCorrection('PROV-MO-000003', 'South boundary claimed to be wrong on the original survey');
      await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('correct_mo3_major_4326.geojson'), 'major.geojson', { crs: '4326' });
      await addVerified(id, 'survey_plan');
      const result = await submit(id);
      expect(codes(result)).toContain('SIGNIFICANT_BOUNDARY_CHANGE');
      await as('reg.mo').post(`/api/cases/${id}/decision`, { decision: 'returned', reason: 'Needs field verification before a change this size' });
    });

    it('reopens an approved correction if the parcel was corrected again in the meantime', async () => {
      const a = await openCorrection('PROV-MO-000005', 'Land use recorded incorrectly (first correction)');
      const b = await openCorrection('PROV-MO-000005', 'Source reference recorded incorrectly (second correction)');
      await as('gis.mo').patch(`/api/cases/${a}`, { landUse: 'mixed use' });
      await as('gis.mo').patch(`/api/cases/${b}`, { sourceReference: 'SYNTHETIC-SURVEY-0005-REV' });
      for (const id of [a, b]) {
        await addVerified(id, 'other');
        await submit(id);
        await acknowledgeAll(id);
        expect((await approve(id)).status).toBe(200);
      }
      expect((await as('reg.mo').post(`/api/cases/${b}/publish`)).status).toBe(200);
      expect((await as('reg.mo').post(`/api/cases/${a}/publish`)).status).toBe(409);
      expect((await caseDetail(a)).case.status).toBe('under_review');
    });
  });

  describe('legacy migration', () => {
    const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

    async function openMigration(file: string, source = 'SYNTHETIC 1990 county register extract') {
      const created = await as('gis.mo').post('/api/cases', { caseType: 'migration', countyId: 1, sourceReference: source });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect((await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture(file), file, { crs: '4326' })).status).toBe(201);
      const doc = await as('gis.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'register-extract.pdf', { docType: 'other', classification: 'restricted', referenceNo: 'REGISTER-EXTRACT' });
      expect((await as('proc.mo').post(`/api/cases/${id}/documents/${doc.body.id}/verify`, { status: 'verified', note: 'Extract matches the register' })).status).toBe(200);
      return id;
    }

    async function report(id: string) {
      const res = await as('reg.mo').get(`/api/cases/${id}/migration-report.csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      return res.text.split('\r\n');
    }

    let problemCase = '';

    it('flags each faulty legacy record against its own feature', async () => {
      problemCase = await openMigration('legacy_register_problems_mo_4326.geojson');
      const result = await submit(problemCase);
      expect(result.status).toBe('returned');
      const byFeature = new Map<number, string[]>();
      for (const f of (await caseDetail(problemCase)).validation.findings) {
        byFeature.set(f.feature_index, [...(byFeature.get(f.feature_index) ?? []), f.code]);
      }
      expect(byFeature.get(0)).toBeUndefined();
      expect(byFeature.get(1)).toContain('DUPLICATE_LEGACY_REF');
      expect(byFeature.get(2)).toContain('DUPLICATE_LEGACY_REF');
      expect(byFeature.get(3)).toContain('LEGACY_ATTRIBUTE_INVALID');
      expect(byFeature.get(4)).toContain('GEOMETRY_INVALID');
      expect(byFeature.get(5)).toContain('MIGRATION_INTERNAL_OVERLAP');
      expect(byFeature.get(7)).toContain('LEGACY_ATTRIBUTE_INVALID');
    });

    it('reports every imported feature with its outcome', async () => {
      const lines = await report(problemCase);
      expect(lines[0]).toContain('legacy_ref');
      expect(lines.filter((l) => /^"\d+"/.test(l))).toHaveLength(8);
      expect(lines.at(-1)).toContain('8 feature(s) imported');
    });

    it('lets only the GIS officer quarantine features, with a reason', async () => {
      expect((await as('proc.mo').post(`/api/cases/${problemCase}/features/1/exclusion`, { excluded: true, reason: 'Duplicate reference' })).status).toBe(403);
      expect((await as('gis.mo').post(`/api/cases/${problemCase}/features/1/exclusion`, { excluded: true })).status).toBe(400);
      for (const [index, reason] of [[1, 'Duplicate reference; to be resolved with the register custodian'], [2, 'Duplicate reference; to be resolved with the register custodian'],
        [3, 'Category not recognised under the Land Rights Act'], [4, 'Self-intersecting boundary; needs re-digitising'], [7, 'No legacy reference on the source sheet']] as const) {
        expect((await as('gis.mo').post(`/api/cases/${problemCase}/features/${index}/exclusion`, { excluded: true, reason })).status).toBe(200);
      }
    });

    it('publishes the remaining features as documented, not registered, records', async () => {
      const result = await submit(problemCase);
      expect(result.status).toBe('under_review');
      expect(codes(result)).toEqual(['MIGRATION_INTERNAL_OVERLAP']);
      await acknowledgeAll(problemCase);
      expect((await approve(problemCase)).status).toBe(200);
      const pub = await as('reg.mo').post(`/api/cases/${problemCase}/publish`);
      expect(pub.status).toBe(200);
      expect(pub.body.upi).toBe('3 migrated parcel(s)');

      const lines = await report(problemCase);
      expect(lines.at(-1)).toMatch(/3 published, 5 excluded/);
      const first = (await caseDetail(problemCase)).staged.features[0];
      const parcel = (await as('reg.mo').get(`/api/parcels/${first.published_upi}`)).body;
      expect(parcel.parcel.legacy_ref).toBe('LR-MO-1990-0001');
      expect(parcel.cases.map((c: any) => c.case_type)).toEqual(['migration']);
      expect(parcel.currentRights).toEqual([expect.objectContaining({ party_name: 'Clean Record Legacyname', interest_status: 'documented', identity_status: 'unverified' })]);
      const publicRecord = await request(app).get(`/api/public/parcels/${first.published_upi}`);
      expect(publicRecord.body.properties.record_status).toBe('recorded, interests not yet verified');
    });

    it('migrates a clean register batch and records holders as stated', async () => {
      const id = await openMigration('legacy_register_mo_4326.geojson');
      const result = await submit(id);
      expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
      await acknowledgeAll(id);
      expect((await approve(id)).status).toBe(200);
      expect((await as('reg.mo').post(`/api/cases/${id}/publish`)).body.upi).toBe('10 migrated parcel(s)');

      const { rows } = await pool.query(
        `SELECT p.legacy_ref, r.rrr_type, r.interest_status, r.share_num, pa.party_type, pa.origin
           FROM lais.parcel p JOIN lais.rrr r ON r.parcel_id = p.id JOIN lais.party pa ON pa.id = r.party_id
          WHERE p.legacy_ref IN ('LR-MO-1987-0002', 'LR-MO-1987-0003') ORDER BY p.legacy_ref, pa.name`,
      );
      expect(rows).toEqual([
        { legacy_ref: 'LR-MO-1987-0002', rrr_type: 'co_ownership', interest_status: 'documented', share_num: null, party_type: 'person', origin: 'migration' },
        { legacy_ref: 'LR-MO-1987-0002', rrr_type: 'co_ownership', interest_status: 'documented', share_num: null, party_type: 'person', origin: 'migration' },
        { legacy_ref: 'LR-MO-1987-0003', rrr_type: 'customary_tenure', interest_status: 'documented', share_num: null, party_type: 'community', origin: 'migration' },
      ]);
    });

    it('can be re-run safely: already-migrated records are refused', async () => {
      const id = await openMigration('legacy_register_mo_4326.geojson');
      const result = await submit(id);
      expect(result.status).toBe('returned');
      expect(codes(result).filter((c) => c === 'ALREADY_MIGRATED')).toHaveLength(10);
    });

    describe('confirming documented interests', () => {
      const upiOf = async (legacyRef: string) =>
        (await pool.query('SELECT upi FROM lais.parcel WHERE legacy_ref = $1', [legacyRef])).rows[0].upi as string;

      async function verifiedParty(name: string) {
        const created = await as('proc.mo').post('/api/parties', { partyType: 'person', name, nationalIdRef: `SYN-ID-${name.length}` });
        expect(created.status).toBe(201);
        expect((await as('proc2.mo').post(`/api/parties/${created.body.id}/verify-identity`, { note: 'Synthetic ID card seen' })).status).toBe(200);
        return created.body.id as string;
      }

      async function openConfirmation(upi: string) {
        const created = await as('proc.mo').post('/api/cases', { caseType: 'confirmation', parcelUpi: upi, sourceReference: 'SYNTHETIC verification visit' });
        expect(created.status).toBe(201);
        const id = created.body.id as string;
        const deed = await as('proc.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'deed.pdf', { docType: 'deed', classification: 'restricted' });
        await as('proc2.mo').post(`/api/cases/${id}/documents/${deed.body.id}/verify`, { status: 'verified', note: 'Original deed seen' });
        return id;
      }

      it('refuses to confirm a parcel that already has a registered owner', async () => {
        const id = await openConfirmation('PROV-MO-000002');
        await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId('Hawa'), rrrType: 'ownership' });
        expect(codes(await submit(id))).toContain('ALREADY_REGISTERED');
      });

      it('flags holders who differ from the legacy record', async () => {
        const id = await openConfirmation(await upiOf('LR-MO-1987-0001'));
        await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId('Hawa'), rrrType: 'ownership' });
        const result = await submit(id);
        expect(codes(result)).toEqual(expect.arrayContaining(['DOCUMENTED_HOLDER_NOT_CONFIRMED', 'HOLDER_NOT_IN_LEGACY_RECORD']));
        await as('reg.mo').post(`/api/cases/${id}/decision`, { decision: 'returned', reason: 'Holder does not match the legacy record' });
      });

      it('registers verified co-owners and keeps the legacy record as history', async () => {
        const upi = await upiOf('LR-MO-1987-0002');
        const id = await openConfirmation(upi);
        for (const name of ['Abraham Legacyname', 'Ruth Legacyname']) {
          const partyIdValue = await verifiedParty(name);
          expect((await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: partyIdValue, rrrType: 'co_ownership', shareNum: 1, shareDen: 2 })).status).toBe(201);
        }
        const result = await submit(id);
        expect(result.status).toBe('under_review');
        expect(codes(result)).not.toContain('HOLDER_NOT_IN_LEGACY_RECORD');
        await acknowledgeAll(id);
        expect((await approve(id)).status).toBe(200);
        expect((await as('reg.mo').post(`/api/cases/${id}/publish`)).status).toBe(200);

        const record = (await as('reg.mo').get(`/api/parcels/${upi}`)).body;
        expect(record.currentRights.map((r: any) => [r.party_name, r.interest_status, `${r.share_num}/${r.share_den}`])).toEqual([
          ['Abraham Legacyname', 'registered', '1/2'], ['Ruth Legacyname', 'registered', '1/2'],
        ].sort());
        expect(record.historicalRights.every((r: any) => r.interest_status === 'documented')).toBe(true);
        expect(record.historicalRights).toHaveLength(2);
        expect((await request(app).get(`/api/public/parcels/${upi}`)).body.properties.record_status).toBe('registered');
      });
    });
  });

  describe('documents and separation of duties', () => {
    it('stops an uploader verifying their own document', async () => {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000010' });
      const doc = await as('proc.mo').upload(`/api/cases/${created.body.id}/documents`, fixture('synthetic_document.pdf'), 'deed.pdf', { docType: 'deed', classification: 'restricted' });
      const res = await as('proc.mo').post(`/api/cases/${created.body.id}/documents/${doc.body.id}/verify`, { status: 'verified', note: 'Self check' });
      expect(res.status).toBe(403);
    });

    it('restricts highly sensitive documents and logs access', async () => {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000010' });
      const doc = await as('proc.mo').upload(`/api/cases/${created.body.id}/documents`, fixture('synthetic_document.pdf'), 'id.pdf', { docType: 'id_document', classification: 'highly_sensitive' });
      expect(doc.status).toBe(201);
      expect((await as('gis.mo').get(`/api/documents/${doc.body.id}/file`)).status).toBe(403);
      expect((await as('supervisor').get(`/api/documents/${doc.body.id}/file`)).status).toBe(403);
      expect((await as('owner.demo').get(`/api/documents/${doc.body.id}/file`)).status).toBe(403);
      const ok = await as('proc2.mo').get(`/api/documents/${doc.body.id}/file`);
      expect(ok.status).toBe(200);
      const { rows } = await pool.query(`SELECT * FROM audit.event WHERE action = 'document.access' AND entity_id = $1`, [doc.body.id]);
      expect(rows).toHaveLength(1);
    });

    it('refuses files that are not PDF, PNG or JPEG', async () => {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000010' });
      const res = await as('proc.mo').upload(`/api/cases/${created.body.id}/documents`, Buffer.from('<script>alert(1)</script>'), 'deed.pdf', { docType: 'deed', classification: 'restricted' });
      expect(res.status).toBe(400);
    });
  });

  describe('administration', () => {
    const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('token')!;
    const userId = async (username: string) => (await pool.query('SELECT id FROM lais.app_user WHERE username = $1', [username])).rows[0].id as string;
    let newUserId = '';
    let activationToken = '';

    it('keeps account management away from users without the permission', async () => {
      expect((await as('gis.mo').get('/api/admin/users')).status).toBe(403);
      expect((await as('gis.mo').post('/api/admin/users', { username: 'x.user', displayName: 'X', roles: [{ role: 'processor', countyId: 1 }], reason: 'Not allowed' })).status).toBe(403);
      // Supervisors may read accounts but not change them.
      expect((await as('supervisor').get('/api/admin/users')).status).toBe(200);
      expect((await as('supervisor').post('/api/admin/users', { username: 'x.user', displayName: 'X', roles: [{ role: 'processor', countyId: 1 }], reason: 'Not allowed' })).status).toBe(403);
    });

    it('does not let a GIS officer, or an administrator, raise their own privileges', async () => {
      const gisId = await userId('gis.mo');
      expect((await as('gis.mo').post(`/api/admin/users/${gisId}/roles`, { role: 'system_admin', reason: 'Self-elevation attempt' })).status).toBe(403);
      const adminId = await userId('admin');
      expect((await as('admin').post(`/api/admin/users/${adminId}/roles`, { role: 'registrar', countyId: 1, reason: 'Self escalation attempt' })).status).toBe(403);
      expect((await as('admin').post(`/api/admin/users/${adminId}/status`, { status: 'suspended', reason: 'Self suspension attempt' })).status).toBe(403);
    });

    it('rejects surveyor accounts and invalid role or county assignments', async () => {
      const base = { username: 'role.test', displayName: 'Role Test', reason: 'Testing assignment rules' };
      expect((await as('admin').post('/api/admin/users', { ...base, roles: [{ role: 'surveyor', countyId: 1 }] })).status).toBe(400);
      expect((await as('admin').post('/api/admin/users', { ...base, roles: [{ role: 'registrar' }] })).status).toBe(400);
      expect((await as('admin').post('/api/admin/users', { ...base, roles: [{ role: 'registrar', countyId: 999 }] })).status).toBe(400);
      expect((await as('admin').post('/api/admin/users', { ...base, roles: [{ role: 'system_admin', countyId: 1 }] })).status).toBe(400);
      expect((await as('admin').post('/api/admin/users', { ...base, roles: [{ role: 'system_admin' }, { role: 'registrar', countyId: 1 }] })).status).toBe(400);
      expect((await pool.query(`SELECT 1 FROM lais.app_user WHERE username = 'role.test'`)).rows).toHaveLength(0);
    });

    it('creates an invited account with a one-time activation link and audits it', async () => {
      const res = await as('admin').post('/api/admin/users', {
        username: 'new.gis', displayName: 'New GIS Officer (synthetic)', email: 'new.gis@example.invalid', staffId: 'SYN-900',
        department: 'County land office (synthetic)', roles: [{ role: 'gis_officer', countyId: 1 }], reason: 'New hire for the pilot county',
      });
      expect(res.status).toBe(201);
      newUserId = res.body.user.id;
      activationToken = tokenOf(res.body.activation.path);
      expect(activationToken.length).toBeGreaterThan(30);
      const { rows: [u] } = await pool.query('SELECT status, password_hash FROM lais.app_user WHERE id = $1', [newUserId]);
      expect(u).toEqual({ status: 'invited', password_hash: null });
      // Only the token's hash is stored.
      const { rows: tokens } = await pool.query('SELECT token_hash FROM lais.account_token WHERE user_id = $1', [newUserId]);
      expect(tokens[0].token_hash.toString('utf8')).not.toContain(activationToken);
      const { rows: events } = await pool.query(`SELECT detail FROM audit.event WHERE action = 'admin.user_create' AND entity_id = $1`, [newUserId]);
      expect(events[0].detail.reason).toBe('New hire for the pilot county');
    });

    it('rejects duplicate usernames, email addresses and staff identifiers', async () => {
      const roles = [{ role: 'processor', countyId: 1 }];
      expect((await as('admin').post('/api/admin/users', { username: 'new.gis', displayName: 'Dup', roles, reason: 'Duplicate test' })).status).toBe(409);
      expect((await as('admin').post('/api/admin/users', { username: 'other.one', displayName: 'Dup', email: 'NEW.GIS@example.invalid', roles, reason: 'Duplicate test' })).status).toBe(409);
      expect((await as('admin').post('/api/admin/users', { username: 'other.two', displayName: 'Dup', staffId: 'syn-900', roles, reason: 'Duplicate test' })).status).toBe(409);
    });

    it('only lets an invited person in after they set their own password, once', async () => {
      expect((await request(app).post('/api/auth/login').send({ username: 'new.gis', password: 'anything-at-all-1' })).status).toBe(401);
      const inspect = await request(app).post('/api/auth/token/inspect').send({ token: activationToken });
      expect(inspect.body).toMatchObject({ purpose: 'activation', username: 'new.gis' });
      expect((await request(app).post('/api/auth/token/complete').send({ token: activationToken, newPassword: 'short' })).status).toBe(400);
      expect((await request(app).post('/api/auth/token/complete').send({ token: activationToken, newPassword: 'new-gis-password-2026' })).status).toBe(200);
      expect((await request(app).post('/api/auth/token/complete').send({ token: activationToken, newPassword: 'another-password-2026' })).status).toBe(400);

      const agent = request.agent(app);
      expect((await agent.post('/api/auth/login').send({ username: 'new.gis', password: 'new-gis-password-2026' })).status).toBe(200);
      const session = (await agent.get('/api/auth/session')).body;
      expect(session.capabilities).toContain('case.import_geometry');
      expect(session.capabilities).not.toContain('user.manage');
    });

    it('resets a password by revoking sessions and issuing a link, never showing a password', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'new.gis', password: 'new-gis-password-2026' });
      expect((await agent.get('/api/cases')).status).toBe(200);
      const reset = await as('admin').post(`/api/admin/users/${newUserId}/password-reset`, { reason: 'User reported a lost password' });
      expect(reset.status).toBe(200);
      expect(JSON.stringify(reset.body)).not.toMatch(/password_hash|scrypt/);
      expect((await agent.get('/api/cases')).status).toBe(401);
      expect((await request(app).post('/api/auth/token/complete').send({ token: tokenOf(reset.body.path), newPassword: 'reset-gis-password-2026' })).status).toBe(200);
      expect((await request(app).post('/api/auth/login').send({ username: 'new.gis', password: 'reset-gis-password-2026' })).status).toBe(200);
    });

    it('lists, filters, sorts and pages staff accounts without exposing secrets', async () => {
      const page = await as('admin').get('/api/admin/users?role=processor&countyId=1&sort=username&dir=desc&pageSize=10');
      expect(page.status).toBe(200);
      expect(page.body.items.map((u: any) => u.username)).toEqual(['proc2.mo', 'proc.mo']);
      expect(page.body.total).toBe(2);
      expect(JSON.stringify(page.body)).not.toMatch(/password|mfa_secret|token_hash/);
      const search = await as('admin').get('/api/admin/users?q=SYN-900');
      expect(search.body.items.map((u: any) => u.username)).toEqual(['new.gis']);
      expect((await as('admin').get('/api/admin/users?pageSize=7')).status).toBe(400);
      const detail = await as('admin').get(`/api/admin/users/${newUserId}`);
      expect(detail.body.activity.map((e: any) => e.action)).toEqual(expect.arrayContaining(['admin.user_create', 'auth.account_activated']));
    });

    it('notifies people of changes to their roles, and only them', async () => {
      expect((await as('admin').post(`/api/admin/users/${newUserId}/roles`, { role: 'gis_officer', countyId: 2, reason: 'Covering Margibi as well' })).status).toBe(201);
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ username: 'new.gis', password: 'reset-gis-password-2026' });
      const mine = (await agent.get('/api/notifications')).body;
      expect(mine.items.map((n: any) => n.title)).toContain('You were given the gis officer role');
      expect(mine.unread).toBeGreaterThan(0);
      const someone = await as('gis.mo').post(`/api/notifications/${mine.items[0].id}/read`);
      expect(someone.status).toBe(404);
    });

    it('stops a suspended account immediately', async () => {
      const target = await userId('reg.mg');
      expect((await as('admin').post(`/api/admin/users/${target}/status`, { status: 'suspended', reason: 'Suspension test' })).status).toBe(200);
      expect((await as('reg.mg').get('/api/cases')).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ username: 'reg.mg', password: PASSWORD })).status).toBe(401);
    });

    it('shows administrators security and system events but no land-record content', async () => {
      const res = await as('admin').get('/api/audit?limit=500');
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('technical');
      const actions = res.body.events.map((e: any) => e.action as string);
      expect(actions.some((a: string) => /^(party|document|parcel|docrequest|finding)\./.test(a))).toBe(false);
      for (const e of res.body.events.filter((x: any) => x.action.startsWith('case.'))) expect(e.detail).toEqual({});
      const filtered = await as('admin').get('/api/audit?action=admin.&actor=admin');
      expect(filtered.body.events.every((e: any) => e.action.startsWith('admin.') && e.actor_username === 'admin')).toBe(true);
    });

    it('serves the read-only permission matrix', async () => {
      const res = await as('admin').get('/api/admin/permissions');
      const decide = res.body.permissions.find((p: any) => p.action === 'case.decide');
      expect(decide.roles).toEqual(['registrar']);
      expect(res.body.roles.map((r: any) => r.role)).not.toContain('surveyor');
    });
  });

  describe('administrator dashboard and operations', () => {
    it('reports dashboard figures that match the database', async () => {
      const res = await as('admin').get('/api/admin/dashboard/summary');
      expect(res.status).toBe(200);
      const { rows: [db] } = await pool.query(
        `SELECT (SELECT count(*)::int FROM lais.land_case) AS cases, (SELECT count(*)::int FROM lais.parcel WHERE status <> 'retired') AS parcels,
                (SELECT count(*)::int FROM lais.spatial_conflict WHERE review_status = 'open') AS conflicts`,
      );
      expect(res.body).toMatchObject({ applications_total: db.cases, parcels_published: db.parcels, conflicts_open: db.conflicts, counties_total: 15 });
    });

    it('builds charts from real data over the requested range', async () => {
      const res = await as('supervisor').get('/api/admin/dashboard/charts?from=2026-01-01&to=2026-01-31');
      expect(res.status).toBe(200);
      expect(res.body.applicationsOverTime).toHaveLength(31);
      expect(res.body.applicationsOverTime.every((d: any) => d.count === 0)).toBe(true); // no synthetic history is invented
      expect(res.body.parcelsByCounty).toHaveLength(15);
      expect((await as('admin').get('/api/admin/dashboard/charts?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    });

    it('keeps operational views from staff without the permission', async () => {
      for (const path of ['/api/admin/dashboard/summary', '/api/admin/health', '/api/admin/gis-jobs', '/api/admin/reports/staff.csv']) {
        expect((await as('gis.mo').get(path)).status).toBe(403);
      }
      expect((await as('supervisor').get('/api/admin/settings')).status).toBe(403);
    });

    it('derives health from real checks', async () => {
      const res = await as('admin').get('/api/admin/health');
      const byKey = Object.fromEntries(res.body.checks.map((c: any) => [c.key, c]));
      expect(byKey.database.status).toBe('healthy');
      expect(byKey.postgis.summary).toMatch(/^PostGIS \d/);
      expect(byKey.jobs.status).toBe('unknown');
      expect(byKey.audit_chain.status).toBe('healthy');
      expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\/|password/i);
    });

    it('monitors GIS import jobs with counts and spatial findings only', async () => {
      const list = await as('admin').get('/api/admin/gis-jobs?pageSize=100');
      expect(list.status).toBe(200);
      expect(list.body.total).toBeGreaterThan(0);
      const migrationJob = list.body.items.find((j: any) => j.case_type === 'migration' && j.received === 8);
      expect(migrationJob).toMatchObject({ accepted: 3, rejected: 5, published_parcels: 3, status: 'published' });
      const detail = await as('admin').get(`/api/admin/gis-jobs/${migrationJob.id}`);
      expect(detail.body.features).toHaveLength(8);
      expect(detail.body.findings.every((f: any) => !/PARTY|DOCUMENT|RIGHT|SHARE/.test(f.code))).toBe(true);
    });

    it('configures counties without inventing boundaries or legal authority', async () => {
      const counties = (await as('admin').get('/api/admin/counties')).body;
      expect(counties).toHaveLength(15);
      const bong = counties.find((c: any) => c.name === 'Bong');
      expect(bong).toMatchObject({ boundary_status: 'unconfigured', enabled: false, area_km2: null });
      expect((await as('admin').patch(`/api/admin/counties/${bong.id}`, { enabled: true, reason: 'Trying to enable' })).status).toBe(409);
      expect((await as('admin').post(`/api/admin/counties/1/verify-boundary`, { source: 'Made up', reason: 'Trying to verify synthetic' })).status).toBe(409);
      expect((await as('gis.mo').patch(`/api/admin/counties/1`, { name: 'Renamed', reason: 'Not allowed' })).status).toBe(403);
      // A disabled county accepts no new cases.
      expect((await as('admin').patch('/api/admin/counties/2', { enabled: false, reason: 'Pausing Margibi for the test' })).status).toBe(200);
      const created = await as('gis.mg').post('/api/cases', { caseType: 'first_registration', countyId: 2 });
      expect(created.status).toBe(409);
      expect((await as('admin').patch('/api/admin/counties/2', { enabled: true, reason: 'Resuming Margibi' })).status).toBe(200);
    });

    it('imports a county boundary as provisional and refuses invalid ones', async () => {
      const bong = (await as('admin').get('/api/admin/counties')).body.find((c: any) => c.name === 'Bong');
      const upload = (file: Buffer, crs = '4326') => as('admin').upload(`/api/admin/counties/${bong.id}/boundary`, file, 'boundary.geojson', { crs, source: 'Synthetic test polygon', reason: 'Boundary import test' });
      expect((await upload(fixture('self_intersecting_4326.geojson'))).status).toBe(400);
      expect((await upload(fixture('valid_parcel_utm29n.geojson'), '4326')).status).toBe(400);
      const ok = await upload(fixture('valid_parcel_4326.geojson'));
      expect(ok.status).toBe(200);
      expect(ok.body.boundaryStatus).toBe('provisional');
      const { rows: [c] } = await pool.query('SELECT boundary_status, enabled FROM lais.county WHERE id = $1', [bong.id]);
      expect(c).toEqual({ boundary_status: 'provisional', enabled: false });
    });

    it('changes only allow-listed settings, with an audit record', async () => {
      expect((await as('admin').put('/api/admin/settings/portal.banner_message', { value: 'Maintenance on Saturday', reason: 'Planned maintenance' })).status).toBe(200);
      expect((await as('admin').put('/api/admin/settings/portal.banner_message', { value: 42, reason: 'Wrong type' })).status).toBe(400);
      expect((await as('admin').put('/api/admin/settings/security.disable_audit', { value: true, reason: 'Must not exist' })).status).toBe(404);
      expect((await as('gis.mo').get('/api/auth/session')).body.banner).toBe('Maintenance on Saturday');
      const { rows } = await pool.query(`SELECT detail FROM audit.event WHERE action = 'settings.update' ORDER BY chain_seq DESC LIMIT 1`);
      expect(rows[0].detail).toMatchObject({ to: 'Maintenance on Saturday', reason: 'Planned maintenance' });
      await as('admin').put('/api/admin/settings/portal.banner_message', { value: '', reason: 'Maintenance over' });
    });

    it('manages document categories without breaking workflow rules', async () => {
      expect((await as('admin').post('/api/admin/document-categories', { code: 'lease_agreement', label: 'Lease agreement', reason: 'New category' })).status).toBe(201);
      expect((await as('admin').patch('/api/admin/document-categories/deed', { active: false, reason: 'Trying to disable' })).status).toBe(409);
      expect((await as('admin').patch('/api/admin/document-categories/lease_agreement', { active: false, reason: 'Not needed after all' })).status).toBe(200);
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: 'PROV-MO-000004' });
      const upload = await as('proc.mo').upload(`/api/cases/${created.body.id}/documents`, fixture('synthetic_document.pdf'), 'lease.pdf', { docType: 'lease_agreement', classification: 'restricted' });
      expect(upload.status).toBe(400);
    });

    it('searches only what the caller may discover', async () => {
      const gis = (await as('gis.mo').get('/api/search?q=PROV-MO')).body.results;
      expect(gis.some((r: any) => r.type === 'parcel')).toBe(true);
      expect(gis.some((r: any) => r.type === 'user')).toBe(false);
      const admin = (await as('admin').get('/api/search?q=proc')).body.results;
      expect(admin.some((r: any) => r.type === 'user')).toBe(true);
      expect(admin.some((r: any) => r.type === 'case')).toBe(false);
      expect((await as('owner.demo').get('/api/search?q=PROV')).status).toBe(403);
      expect(JSON.stringify((await as('admin').get('/api/search?q=Testperson')).body.results)).not.toMatch(/Testperson/);
    });

    it('records every backup attempt honestly', async () => {
      const res = await as('admin').post('/api/admin/backups', { reason: 'Integration test backup' });
      expect([201, 502]).toContain(res.status);
      const { rows: [run] } = await pool.query('SELECT status, error FROM lais.backup_run ORDER BY started_at DESC LIMIT 1');
      expect(run.status).toBe(res.status === 201 ? 'succeeded' : 'failed');
      expect((await as('supervisor').post('/api/admin/backups', { reason: 'Not allowed' })).status).toBe(403);
    });

    it('exports privacy-safe reports', async () => {
      const staff = await as('admin').get('/api/admin/reports/staff.csv');
      expect(staff.status).toBe(200);
      expect(staff.text).toContain('proc.mo');
      expect(staff.text).not.toMatch(/owner\.demo|@example|scrypt/);
      const apps = await as('supervisor').get('/api/admin/reports/applications.csv');
      expect(apps.text.split('\r\n')[0]).toBe('"case_no","case_type","status","county","created_at","updated_at"');
    });
  });

  describe('landowner document requests', () => {
    let deedId = '';
    let idDocId = '';
    let requestId = '';

    async function publishTransfer(upi: string, toParty: string, extraDocs = false) {
      const created = await as('proc.mo').post('/api/cases', { caseType: 'transfer', parcelUpi: upi, sourceReference: 'SYNTHETIC-TRANSFER' });
      const id = created.body.id;
      expect((await as('proc.mo').post(`/api/cases/${id}/rights`, { partyId: await partyId(toParty), rrrType: 'ownership' })).status).toBe(201);
      const deed = await as('proc.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'deed.pdf', { docType: 'deed', classification: 'restricted', referenceNo: 'DEED-DR' });
      await as('proc2.mo').post(`/api/cases/${id}/documents/${deed.body.id}/verify`, { status: 'verified', note: 'Deed checked' });
      let idDoc = '';
      if (extraDocs) {
        const doc = await as('proc.mo').upload(`/api/cases/${id}/documents`, fixture('synthetic_document.pdf'), 'id.pdf', { docType: 'id_document', classification: 'highly_sensitive' });
        await as('proc2.mo').post(`/api/cases/${id}/documents/${doc.body.id}/verify`, { status: 'verified', note: 'ID checked' });
        idDoc = doc.body.id;
      }
      expect((await as('proc.mo').post(`/api/cases/${id}/submit`)).body.status).toBe('under_review');
      await acknowledgeAll(id);
      expect((await approve(id)).status).toBe(200);
      expect((await as('reg.mo').post(`/api/cases/${id}/publish`)).status).toBe(200);
      return { deed: deed.body.id as string, idDoc };
    }

    it('sets up: PROV-MO-000010 is transferred to the landowner, with a deed and an ID document', async () => {
      ({ deed: deedId, idDoc: idDocId } = await publishTransfer('PROV-MO-000010', 'Musu', true));
    });

    it('refuses requests for parcels the landowner does not hold, without revealing whether they exist', async () => {
      const notMine = await as('owner.demo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-000002', documentTypes: ['deed'], purpose: 'Checking a neighbour' });
      const unknown = await as('owner.demo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-999999', documentTypes: ['deed'], purpose: 'Checking a neighbour' });
      expect(notMine.status).toBe(403);
      expect(unknown.status).toBe(403);
      expect(notMine.body.error).toBe(unknown.body.error);
      expect((await as('proc.mo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-000010', documentTypes: ['deed'], purpose: 'Staff should not use this' })).status).toBe(403);
    });

    it('lets the landowner request documents for their own parcel', async () => {
      const res = await as('owner.demo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-000010', documentTypes: ['deed', 'survey_plan'], purpose: 'Needed for a bank loan application' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('submitted');
      requestId = res.body.id;
      const mine = (await as('owner.demo').get('/api/me/document-requests')).body;
      expect(mine[0]).toMatchObject({ request_no: res.body.request_no, status: 'submitted', released_documents: null });
    });

    it('limits the staff queue to authorized roles', async () => {
      expect((await as('gis.mo').get('/api/document-requests')).status).toBe(403);
      expect((await as('admin').get('/api/document-requests')).status).toBe(403);
      expect((await as('auditor').get('/api/document-requests')).body.map((r: any) => r.id)).toContain(requestId);
    });

    it('offers only verified documents from published cases, and never highly sensitive ones', async () => {
      const detail = (await as('proc.mo').get(`/api/document-requests/${requestId}`)).body;
      expect(detail.allowedActions).toEqual(['prepare']);
      const deed = detail.candidates.find((c: any) => c.id === deedId);
      const idDoc = detail.candidates.find((c: any) => c.id === idDocId);
      expect(deed.releasable).toBe(true);
      expect(idDoc.releasable).toBe(false);
      const bad = await as('proc.mo').post(`/api/document-requests/${requestId}/prepare`, { documentIds: [deedId, idDocId], note: 'Trying to include the ID' });
      expect(bad.status).toBe(400);
      // The database refuses it too, whatever the API does.
      await expect(pool.query('INSERT INTO lais.document_request_item (request_id, document_id) VALUES ($1, $2)', [requestId, idDocId])).rejects.toThrow(/Highly sensitive/);
    });

    it('needs a processor to prepare and a registrar to decide', async () => {
      expect((await as('reg.mo').post(`/api/document-requests/${requestId}/prepare`, { documentIds: [deedId], note: 'Registrar preparing' })).status).toBe(403);
      expect((await as('proc.mo').post(`/api/document-requests/${requestId}/prepare`, { documentIds: [deedId], note: 'Deed from the transfer case' })).status).toBe(200);
      expect((await as('proc.mo').post(`/api/document-requests/${requestId}/decide`, { decision: 'approved', reason: 'Processor approving' })).status).toBe(403);
      expect((await as('reg.mo').post(`/api/document-requests/${requestId}/decide`, { decision: 'approved', reason: 'Requester holds the registered interest' })).status).toBe(200);
      await expect(pool.query('DELETE FROM lais.document_request_item WHERE request_id = $1', [requestId])).rejects.toThrow(/cannot be changed/);
    });

    it('lets the landowner download released documents only, and logs each download', async () => {
      const mine = (await as('owner.demo').get('/api/me/document-requests')).body.find((r: any) => r.id === requestId);
      expect(mine.status).toBe('approved');
      expect(mine.release_active).toBe(true);
      expect(mine.released_documents.map((d: any) => d.id)).toEqual([deedId]);

      const file = await as('owner.demo').get(`/api/me/document-requests/${requestId}/documents/${deedId}/file`);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect((await as('owner.demo').get(`/api/me/document-requests/${requestId}/documents/${idDocId}/file`)).status).toBe(403);
      // The landowner still cannot reach the internal document endpoint.
      expect((await as('owner.demo').get(`/api/documents/${deedId}/file`)).status).toBe(403);
      const { rows } = await pool.query(`SELECT * FROM audit.event WHERE action = 'document.release_download' AND entity_id = $1`, [deedId]);
      expect(rows).toHaveLength(1);
    });

    it('stops downloads once the landowner no longer holds the interest', async () => {
      await publishTransfer('PROV-MO-000010', 'Hawa');
      const res = await as('owner.demo').get(`/api/me/document-requests/${requestId}/documents/${deedId}/file`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/no longer hold/);
    });

    it('allows a release to be cut short but never extended', async () => {
      await expect(pool.query(`UPDATE lais.document_request SET release_expires_at = release_expires_at + interval '1 day' WHERE id = $1`, [requestId])).rejects.toThrow(/closed/);
      await pool.query(`UPDATE lais.document_request SET release_expires_at = now() - interval '1 second' WHERE id = $1`, [requestId]);
      const res = await as('owner.demo').get(`/api/me/document-requests/${requestId}/documents/${deedId}/file`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/release period/);
    });

    it('records a refusal with a reason the landowner can see', async () => {
      const created = await as('owner.demo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-000011', documentTypes: ['survey_plan'], purpose: 'Planning a fence along the boundary' });
      const id = created.body.id;
      expect((await as('proc.mo').post(`/api/document-requests/${id}/prepare`, { documentIds: [], note: 'No survey plan on file for this parcel' })).status).toBe(200);
      expect((await as('reg.mo').post(`/api/document-requests/${id}/decide`, { decision: 'approved', reason: 'Nothing to release' })).status).toBe(409);
      expect((await as('reg.mo').post(`/api/document-requests/${id}/decide`, { decision: 'refused', reason: 'No survey plan is held for this parcel; contact the county office' })).status).toBe(200);
      const mine = (await as('owner.demo').get('/api/me/document-requests')).body.find((r: any) => r.id === id);
      expect(mine).toMatchObject({ status: 'refused', decision_reason: 'No survey plan is held for this parcel; contact the county office', released_documents: null });
    });

    it('lets the landowner withdraw an undecided request', async () => {
      const created = await as('owner.demo').post('/api/me/document-requests', { parcelUpi: 'PROV-MO-000011', documentTypes: ['deed'], purpose: 'No longer needed after all' });
      expect((await as('owner.demo').post(`/api/me/document-requests/${created.body.id}/withdraw`)).status).toBe(200);
      expect((await as('proc.mo').post(`/api/document-requests/${created.body.id}/prepare`, { documentIds: [], note: 'Too late' })).status).toBe(409);
    });
  });

  // Real parallelism needs a multi-connection database; the embedded test server runs with one connection.
  describe.skipIf(process.env.DATABASE_POOL_MAX === '1')('concurrency (real PostgreSQL)', () => {
    it('publishes only one of two overlapping parcels approved at the same time', async () => {
      const a = await prepareRegistration('concurrency_parcel_4326.geojson', { owner: 'Hawa' });
      const b = await prepareRegistration('concurrency_parcel_4326.geojson', { owner: 'Joseph' });
      for (const id of [a, b]) {
        await submit(id);
        await acknowledgeAll(id); // each was warned about the other open submission
        expect((await approve(id)).status).toBe(200);
      }
      // Publish both at once. The per-county lock serialises them, so the second sees the first and is reopened.
      // A test-only pause between the conflict check and the write forces the two to overlap in time.
      const results = await Promise.all([a, b].map((id) => as('reg.mo').post(`/api/cases/${id}/publish`, { simulateDelayMs: 1500 })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM lais.parcel_version v JOIN lais.land_case c ON c.id = v.published_by_case WHERE c.id = ANY($1)`,
        [[a, b]],
      );
      expect(rows[0].n).toBe(1);
      const reopened = results.findIndex((r) => r.status === 409);
      expect((await caseDetail([a, b][reopened])).validation.findings.map((f: any) => f.code)).toContain('DUPLICATE_GEOMETRY_SUSPECTED');
    });

    it('keeps the audit hash chain intact under parallel writes', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM audit.event')).rows[0].n;
      // 40 parallel requests that each write an audit event (internal parcel views are logged).
      await Promise.all(Array.from({ length: 40 }, (_, i) => as(i % 2 ? 'reg.mo' : 'supervisor').get('/api/parcels/PROV-MO-000002')));
      const after = (await pool.query('SELECT count(*)::int AS n FROM audit.event')).rows[0].n;
      expect(after - before).toBeGreaterThanOrEqual(40);
      const verify = await as('auditor').get('/api/audit/verify');
      expect(verify.body).toMatchObject({ intact: true });
    });
  });
  describe('supervision', () => {
    const setReviewMode = async (mode: 'optional' | 'required') =>
      expect((await as('admin').put('/api/admin/settings/workflow.supervisor_review', { value: mode, reason: 'Integration test configuration' })).status).toBe(200);
    const userId = async (username: string) => (await pool.query('SELECT id FROM lais.app_user WHERE username = $1', [username])).rows[0].id as string;
    let mgCase: string;

    beforeAll(async () => {
      // The administration tests suspend reg.mg; bring the account back for the cross-county checks here.
      const regMg = await userId('reg.mg');
      const status = (await pool.query('SELECT status FROM lais.app_user WHERE id = $1', [regMg])).rows[0].status;
      if (status !== 'active') expect((await as('admin').post(`/api/admin/users/${regMg}/status`, { status: 'active', reason: 'Back for supervision tests' })).status).toBe(200);
      users['reg.mg'] = await new Client('reg.mg').login();
      const created = await as('gis.mg').post('/api/cases', { caseType: 'first_registration', countyId: 2, landCategory: 'private', sourceReference: 'SYNTHETIC-MG' });
      expect(created.status).toBe(201);
      mgCase = created.body.id;
    });

    describe('authorization', () => {
      it('keeps a county supervisor inside their county, whatever county the client asks for', async () => {
        expect((await as('sup.mo').get('/api/supervision/applications?countyId=2')).status).toBe(403);
        expect((await as('sup.mo').get(`/api/supervision/cases/${mgCase}`)).status).toBe(403);
        expect((await as('sup.mo').get('/api/supervision/dashboard/summary?countyId=2')).status).toBe(403);
        const scope = await as('sup.mo').get('/api/supervision/scope');
        expect(scope.body.national).toBe(false);
        expect(scope.body.counties.map((c: any) => c.code)).toEqual(['MO']);
        // National views are closed to a county supervisor; the national supervisor keeps them.
        expect((await as('sup.mo').get('/api/admin/dashboard/summary')).status).toBe(403);
        expect((await as('sup.mo').get('/api/admin/users')).status).toBe(403);
        expect((await as('supervisor').get('/api/admin/dashboard/summary')).status).toBe(200);
        const session = await as('sup.mo').get('/api/auth/session');
        expect(session.body.capabilities).toContain('supervision.view');
        expect(session.body.capabilities).not.toContain('dashboard.view');
        // Their audit view is limited to their county.
        const audit = await as('sup.mo').get('/api/audit?limit=200');
        expect(audit.body.scope).toBe('county');
        expect(audit.body.events.every((e: any) => e.county_id === 1)).toBe(true);
        const denied = await pool.query(`SELECT 1 FROM audit.event WHERE action = 'authz.denied' AND actor_username = 'sup.mo' AND county_id = 2`);
        expect(denied.rowCount).toBeGreaterThan(0);
      });

      it('gives supervisors no legal authority: no decision, publication, role assignment or geometry import', async () => {
        const id = await prepareRegistration('valid_parcel_4326.geojson');
        expect((await submit(id)).status).toBe('under_review');
        for (const who of ['sup.mo', 'supervisor']) {
          expect((await as(who).post(`/api/cases/${id}/decision`, { decision: 'approved', reason: 'Trying to approve', authorityBasis: 'none' })).status).toBe(403);
          expect((await as(who).post(`/api/cases/${id}/publish`)).status).toBe(403);
          expect((await as(who).upload(`/api/cases/${id}/geometry`, fixture('valid_parcel_4326.geojson'), 'x.geojson', { crs: '4326' })).status).toBe(403);
        }
        const supId = await userId('sup.mo');
        expect((await as('sup.mo').post(`/api/admin/users/${supId}/roles`, { role: 'system_admin', reason: 'Self elevation attempt' })).status).toBe(403);
        expect((await as('supervisor').post(`/api/admin/users/${supId}/roles`, { role: 'registrar', countyId: 1, reason: 'Elevation attempt' })).status).toBe(403);
      });

      it('cannot change or delete review, task, escalation or audit history, even in the database', async () => {
        await pool.query(`INSERT INTO lais.supervisory_review (case_id, county_id, decision, notes, case_status, reviewer_id)
                          SELECT id, county_id, 'info_requested', 'Fixture row for immutability', status, created_by FROM lais.land_case LIMIT 1`);
        for (const sql of ['DELETE FROM lais.supervisory_review', 'UPDATE lais.supervisory_review SET notes = notes', 'DELETE FROM audit.event']) {
          await expect(pool.query(sql), sql).rejects.toThrow();
        }
      });
    });

    describe('GIS quality review', () => {
      it('accepts a valid submission without approving or publishing anything', async () => {
        const caseId = await prepareRegistration('valid_parcel_4326.geojson');
        expect((await submit(caseId)).status).toBe('under_review');
        const queue = await as('sup.mo').get('/api/supervision/gis-reviews?status=awaiting_review');
        expect(queue.body.items.some((i: any) => i.case_id === caseId)).toBe(true);
        const detail = await as('sup.mo').get(`/api/supervision/gis-reviews/${caseId}`);
        expect(detail.status).toBe(200);
        expect(detail.body.submission.sourceCrs).toBe('EPSG:4326');
        expect(detail.body.records[0].geometry.type).toMatch(/Polygon$/);

        const accepted = await as('sup.mo').post(`/api/supervision/cases/${caseId}/accept`, { notes: 'Geometry and attributes checked' });
        expect(accepted.status).toBe(201);
        const cs = await caseDetail(caseId);
        expect(cs.case.status).toBe('under_review');
        expect(cs.qualityReview.acceptedForCurrentRun).toBe(true);
        expect((await as('sup.mo').post(`/api/supervision/cases/${caseId}/accept`, { notes: 'Accept twice' })).status).toBe(409);
        const audit = await pool.query(`SELECT 1 FROM audit.event WHERE action = 'supervision.accept' AND case_id = $1`, [caseId]);
        expect(audit.rowCount).toBe(1);
      });

      it('makes acceptance a precondition of approval only when the administrator requires it', async () => {
        await setReviewMode('required');
        try {
          const other = await prepareRegistration('valid_parcel_4326.geojson');
          await submit(other);
          await acknowledgeAll(other);
          const refused = await approve(other);
          expect(refused.status).toBe(409);
          expect(refused.body.error).toMatch(/supervisor must accept/);
          expect((await as('sup.mo').post(`/api/supervision/cases/${other}/accept`, { notes: 'Quality checked' })).status).toBe(201);
          expect((await approve(other)).status).toBe(200);
        } finally {
          await setReviewMode('optional');
        }
      });

      it('refuses to accept a submission that failed validation', async () => {
        const bad = await prepareRegistration('self_intersecting_4326.geojson');
        expect((await submit(bad)).status).toBe('returned');
        expect((await as('sup.mo').post(`/api/supervision/cases/${bad}/accept`, { notes: 'Trying to accept' })).status).toBe(403);
      });

      it('returns work to the responsible GIS officer and keeps the earlier submission and review', async () => {
        const id = await prepareRegistration('valid_parcel_4326.geojson');
        await submit(id);
        const noCategory = await as('sup.mo').post(`/api/supervision/cases/${id}/return`, { reason: 'Boundary needs checking', issueCategories: [] });
        expect(noCategory.status).toBe(400);
        const ret = await as('sup.mo').post(`/api/supervision/cases/${id}/return`, {
          reason: 'The boundary does not follow the survey plan', issueCategories: ['geometry_invalid'], affectedFeatures: [0], instructions: 'Re-digitise from the plan',
        });
        expect(ret.status).toBe(201);
        expect(ret.body.task.assignee).toBe('gis.mo');
        expect((await caseDetail(id)).case.status).toBe('returned');
        const mine = await as('gis.mo').get('/api/tasks?view=mine&status=open&pageSize=100');
        expect(mine.body.items.some((t: any) => t.case_id === id && t.task_type === 'gis_validation_correction')).toBe(true);
        const note = await pool.query(`SELECT 1 FROM lais.notification n JOIN lais.app_user u ON u.id = n.user_id WHERE u.username = 'gis.mo' AND n.title LIKE '%returned for correction%'`);
        expect(note.rowCount).toBeGreaterThan(0);

        // Correction: a new import and resubmission. The first submission and the return stay in the history.
        expect((await as('gis.mo').upload(`/api/cases/${id}/geometry`, fixture('valid_parcel_4326.geojson'), 'fixed.geojson', { crs: '4326' })).status).toBe(201);
        expect((await submit(id)).status).toBe('under_review');
        const detail = await as('sup.mo').get(`/api/supervision/gis-reviews/${id}`);
        expect(detail.body.history.map((b: any) => b.status)).toEqual(['superseded', 'active']);
        const sup = await as('sup.mo').get(`/api/supervision/cases/${id}`);
        expect(sup.body.reviews[0].decision).toBe('returned');
        expect(sup.body.qualityAccepted).toBe(false);
        expect(sup.body.acceptBlockedBy).toEqual([]);
      });

      it('tracks an information request as a task whose completion is the response', async () => {
        const id = await prepareRegistration('valid_parcel_4326.geojson');
        await submit(id);
        const ask = await as('sup.mo').post(`/api/supervision/cases/${id}/request-info`, { message: 'Which survey plan version was digitised?' });
        expect(ask.status).toBe(201);
        const task = (await as('gis.mo').get(`/api/tasks?view=mine&caseId=${id}`)).body.items[0];
        expect((await as('gis.mo').post(`/api/tasks/${task.id}/status`, { to: 'completed', note: 'Plan version 2 of 2026' })).status).toBe(200);
        const sup = await as('sup.mo').get(`/api/supervision/cases/${id}`);
        expect(sup.body.reviews[0]).toMatchObject({ decision: 'info_requested', task_status: 'completed', response: 'Plan version 2 of 2026' });
      });
    });

    describe('spatial conflicts', () => {
      it('keeps a conflict visible until a registrar acknowledges it, and offers no way to dismiss it', async () => {
        const id = await prepareRegistration('overlap_published_4326.geojson');
        await submit(id);
        const list = await as('sup.mo').get('/api/supervision/conflicts?pageSize=100');
        const mine = list.body.items.filter((c: any) => c.case_id === id && c.code === 'OVERLAP_PUBLISHED_PARCEL');
        expect(mine.length).toBeGreaterThan(0);
        expect(mine[0].review_status).toBe('new');
        expect(mine[0].category).toBe('potential_overlap');

        const detail = await as('sup.mo').get(`/api/supervision/conflicts/${mine[0].id}`);
        expect(detail.status).toBe(200);
        expect(Number(detail.body.evidence.intersection_m2)).toBeGreaterThan(1);

        expect((await as('sup.mo').post(`/api/supervision/conflicts/${mine[0].id}/actions`, { action: 'resolved', note: 'Looks fine to me' })).status).toBe(400);
        const gisId = await userId('gis.mo');
        const inv = await as('sup.mo').post(`/api/supervision/conflicts/${mine[0].id}/actions`, { action: 'investigation_assigned', note: 'Compare with the 2019 survey', assigneeId: gisId });
        expect(inv.status).toBe(201);
        expect((await as('sup.mo').get(`/api/supervision/conflicts/${mine[0].id}`)).body.conflict.review_status).toBe('investigating');

        // Only the registrar's acknowledgement resolves it; the evidence and review history stay.
        await acknowledgeAll(id);
        const resolved = await as('sup.mo').get('/api/supervision/conflicts?status=resolved&pageSize=100');
        expect(resolved.body.items.some((c: any) => c.case_id === id && c.code === 'OVERLAP_PUBLISHED_PARCEL')).toBe(true);
        const events = (await as('sup.mo').get(`/api/supervision/conflicts/${mine[0].id}`)).body.events;
        expect(events.map((e: any) => e.action)).toContain('investigation_assigned');
      });
    });

    describe('tasks', () => {
      let taskId: string;

      it('assigns county tasks only to active, eligible staff of that county', async () => {
        const base = { taskType: 'document_review', title: 'Check the deed scan', countyId: 1 };
        expect((await as('sup.mo').post('/api/tasks', { ...base, assigneeId: await userId('proc.mg') })).status).toBe(409);
        expect((await as('sup.mo').post('/api/tasks', { ...base, assigneeId: await userId('gis.mo') })).status).toBe(409);
        expect((await as('sup.mo').post('/api/tasks', { ...base, assigneeId: await userId('reg.mo') })).status).toBe(409);
        expect((await as('sup.mo').post('/api/tasks', { ...base, countyId: 2, assigneeId: await userId('proc.mg') })).status).toBe(403);
        expect((await as('proc.mo').post('/api/tasks', { ...base, assigneeId: await userId('proc2.mo') })).status).toBe(403);
        const ok = await as('sup.mo').post('/api/tasks', { ...base, assigneeId: await userId('proc.mo'), priority: 'high' });
        expect(ok.status).toBe(201);
        taskId = ok.body.id;
      });

      it('records the reason for every reassignment', async () => {
        expect((await as('sup.mo').post(`/api/tasks/${taskId}/assign`, { assigneeId: await userId('proc2.mo') })).status).toBe(400);
        expect((await as('sup.mo').post(`/api/tasks/${taskId}/assign`, { assigneeId: await userId('proc2.mo'), reason: 'proc.mo is on leave' })).status).toBe(200);
        const t = await as('sup.mo').get(`/api/tasks/${taskId}`);
        expect(t.body.events.find((e: any) => e.action === 'reassigned')).toMatchObject({ note: 'proc.mo is on leave' });
        expect((await as('proc.mo').post(`/api/tasks/${taskId}/status`, { to: 'in_progress' })).status).toBe(403);
      });

      it('enforces task transitions and never erases a completed task', async () => {
        expect((await as('proc2.mo').post(`/api/tasks/${taskId}/status`, { to: 'returned' })).status).toBe(409);
        expect((await as('proc2.mo').post(`/api/tasks/${taskId}/status`, { to: 'in_progress' })).status).toBe(200);
        expect((await as('proc2.mo').post(`/api/tasks/${taskId}/status`, { to: 'completed' })).status).toBe(400);
        expect((await as('proc2.mo').post(`/api/tasks/${taskId}/status`, { to: 'completed', note: 'Deed scan matches the original' })).status).toBe(200);
        expect((await as('sup.mo').post(`/api/tasks/${taskId}/status`, { to: 'cancelled', note: 'Trying to hide it' })).status).toBe(409);
        expect((await as('sup.mo').patch(`/api/tasks/${taskId}`, { priority: 'low', reason: 'Changing a closed task' })).status).toBe(409);
        await expect(pool.query('DELETE FROM lais.task WHERE id = $1', [taskId])).rejects.toThrow(/cannot be deleted/);
        await expect(pool.query(`UPDATE lais.task SET status = 'blocked' WHERE id = $1`, [taskId])).rejects.toThrow(/Illegal task status transition/);
        await expect(pool.query('DELETE FROM lais.task_event WHERE task_id = $1', [taskId])).rejects.toThrow(/append-only/);
        // A supervisor may return completed work for more effort; the completion stays in the history.
        expect((await as('sup.mo').post(`/api/tasks/${taskId}/status`, { to: 'returned', note: 'Also check the stamp' })).status).toBe(200);
        const t = await as('sup.mo').get(`/api/tasks/${taskId}`);
        expect(t.body.events.map((e: any) => e.action)).toEqual(['created', 'reassigned', 'status_changed', 'completed', 'returned']);
      });
    });

    describe('dashboard and reports', () => {
      it('reports figures that match the database, in scope only', async () => {
        const summary = await as('sup.mo').get('/api/supervision/dashboard/summary');
        expect(summary.status).toBe(200);
        const { rows: [db] } = await pool.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'returned')::int AS returned, count(*) FILTER (WHERE status = 'draft')::int AS drafts
             FROM lais.land_case WHERE county_id = 1`);
        expect(summary.body.applications_total).toBe(db.total);
        expect(summary.body.returned_for_correction).toBe(db.returned);
        expect(summary.body.awaiting_processing).toBe(db.drafts);
        const { rows: [runs] } = await pool.query(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE error_count = 0)::int AS passed FROM staging.validation_run r JOIN lais.land_case c ON c.id = r.case_id
            WHERE c.county_id = 1 AND r.purpose = 'submission' AND r.run_at >= current_date - 29`);
        expect(summary.body.submissions_validated).toBe(runs.n);
        expect(summary.body.quality_pass_rate).toBe(Math.round((1000 * runs.passed) / runs.n) / 10);

        const national = await as('supervisor').get('/api/supervision/dashboard/summary');
        expect(national.body.applications_total).toBeGreaterThan(summary.body.applications_total);

        const charts = await as('sup.mo').get('/api/supervision/dashboard/charts');
        expect(charts.body.stages.reduce((n: number, s: any) => n + s.count, 0)).toBe(db.total);
      });

      it('filters and pages the work queue without leaking other counties', async () => {
        const all = await as('sup.mo').get('/api/supervision/applications?pageSize=100');
        expect(all.body.items.every((i: any) => i.county_code === 'MO')).toBe(true);
        expect(all.body.items.some((i: any) => i.id === mgCase)).toBe(false);
        const page2 = await as('sup.mo').get('/api/supervision/applications?pageSize=10&page=2&sort=case_no&dir=asc');
        expect(page2.body.items.length).toBeLessThanOrEqual(10);
        expect(page2.body.total).toBe(all.body.total);
        const returned = await as('sup.mo').get('/api/supervision/applications?stage=returned');
        expect(returned.body.items.length).toBeGreaterThan(0);
        expect(returned.body.items.every((i: any) => i.stage === 'returned')).toBe(true);
        expect((await as('sup.mo').get('/api/supervision/applications?pageSize=7')).status).toBe(400);
      });

      it('scopes and audits reports', async () => {
        const before = await pool.query(`SELECT count(*)::int AS n FROM audit.event WHERE action = 'report.supervision' AND actor_username = 'sup.mo'`);
        const r = await as('sup.mo').get('/api/supervision/reports/application_status?from=2026-01-01');
        expect(r.status).toBe(200);
        expect(r.body.scope).toBe('MO');
        expect(r.body.rows.every((x: any) => x.county === 'MO')).toBe(true);
        expect(r.body.columns.find((c: any) => c.key === 'days_in_stage').kind).toBe('derived');
        expect((await as('sup.mo').get('/api/supervision/reports/application_status?countyId=2')).status).toBe(403);
        const csv = await as('sup.mo').get('/api/supervision/reports/staff_workload.csv');
        expect(csv.status).toBe(200);
        expect(csv.text).toMatch(/^# Staff workload/);
        expect(csv.text).toMatch(/synthetic demonstration data/);
        expect(csv.text).not.toMatch(/proc\.mg|gis\.mg/);
        const after = await pool.query(`SELECT count(*)::int AS n FROM audit.event WHERE action = 'report.supervision' AND actor_username = 'sup.mo'`);
        expect(after.rows[0].n - before.rows[0].n).toBe(2);
        expect((await as('gis.mo').get('/api/supervision/reports/application_status')).status).toBe(403);
      });
    });

    describe('escalations', () => {
      it('routes, preserves history and closes only under the closure policy', async () => {
        const id = await prepareRegistration('valid_parcel_4326.geojson');
        const created = await as('sup.mo').post('/api/escalations', {
          category: 'spatial_conflict', severity: 'high', title: 'Possible double allocation', countyId: 1, caseId: id,
          description: 'The parcel appears in two unrelated survey records.',
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ responsibleRole: 'registrar', responsibleLevel: 'county' });
        const eid = created.body.id;
        expect((await as('sup.mo').post('/api/escalations', { category: 'spatial_conflict', severity: 'high', title: 'Wrong county', countyId: 2, description: 'Not my county at all' })).status).toBe(403);

        expect((await as('reg.mo').post(`/api/escalations/${eid}/close`, { reason: 'Nothing to see here really' })).status).toBe(409);
        expect((await as('sup.mo').post(`/api/escalations/${eid}/acknowledge`, {})).status).toBe(403);
        expect((await as('reg.mg').get(`/api/escalations/${eid}`)).status).toBe(403);
        expect((await as('reg.mo').post(`/api/escalations/${eid}/acknowledge`, { note: 'Looking into it' })).status).toBe(200);
        const inv = await as('reg.mo').post(`/api/escalations/${eid}/investigate`, { note: 'Check the 2019 survey register', assigneeId: await userId('gis.mo') });
        expect(inv.status).toBe(200);
        const closeEarly = await as('reg.mo').post(`/api/escalations/${eid}/close`, { reason: 'Investigated and explained' });
        expect(closeEarly.status).toBe(409);
        expect(closeEarly.body.error).toMatch(/linked task/);
        expect((await as('gis.mo').post(`/api/tasks/${inv.body.task.id}/status`, { to: 'completed', note: 'Same parcel, duplicate survey entry' })).status).toBe(200);
        expect((await as('reg.mo').post(`/api/escalations/${eid}/close`, { reason: 'short' })).status).toBe(400);
        expect((await as('reg.mo').post(`/api/escalations/${eid}/close`, { reason: 'Duplicate survey entry; no double allocation' })).status).toBe(200);
        expect((await as('reg.mo').post(`/api/escalations/${eid}/comments`, { note: 'After closing' })).status).toBe(409);

        const detail = await as('sup.mo').get(`/api/escalations/${eid}`);
        expect(detail.body.events.map((e: any) => e.action)).toEqual(['opened', 'acknowledged', 'investigation_requested', 'closed']);
        expect(detail.body.escalation.evidence[0]).toMatchObject({ type: 'case' });
        await expect(pool.query(`UPDATE lais.escalation SET description = 'rewritten' WHERE id = $1`, [eid])).rejects.toThrow();
        await expect(pool.query('DELETE FROM lais.escalation_event WHERE escalation_id = $1', [eid])).rejects.toThrow(/append-only/);
      });

      it('lets the responsible role escalate further, and the new owner must acknowledge it', async () => {
        const created = await as('sup.mo').post('/api/escalations', {
          category: 'processing_delay', severity: 'medium', title: 'Backlog in Montserrado', countyId: 1, description: 'Submissions are waiting more than two weeks.',
        });
        const eid = created.body.id;
        expect(created.body.responsibleRole).toBe('supervisor');
        expect((await as('sup.mo').post(`/api/escalations/${eid}/escalate`, { target: { role: 'supervisor', level: 'national' }, reason: 'Needs national resourcing' })).status).toBe(200);
        expect((await as('sup.mo').post(`/api/escalations/${eid}/acknowledge`, {})).status).toBe(403);
        expect((await as('supervisor').post(`/api/escalations/${eid}/acknowledge`, {})).status).toBe(200);
      });
    });
  });

  describe('API description', () => {
    it('serves an OpenAPI document generated from the mounted routers, with a summary for every route', async () => {
      const { API_MOUNTS } = await import('../../src/app.js');
      const { listRoutes, SUMMARIES } = await import('../../src/openapi.js');
      const routes = listRoutes(API_MOUNTS).map((r) => r.key);
      expect(routes.length).toBeGreaterThan(80);
      expect(routes.filter((k) => !SUMMARIES[k]), 'routes without a summary').toEqual([]);
      expect(Object.keys(SUMMARIES).filter((k) => !routes.includes(k)), 'summaries for routes that do not exist').toEqual([]);

      const res = await request(app).get('/api/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.paths['/admin/users'].post.security).toEqual([{ session: [], csrf: [] }]);
      expect(res.body.paths['/admin/users'].get.security).toEqual([{ session: [] }]);
      expect(res.body.paths['/public/parcels'].get.security).toEqual([]);
      expect(res.body.paths['/auth/login'].post.security).toEqual([]);
      // Request bodies and query parameters come from the handlers' own Zod schemas.
      const { documentedBodies, documentedQueries, MULTIPART, NO_BODY } = await import('../../src/openapi.js');
      const writes = listRoutes(API_MOUNTS).filter((r) => r.method !== 'get').map((r) => r.key);
      const bodies = documentedBodies();
      expect(writes.filter((k) => !bodies.includes(k) && !NO_BODY.has(k) && !MULTIPART.has(k)), 'write routes with no documented body').toEqual([]);
      for (const k of [...bodies, ...documentedQueries(), ...NO_BODY]) expect(routes, `documented route ${k}`).toContain(k);

      const createUser = res.body.paths['/admin/users'].post.requestBody.content['application/json'].schema;
      expect(Object.keys(createUser.properties)).toEqual(expect.arrayContaining(['displayName', 'username', 'roles', 'reason']));
      expect(createUser.required).toEqual(expect.arrayContaining(['username', 'roles', 'reason']));
      expect(JSON.stringify(createUser.properties.roles)).not.toMatch(/surveyor/);
      const listUsers = res.body.paths['/admin/users'].get.parameters.map((p: any) => p.name);
      expect(listUsers).toEqual(expect.arrayContaining(['q', 'role', 'status', 'sort', 'page', 'pageSize']));
      const upload = res.body.paths['/cases/{id}/documents'].post.requestBody.content['multipart/form-data'].schema;
      expect(upload.required).toEqual(expect.arrayContaining(['docType', 'classification', 'file']));
      expect(upload.properties.classification.enum).toEqual(['public', 'restricted', 'highly_sensitive']);
      expect(res.body.paths['/cases/{id}/submit'].post.requestBody).toBeUndefined();

      // A well-formed OpenAPI 3.1 document, checked against the official schema.
      const { Validator } = await import('@seriousme/openapi-schema-validator');
      const validation = await new Validator().validate(res.body);
      expect(validation.errors ?? [], 'OpenAPI schema errors').toEqual([]);
      expect(validation.valid).toBe(true);
      // Lists endpoints only: no data and no secrets.
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash|PROV-MO|example\.invalid/);
    });
  });
});
