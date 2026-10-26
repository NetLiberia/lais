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
    for (const u of ['admin', 'gis.mo', 'proc.mo', 'proc2.mo', 'reg.mo', 'reg.mg', 'supervisor', 'auditor', 'owner.demo']) {
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
    it('lets admins manage accounts but not themselves, and not combine admin with registrar', async () => {
      const list = await as('admin').get('/api/admin/users');
      const me = list.body.find((u: any) => u.username === 'admin');
      expect((await as('admin').post(`/api/admin/users/${me.id}/roles`, { role: 'registrar', countyId: 1, reason: 'Self escalation attempt' })).status).toBe(403);

      const created = await as('admin').post('/api/admin/users', { username: 'temp.user', displayName: 'Temp', temporaryPassword: 'temporary-password-1' });
      expect(created.status).toBe(201);
      expect((await as('admin').post(`/api/admin/users/${created.body.id}/roles`, { role: 'system_admin', reason: 'Needed for test' })).status).toBe(201);
      expect((await as('admin').post(`/api/admin/users/${created.body.id}/roles`, { role: 'registrar', countyId: 1, reason: 'Combination test' })).status).toBe(409);
    });

    it('stops a suspended account immediately', async () => {
      const list = await as('admin').get('/api/admin/users');
      const target = list.body.find((u: any) => u.username === 'reg.mg');
      expect((await as('admin').post(`/api/admin/users/${target.id}/status`, { status: 'suspended', reason: 'Suspension test' })).status).toBe(200);
      expect((await as('reg.mg').get('/api/cases')).status).toBe(401);
    });

    it('shows administrators only technical audit events', async () => {
      const res = await as('admin').get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('technical');
      expect(res.body.events.every((e: any) => /^(auth|admin)\./.test(e.action))).toBe(true);
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
});
