import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * GIS officer workspace, import jobs and ArcMap synchronization, against a real PostgreSQL + PostGIS
 * database (TEST_DATABASE_URL, disposable: every run drops and recreates its schemas). The shapefiles and
 * the ArcMap package in fixtures/gis were produced by ArcPy 10.7 (integrations/arcmap/tests/make_samples.py).
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const PASSWORD = 'integration-test-password';
const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name.startsWith('synthetic_') && !name.endsWith('.pdf') ? `gis/${name}` : name));

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
  delete(url: string) { return this.agent.delete(url).set('X-CSRF-Token', this.csrf); }
  upload(url: string, file: Buffer | Uint8Array, filename: string, fields: Record<string, string> = {}) {
    let r = this.agent.post(url).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', Buffer.from(file), filename);
  }
}

const users: Record<string, Client> = {};
const as = (u: string) => users[u];
const userId = async (username: string) => (await pool.query('SELECT id FROM lais.app_user WHERE username = $1', [username])).rows[0].id as string;

async function newCase(body: Record<string, unknown>, who = 'gis.mo') {
  const res = await as(who).post('/api/cases', body);
  expect(res.status).toBe(201);
  return { id: res.body.id as string, caseNo: '' };
}
const caseNo = async (id: string) => (await pool.query('SELECT case_no FROM lais.land_case WHERE id = $1', [id])).rows[0].case_no as string;

async function inspect(file: string, who = 'gis.mo', fields: Record<string, string> = {}) {
  const res = await as(who).upload('/api/gis/uploads', fixture(file), file, fields);
  return res;
}

/** A single-parcel GeoJSON FeatureCollection near the synthetic samples (inside Montserrado). */
function onePolygon(dx = 0, props: Record<string, unknown> = {}) {
  const x = -10.7100 + dx;
  return Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { source_id: `GJ-${dx}`, ...props },
    geometry: { type: 'Polygon', coordinates: [[[x, 6.41], [x + 0.0008, 6.41], [x + 0.0008, 6.4108], [x, 6.4108], [x, 6.41]]] } }] }));
}

async function importAndWait(caseId: string, uploadKey: string, extra: Record<string, unknown> = {}, who = 'gis.mo') {
  const res = await as(who).post('/api/gis/imports', { caseId, uploadKey, confirm: true, wait: true, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body as { jobId: string; jobNo: string; duplicate: boolean; job: Record<string, any> };
}

/** An ArcMap package for a case, built from the ArcPy-produced sample shapefile and a manifest. */
function packageFor(caseNumber: string, manifest: Record<string, unknown> = {}, shp = 'synthetic_parcels_4326_shp.zip') {
  const files = unzipSync(fixture(shp));
  const m = {
    format: 'lais-arcmap-package', adapter_version: '1.0.0', export_id: `EXP-${caseNumber}-test`, case_no: caseNumber, county_code: 'MO', srid: 4326,
    feature_count: 3, field_map: { source_id: 'PARCEL_NO', land_category: 'CATEGORY', land_use: 'LANDUSE', surveyed_area_m2: 'SURVEYED', legacy_ref: 'PARCEL_NO' },
    ...manifest,
  };
  return Buffer.from(zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(m)) }));
}

describe.skipIf(!TEST_DB)('GIS workspace and ArcMap integration', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.NODE_ENV = 'test';
    process.env.MFA_ENCRYPTION_KEY ||= 'a'.repeat(64);
    process.env.DOCUMENT_STORAGE_DIR = path.join(tmpdir(), `lais-test-docs-${process.pid}`);
    process.env.GIS_UPLOAD_DIR = path.join(tmpdir(), `lais-test-gis-${process.pid}`);
    const { resetDatabase } = await import('../../src/reset.js');
    await resetDatabase(PASSWORD, () => undefined);
    app = (await import('../../src/app.js')).createApp();
    pool = (await import('../../src/db.js')).pool;
    for (const u of ['admin', 'gis.mo', 'gis.mg', 'proc.mo', 'proc2.mo', 'reg.mo', 'sup.mo', 'auditor']) users[u] = await new Client(u).login();
  });

  afterAll(async () => { await pool?.end(); });

  describe('file inspection (untrusted input)', () => {
    it('reads an ArcPy shapefile with its .prj and suggests no CRS of its own', async () => {
      const res = await inspect('synthetic_parcels_4326_shp.zip');
      expect(res.status).toBe(201);
      expect(res.body.format).toBe('shapefile');
      const layer = res.body.layers[0];
      expect(layer.featureCount).toBe(3);
      expect(layer.crs).toMatchObject({ epsg: 4326, source: 'prj' });
      expect(layer.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(['PARCEL_NO', 'CATEGORY', 'LANDUSE', 'SURVEYED']));
      expect(res.body.uploadKey).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reports a shapefile without .prj as having an unknown CRS', async () => {
      const res = await inspect('synthetic_parcels_noprj_shp.zip');
      expect(res.status).toBe(201);
      expect(res.body.layers[0].crs.epsg).toBeNull();
      expect(res.body.warnings.join(' ')).toMatch(/no \.prj/);
    });

    it('detects UTM 29N and finds the WKT column of a CSV', async () => {
      expect((await inspect('synthetic_parcels_utm29n_shp.zip')).body.layers[0].crs.epsg).toBe(32629);
      const csv = await inspect('synthetic_parcels_wkt_4326.csv');
      expect(csv.status).toBe(201);
      expect(csv.body.format).toBe('csv_wkt');
      expect(csv.body.layers[0].wktColumn).toBe('wkt');
    });

    it('explains unsupported formats instead of guessing', async () => {
      const gdb = await as('gis.mo').upload('/api/gis/uploads', zipSync({ 'parcels.gdb/a00000001.gdbtable': strToU8('x') }), 'parcels.zip');
      expect(gdb.status).toBe(400);
      expect(gdb.body.error).toMatch(/geodatabase/i);
    });

    it('rejects archives with path traversal or executable content, and never runs anything', async () => {
      const traversal = await as('gis.mo').upload('/api/gis/uploads', zipSync({ '../../evil.shp': strToU8('x') }), 'a.zip');
      expect(traversal.status).toBe(400);
      const exe = await as('gis.mo').upload('/api/gis/uploads', zipSync({ 'run.exe': strToU8('MZ'), 'a.shp': strToU8('x') }), 'b.zip');
      expect(exe.status).toBe(400);
      const script = await as('gis.mo').upload('/api/gis/uploads', zipSync({ 'tool.py': strToU8('import os'), 'a.shp': strToU8('x') }), 'c.zip');
      expect(script.status).toBe(400);
    });

    it('lets only GIS officers upload', async () => {
      expect((await as('proc.mo').upload('/api/gis/uploads', onePolygon(), 'p.geojson')).status).toBe(403);
      expect((await as('sup.mo').upload('/api/gis/uploads', onePolygon(), 'p.geojson')).status).toBe(403);
    });
  });

  describe('GeoPackage', () => {
    let caseId: string;
    beforeAll(async () => { caseId = (await newCase({ caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-GPKG' })).id; });

    it('reads an ArcGIS-written GeoPackage: layers, fields and the CRS from gpkg_spatial_ref_sys', async () => {
      const res = await inspect('synthetic_parcels_4326.gpkg');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.format).toBe('geopackage');
      expect(res.body.layers).toHaveLength(1);
      const layer = res.body.layers[0];
      expect(layer).toMatchObject({ name: 'parcels_4326', featureCount: 3, geometryTypes: ['MULTIPOLYGON'], crs: { epsg: 4326, source: 'gpkg' } });
      expect(layer.fields.map((f: any) => f.name)).toEqual(['PARCEL_NO', 'CATEGORY', 'LANDUSE', 'SURVEYED']);
      expect(layer.sample[0]).toMatchObject({ PARCEL_NO: 'SYN-GIS-001', SURVEYED: 10000 });
    });

    it('imports a UTM 29N GeoPackage and keeps the input coordinates as received', async () => {
      const key = (await inspect('synthetic_parcels_utm29n.gpkg')).body.uploadKey;
      const job = await importAndWait(caseId, key, { fieldMapping: { legacy_ref: 'PARCEL_NO', land_category: 'CATEGORY' } });
      expect(job.job).toMatchObject({ status: 'completed', source_format: 'geopackage', source_crs_detected: 32629, records_accepted: 3 });
      const { rows } = await pool.query('SELECT ST_SRID(geom_input) AS s, properties FROM staging.feature WHERE batch_id = $1 ORDER BY feature_index', [job.job.batch_id]);
      expect(rows[0].s).toBe(32629);
      expect(rows[0].properties).toMatchObject({ legacy_ref: 'SYN-GIS-001', land_category: 'private' });
      // The stored WGS 84 copy round-trips to the input within a centimetre: nothing was moved on the way in.
      const { rows: [d] } = await pool.query(
        'SELECT max(ST_HausdorffDistance(ST_Transform(f.geom, 32629), f.geom_input)) AS d FROM staging.feature f WHERE f.batch_id = $1', [job.job.batch_id]);
      expect(Number(d.d)).toBeLessThan(0.01);
    });

    it('refuses an unsupported CRS, and needs a declared CRS with a reason when it is undefined', async () => {
      const merc = await inspect('synthetic_parcels_webmercator.gpkg');
      expect(merc.body.layers[0].crs.epsg).toBe(3857);
      expect((await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: merc.body.uploadKey })).status).toBe(400);

      // The same file with its geometry column switched to the GeoPackage "undefined geographic" system.
      const { DatabaseSync } = await import('node:sqlite');
      const { copyFileSync, mkdtempSync, rmSync } = await import('node:fs');
      const dir = mkdtempSync(path.join(tmpdir(), 'lais-test-gpkg-'));
      const file = path.join(dir, 'undefined.gpkg');
      copyFileSync(path.join(FIXTURES, 'gis', 'synthetic_parcels_4326.gpkg'), file);
      const db = new DatabaseSync(file);
      db.exec('UPDATE gpkg_geometry_columns SET srs_id = 0; UPDATE gpkg_contents SET srs_id = 0;');
      db.close();
      const undefinedCrs = await as('gis.mo').upload('/api/gis/uploads', readFileSync(file), 'undefined.gpkg');
      rmSync(dir, { recursive: true, force: true });
      expect(undefinedCrs.body.layers[0].crs).toMatchObject({ epsg: null, source: 'none', name: 'Undefined Geographic' });
      expect(undefinedCrs.body.warnings.join(' ')).toMatch(/undefined coordinate reference system/);
      const key = undefinedCrs.body.uploadKey;
      expect((await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key, declaredCrs: 4326 })).status).toBe(400);
      const ok = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key, declaredCrs: 4326, crsExceptionReason: 'ArcGIS export settings recorded WGS 84 geographic' });
      expect(ok.status).toBe(200);
      expect(ok.body.accepted).toBe(3);
    });

    it('refuses SQLite files that are not GeoPackages and leaves no temporary copy behind', async () => {
      const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
      const before = readdirSync(tmpdir()).filter((n) => n.startsWith('lais-gpkg-')).length;
      const notSqlite = await as('gis.mo').upload('/api/gis/uploads', Buffer.from('SQLite format 3 but not really'), 'parcels.gpkg');
      expect(notSqlite.status).toBe(400);
      expect(notSqlite.body.error).toMatch(/not a GeoPackage/);
      const { DatabaseSync } = await import('node:sqlite');
      const dir = mkdtempSync(path.join(tmpdir(), 'lais-test-sqlite-'));
      const plain = new DatabaseSync(path.join(dir, 'plain.sqlite'));
      plain.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
      plain.close();
      const res = await as('gis.mo').upload('/api/gis/uploads', readFileSync(path.join(dir, 'plain.sqlite')), 'plain.gpkg');
      rmSync(dir, { recursive: true, force: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/gpkg_ tables are missing/);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('lais-gpkg-')).length).toBe(before);
    });
  });

  describe('CRS handling', () => {
    let caseId: string;
    beforeAll(async () => { caseId = (await newCase({ caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-CRS-TEST' })).id; });

    it('never assigns a CRS silently: an unknown CRS needs a declaration and a reason', async () => {
      const key = (await inspect('synthetic_parcels_noprj_shp.zip')).body.uploadKey;
      const none = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key });
      expect(none.status).toBe(400);
      expect(none.body.error).toMatch(/unknown/i);
      const noReason = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key, declaredCrs: 4326 });
      expect(noReason.status).toBe(400);
      const ok = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key, declaredCrs: 4326, crsExceptionReason: 'Survey report SR-17 states WGS 84 geographic coordinates' });
      expect(ok.status).toBe(200);
      expect(ok.body.crs).toMatchObject({ detected: null, declared: 4326 });
      expect(ok.body.accepted).toBe(3);
      const job = await importAndWait(caseId, key, { declaredCrs: 4326, crsExceptionReason: 'Survey report SR-17 states WGS 84 geographic coordinates', fieldMapping: { legacy_ref: 'PARCEL_NO', land_category: 'CATEGORY' } });
      expect(job.job.status).toMatch(/^completed/);
      expect(job.job.crs_exception_reason).toMatch(/SR-17/);
      expect(job.job.source_crs_detected).toBeNull();
    });

    it('refuses a declaration that contradicts the file, and unsupported systems', async () => {
      const key = (await inspect('synthetic_parcels_4326_shp.zip')).body.uploadKey;
      const mismatch = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: key, declaredCrs: 32629 });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error).toMatch(/metadata says EPSG:4326/);
      const nokey = await inspect('synthetic_parcels_noprj_shp.zip');
      const merc = await as('gis.mo').post('/api/gis/imports/preview', { caseId, uploadKey: nokey.body.uploadKey, declaredCrs: 3857, crsExceptionReason: 'Web map export from a phone app' });
      expect(merc.status).toBe(400);
    });

    it('records on case-page imports whether the CRS came from the file or from the officer', async () => {
      const withCrs = JSON.parse(onePolygon(0.05).toString());
      withCrs.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } };
      const a = await as('gis.mo').upload(`/api/cases/${caseId}/geometry`, Buffer.from(JSON.stringify(withCrs)), 'with-crs.geojson', { crs: '4326' });
      expect(a.status).toBe(201);
      const b = await as('gis.mo').upload(`/api/cases/${caseId}/geometry`, onePolygon(0.06), 'no-crs.geojson', { crs: '4326' });
      expect(b.status).toBe(201);
      const { rows } = await pool.query(
        `SELECT source_name, source_crs_detected, crs_exception_reason FROM staging.import_job WHERE case_id = $1 AND purpose = 'Case page import' ORDER BY created_at`, [caseId]);
      expect(rows).toEqual([
        { source_name: 'with-crs.geojson', source_crs_detected: 4326, crs_exception_reason: null },
        { source_name: 'no-crs.geojson', source_crs_detected: null, crs_exception_reason: expect.stringMatching(/Chosen explicitly by the officer/) },
      ]);
      // A declaration that contradicts the file is refused, as in the wizard.
      expect((await as('gis.mo').upload(`/api/cases/${caseId}/geometry`, Buffer.from(JSON.stringify(withCrs)), 'with-crs.geojson', { crs: '32629' })).status).toBe(400);
    });

    it('stages UTM 29N data and keeps the input coordinates as received', async () => {
      const key = (await inspect('synthetic_parcels_utm29n_shp.zip')).body.uploadKey;
      const job = await importAndWait(caseId, key, { fieldMapping: { legacy_ref: 'PARCEL_NO', land_category: 'CATEGORY' } });
      expect(job.job.status).toMatch(/^completed/);
      expect(job.job.source_crs_declared).toBe(32629);
      const { rows: [f] } = await pool.query('SELECT ST_SRID(geom_input) AS s, ST_SRID(geom) AS t FROM staging.feature WHERE batch_id = $1 LIMIT 1', [job.job.batch_id]);
      expect(f).toEqual({ s: 32629, t: 4326 });
    });
  });

  describe('import jobs', () => {
    let migrationId: string;
    let csvKey: string;
    let firstJob: string;

    it('previews without staging, then imports a CSV with WKT as a new version', async () => {
      migrationId = (await newCase({ caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-CSV-REGISTER' })).id;
      csvKey = (await inspect('synthetic_parcels_wkt_4326.csv')).body.uploadKey;
      const preview = await as('gis.mo').post('/api/gis/imports/preview', { caseId: migrationId, uploadKey: csvKey, declaredCrs: 4326, crsExceptionReason: 'CSV exported from the 4326 file geodatabase', fieldMapping: { legacy_ref: 'parcel_no', land_category: 'category' } });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ received: 3, accepted: 3, rejected: 0, withinLimits: true });
      expect(preview.body.extent[0]).toBeCloseTo(-10.702, 3);
      expect((await pool.query('SELECT count(*)::int AS n FROM staging.batch WHERE case_id = $1', [migrationId])).rows[0].n).toBe(0);

      const job = await importAndWait(migrationId, csvKey, { declaredCrs: 4326, crsExceptionReason: 'CSV exported from the 4326 file geodatabase', fieldMapping: { legacy_ref: 'parcel_no', land_category: 'category' }, wktColumn: 'wkt' });
      firstJob = job.jobId;
      expect(job.job).toMatchObject({ status: 'completed', records_accepted: 3, version_no: 1, source_format: 'csv_wkt' });
      const { rows } = await pool.query(`SELECT f.properties FROM staging.feature f JOIN staging.batch b ON b.id = f.batch_id WHERE b.case_id = $1 ORDER BY f.feature_index`, [migrationId]);
      expect(rows[0].properties).toMatchObject({ legacy_ref: 'SYN-GIS-001', land_category: 'private', parcel_no: 'SYN-GIS-001' });
    });

    it('does not create a duplicate version when the same source is imported again', async () => {
      const again = await importAndWait(migrationId, csvKey, { declaredCrs: 4326, crsExceptionReason: 'CSV exported from the 4326 file geodatabase', fieldMapping: { legacy_ref: 'parcel_no', land_category: 'category' }, wktColumn: 'wkt' });
      expect(again.job.status).toBe('completed_with_warnings');
      expect(again.job.warnings.join(' ')).toMatch(/Identical to the current version 1/);
      expect((await pool.query('SELECT count(*)::int AS n FROM staging.batch WHERE case_id = $1', [migrationId])).rows[0].n).toBe(1);
    });

    it('rejects records without a usable polygon and reports them', async () => {
      const bad = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [
        JSON.parse(onePolygon(0.01).toString()).features[0],
        { type: 'Feature', properties: { source_id: 'P' }, geometry: { type: 'Point', coordinates: [-10.7, 6.4] } },
        { type: 'Feature', properties: { source_id: 'N' }, geometry: null },
      ] }));
      const key = (await as('gis.mo').upload('/api/gis/uploads', bad, 'mixed.geojson')).body.uploadKey;
      const job = await importAndWait(migrationId, key, { declaredCrs: 4326, fieldMapping: { legacy_ref: 'source_id' } });
      expect(job.job).toMatchObject({ status: 'completed_with_warnings', records_received: 3, records_accepted: 1, records_rejected: 2, version_no: 2 });
      const report = await as('gis.mo').get(`/api/gis/jobs/${job.jobId}/report.csv`);
      expect(report.status).toBe(200);
      expect(report.text).toMatch(/"rejected","2","Geometry type Point/);
      expect(report.text).toMatch(/"rejected","3","No geometry/);
    });

    it('fails a job as a whole, explains why, and retries it as a new job', async () => {
      const reg = await newCase({ caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-SURVEY-GIS' });
      const key = (await inspect('synthetic_parcels_4326_shp.zip')).body.uploadKey;
      const job = await importAndWait(reg.id, key);
      expect(job.job.status).toBe('failed');
      expect(job.job.error_summary).toMatch(/exactly one parcel/);
      expect(job.job.batch_id).toBeNull();
      const detail = await as('gis.mo').get(`/api/gis/jobs/${job.jobId}`);
      expect(detail.body.canRetry).toBe(true);
      expect(detail.body.diagnostic.find((d: any) => d.step === 'Staged version').ok).toBe(false);
      expect((await as('gis.mg').post(`/api/gis/jobs/${job.jobId}/retry`)).status).toBe(403);
      const retry = await as('gis.mo').post(`/api/gis/jobs/${job.jobId}/retry`);
      expect(retry.status).toBe(202);
      expect(retry.body.job.retry_of_job_no).toBe(job.jobNo);
      expect(retry.body.job.status).toBe('failed');
      expect((await as('gis.mo').post(`/api/gis/jobs/${job.jobId}/cancel`)).status).toBe(409);
      // Nothing was staged by either attempt.
      expect((await pool.query('SELECT count(*)::int AS n FROM staging.batch WHERE case_id = $1', [reg.id])).rows[0].n).toBe(0);
    });

    it('lists jobs with counts and keeps them inside the county', async () => {
      const list = await as('gis.mo').get('/api/gis/jobs?pageSize=100');
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBeGreaterThan(3);
      expect(list.body.counts.failed).toBeGreaterThanOrEqual(2);
      expect((await as('gis.mg').get('/api/gis/jobs?pageSize=100')).body.items).toEqual([]);
      expect((await as('gis.mg').get(`/api/gis/jobs/${firstJob}`)).status).toBe(403);
      expect((await as('gis.mg').get('/api/gis/jobs?countyId=1')).status).toBe(403);
    });

    it('marks jobs interrupted by a restart as failed', async () => {
      const { rows: [j] } = await pool.query(`SELECT * FROM staging.import_job WHERE id = $1`, [firstJob]);
      const { rows: [stuck] } = await pool.query(
        `INSERT INTO staging.import_job (kind, status, county_id, case_id, initiated_by, source_name, source_format, source_crs_declared, crs_exception_reason, started_at)
         VALUES ('import', 'running', $1, $2, $3, 'stuck.geojson', 'geojson', 4326, 'test', now()) RETURNING id`, [j.county_id, j.case_id, j.initiated_by]);
      const { failInterruptedJobs } = await import('../../src/services/gisJobs.js');
      await failInterruptedJobs();
      const { rows: [after] } = await pool.query('SELECT status, error_summary FROM staging.import_job WHERE id = $1', [stuck.id]);
      expect(after.status).toBe('failed');
      expect(after.error_summary).toMatch(/restart/);
    });

    it('rejects imports into another county or a closed case', async () => {
      const key = (await as('gis.mg').upload('/api/gis/uploads', onePolygon(), 'p.geojson')).body.uploadKey;
      expect((await as('gis.mg').post('/api/gis/imports', { caseId: migrationId, uploadKey: key, confirm: true })).status).toBe(403);
      // An upload belongs to the officer who sent it.
      expect((await as('gis.mo').post('/api/gis/imports/preview', { caseId: migrationId, uploadKey: key })).status).toBe(404);
    });
  });

  describe('versions, corrections and submissions', () => {
    let id: string;

    async function prepare() {
      const c = await newCase({ caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-SURVEY-VERSIONS' });
      const key = (await as('gis.mo').upload('/api/gis/uploads', onePolygon(0.03, { notes: 'first' }), 'parcel.geojson')).body.uploadKey;
      const job = await importAndWait(c.id, key, { declaredCrs: 4326 });
      expect(job.job.status).toMatch(/^completed/);
      const { rows: [party] } = await pool.query(`SELECT id FROM lais.party WHERE name ILIKE '%Hawa%' LIMIT 1`);
      expect((await as('proc.mo').post(`/api/cases/${c.id}/rights`, { partyId: party.id, rrrType: 'ownership' })).status).toBe(201);
      // Documents are verified by someone other than the uploader.
      for (const [who, verifier, type, ref] of [['gis.mo', 'proc.mo', 'survey_plan', 'SP-V'], ['proc.mo', 'proc2.mo', 'deed', 'D-V']] as const) {
        const doc = await as(who).upload(`/api/cases/${c.id}/documents`, fixture('synthetic_document.pdf'), `${type}.pdf`, { docType: type, classification: 'restricted', referenceNo: ref });
        expect(doc.status).toBe(201);
        expect((await as(verifier).post(`/api/cases/${c.id}/documents/${doc.body.id}/verify`, { status: 'verified', note: 'Checked against source' })).status).toBe(200);
      }
      return c.id;
    }

    it('creates a new version for an attribute correction and compares versions', async () => {
      id = await prepare();
      const corr = await as('gis.mo').post(`/api/gis/cases/${id}/corrections`, { reason: 'Land use confirmed by the field team', changes: [{ featureIndex: 0, set: { land_use: 'commercial', notes: 'corrected' } }] });
      expect(corr.status).toBe(201);
      expect(corr.body).toMatchObject({ versionNo: 2, changed: 1 });
      const versions = await as('gis.mo').get(`/api/gis/cases/${id}/versions`);
      expect(versions.body.versions.map((v: any) => v.version_no)).toEqual([2, 1]);
      expect(versions.body.versions[0]).toMatchObject({ source_kind: 'correction', parent_version: 1, status: 'active' });
      const cmp = await as('gis.mo').get(`/api/gis/cases/${id}/versions/compare?a=1&b=2`);
      expect(cmp.status).toBe(200);
      expect(cmp.body.summary).toMatchObject({ modified: 1 });
      expect(cmp.body.changes[0].geometryChanged).toBe(false);
      expect(cmp.body.changes[0].attributes).toEqual(expect.arrayContaining([{ field: 'notes', from: 'first', to: 'corrected' }]));
      expect(cmp.body.geometry.a.features).toHaveLength(1);
      // The correction is a processing job too, with its own number.
      expect((await as('gis.mo').get(`/api/gis/jobs?caseId=${id}&kind=correction`)).body.items).toHaveLength(1);
    });

    it('refuses submission while blocking errors remain (no exception route)', async () => {
      const bad = await newCase({ caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-CROSSES' });
      const key = (await as('gis.mo').upload('/api/gis/uploads', fixture('crosses_county_4326.geojson'), 'crosses.geojson')).body.uploadKey;
      await importAndWait(bad.id, key, { declaredCrs: 4326 });
      const check = await as('gis.mo').get(`/api/gis/cases/${bad.id}/submission-check`);
      expect(check.body.ready).toBe(false);
      expect(check.body.errors.map((e: any) => e.code)).toContain('CROSSES_COUNTY_BOUNDARY');
      const res = await as('gis.mo').post(`/api/gis/cases/${bad.id}/submit`, { summary: 'Ready for the supervisor', confirmChecklist: true, warningsAcknowledged: true });
      expect(res.status).toBe(409);
      expect((await pool.query('SELECT count(*)::int AS n FROM staging.submission WHERE case_id = $1', [bad.id])).rows[0].n).toBe(0);
      expect((await pool.query('SELECT status FROM lais.land_case WHERE id = $1', [bad.id])).rows[0].status).toBe('draft');
    });

    it('submits with the checklist, freezes the snapshot and links resubmissions', async () => {
      const check = await as('gis.mo').get(`/api/gis/cases/${id}/submission-check`);
      expect(check.status).toBe(200);
      expect(check.body.errors, JSON.stringify(check.body.errors)).toEqual([]);
      expect(check.body.ruleSetVersion).toBeGreaterThanOrEqual(1);
      expect((await as('gis.mo').post(`/api/gis/cases/${id}/submit`, { summary: 'Ready for the supervisor' })).status).toBe(400);
      const res = await as('gis.mo').post(`/api/gis/cases/${id}/submit`, { summary: 'Parcel prepared from the field survey', confirmChecklist: true, warningsAcknowledged: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('under_review');
      expect(res.body.submissionNo).toMatch(/^SUB-\d{6}$/);

      const subs = await as('gis.mo').get(`/api/gis/submissions?caseId=${id}`);
      expect(subs.body[0]).toMatchObject({ status: 'awaiting_supervisor', version_no: 2 });
      const detail = await as('gis.mo').get(`/api/gis/submissions/${res.body.submissionId}`);
      expect(detail.body.snapshotIntact).toBe(true);
      // The submitted version cannot be changed, even directly in the database.
      const batchId = detail.body.batch_id;
      await expect(pool.query(`UPDATE staging.feature SET properties = '{}' WHERE batch_id = $1`, [batchId])).rejects.toThrow(/submitted/i);
      await expect(pool.query('DELETE FROM staging.submission WHERE id = $1', [res.body.submissionId])).rejects.toThrow();

      // The supervisor returns it; a resubmission must explain what changed and links to the previous snapshot.
      const ret = await as('sup.mo').post(`/api/supervision/cases/${id}/return`, { reason: 'Check the land use against the field sheet', issueCategories: ['missing_attributes'], instructions: 'Confirm land use' });
      expect(ret.status, JSON.stringify(ret.body)).toBe(201);
      const returned = await as('gis.mo').get('/api/gis/returned');
      const mine = returned.body.find((r: any) => r.id === id);
      expect(mine).toMatchObject({ review_notes: 'Check the land use against the field sheet', instructions: 'Confirm land use', issue_categories: ['missing_attributes'] });
      expect((await as('gis.mo').get(`/api/gis/submissions?caseId=${id}`)).body[0].status).toBe('returned');

      const corr = await as('gis.mo').post(`/api/gis/cases/${id}/corrections`, { reason: 'Land use corrected after review', changes: [{ featureIndex: 0, set: { land_use: 'residential' } }] });
      expect(corr.status).toBe(201);
      expect(corr.body.versionNo).toBe(3);
      const noExplanation = await as('gis.mo').post(`/api/gis/cases/${id}/submit`, { summary: 'Corrected as instructed', confirmChecklist: true, warningsAcknowledged: true });
      expect(noExplanation.status).toBe(400);
      expect(noExplanation.body.error).toMatch(/what changed/);
      const again = await as('gis.mo').post(`/api/gis/cases/${id}/submit`, { summary: 'Corrected as instructed', changeExplanation: 'Land use set back to residential per field sheet', confirmChecklist: true, warningsAcknowledged: true });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const latest = (await as('gis.mo').get(`/api/gis/submissions?caseId=${id}`)).body;
      expect(latest[0]).toMatchObject({ previous_submission_no: res.body.submissionNo, version_no: 3, status: 'awaiting_supervisor' });
      expect(latest[1].status).toBe('superseded');
      // The first snapshot is still intact after the later versions.
      expect((await as('gis.mo').get(`/api/gis/submissions/${res.body.submissionId}`)).body.snapshotIntact).toBe(true);
    });

    it('never lets a GIS officer approve or publish', async () => {
      expect((await as('gis.mo').post(`/api/cases/${id}/decision`, { decision: 'approved', reason: 'Looks fine to me', authorityBasis: 'none' })).status).toBe(403);
      expect((await as('gis.mo').post(`/api/cases/${id}/publish`)).status).toBe(403);
    });
  });

  describe('ArcMap synchronization', () => {
    let token: string;
    let tokenId: string;
    let migration: { id: string; caseNo: string };
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

    it('creates a personal token that is shown once and stored only as a hash', async () => {
      const res = await as('gis.mo').post('/api/gis/sync/tokens', { label: 'Office ArcMap', days: 30 });
      expect(res.status).toBe(201);
      token = res.body.token;
      tokenId = res.body.id;
      expect(token).toMatch(/^lais_sync_/);
      const list = await as('gis.mo').get('/api/gis/sync/tokens');
      expect(JSON.stringify(list.body)).not.toContain(token);
      expect(list.body[0]).toMatchObject({ token_hint: token.slice(-4), status: 'active' });
      const { rows } = await pool.query('SELECT token_hash FROM lais.sync_token WHERE id = $1', [tokenId]);
      expect(rows[0].token_hash.toString('hex')).not.toContain(Buffer.from(token).toString('hex'));
      const { rows: audit } = await pool.query(`SELECT detail::text AS d FROM audit.event WHERE action = 'gis.sync_token_created'`);
      expect(audit.map((a) => a.d).join()).not.toContain(token);
      expect((await as('proc.mo').post('/api/gis/sync/tokens', { label: 'Not mine' })).status).toBe(403);
      expect((await as('sup.mo').post('/api/gis/sync/tokens', { label: 'Not mine' })).status).toBe(403);
    });

    it('reports the configuration honestly before and after the adapter makes contact', async () => {
      expect((await as('gis.mo').get('/api/gis/sync/status')).body.state).toBe('token_unused');
      const ping = await request(app).get('/api/gis/arcmap/ping').set(bearer(token));
      expect(ping.status).toBe(200);
      expect(ping.body.counties.map((c: any) => c.code)).toEqual(['MO']);
      const status = await as('gis.mo').get('/api/gis/sync/status');
      expect(status.body.state).toBe('configured');
      expect(status.body.explanation).toMatch(/not a live connection/);
      const diag = await as('gis.mo').get('/api/gis/sync/diagnostic');
      expect(diag.body.checks.find((c: any) => c.check === 'Active sync token').ok).toBe(true);
    });

    it('accepts a package with the token, and processes a resent export only once', async () => {
      migration = await newCase({ caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-ARCMAP-REGISTER' });
      migration.caseNo = await caseNo(migration.id);
      const pkg = packageFor(migration.caseNo, { export_id: 'EXP-0001' });
      const first = await request(app).post('/api/gis/arcmap/packages').set(bearer(token)).field('caseNo', migration.caseNo).attach('package', pkg, 'export.zip');
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      expect(first.body).toMatchObject({ status: 'completed', records_accepted: 3, version_no: 1, duplicate: false });
      const { rows: [f] } = await pool.query(`SELECT f.properties FROM staging.feature f JOIN staging.batch b ON b.id = f.batch_id WHERE b.case_id = $1 ORDER BY f.feature_index LIMIT 1`, [migration.id]);
      expect(f.properties).toMatchObject({ source_id: 'SYN-GIS-001', land_category: 'private', surveyed_area_m2: 10000 });
      const again = await request(app).post('/api/gis/arcmap/packages').set(bearer(token)).field('caseNo', migration.caseNo).attach('package', pkg, 'export.zip');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ duplicate: true, job_no: first.body.job_no });
      expect((await pool.query('SELECT count(*)::int AS n FROM staging.batch WHERE case_id = $1', [migration.id])).rows[0].n).toBe(1);
      const job = await request(app).get(`/api/gis/arcmap/jobs/${first.body.id}`).set(bearer(token));
      expect(job.body.status).toBe('completed');
    });

    it('checks the manifest against the case: county, case number, counts and CRS', async () => {
      const send = (m: Record<string, unknown>) => request(app).post('/api/gis/arcmap/packages').set(bearer(token))
        .field('caseNo', migration.caseNo).attach('package', packageFor(migration.caseNo, m), 'export.zip');
      const county = await send({ export_id: 'EXP-C', county_code: 'MG' });
      expect(county.body.status).toBe('failed');
      expect(county.body.error_summary).toMatch(/county MG/);
      expect((await send({ export_id: 'EXP-N', feature_count: 7 })).body.error_summary).toMatch(/lists 7 features/);
      expect((await send({ export_id: 'EXP-S', srid: 32629 })).body.error_summary).toMatch(/EPSG:32629/);
      expect((await send({ export_id: 'EXP-K', case_no: 'CASE-2099-999999' })).body.error_summary).toMatch(/exported for/);
      // A package with no .prj is refused: the adapter never sends data with an unknown CRS.
      const noPrj = await request(app).post('/api/gis/arcmap/packages').set(bearer(token)).field('caseNo', migration.caseNo)
        .attach('package', packageFor(migration.caseNo, { export_id: 'EXP-P' }, 'synthetic_parcels_noprj_shp.zip'), 'export.zip');
      expect(noPrj.status).toBe(400);
    });

    it('limits the token to the sync endpoints, the owner\'s counties and its lifetime', async () => {
      expect((await request(app).get('/api/cases').set(bearer(token))).status).toBe(401);
      expect((await request(app).get('/api/gis/summary').set(bearer(token))).status).toBe(401);
      expect((await request(app).get('/api/gis/arcmap/ping')).status).toBe(401);
      expect((await as('gis.mo').get('/api/gis/arcmap/ping')).status).toBe(401);
      expect((await request(app).get('/api/gis/arcmap/ping').set(bearer('lais_sync_forged'))).status).toBe(401);
      const mg = await newCase({ caseType: 'migration', countyId: 2, sourceReference: 'SYNTHETIC-MG' }, 'gis.mg');
      const mgNo = await caseNo(mg.id);
      const other = await request(app).post('/api/gis/arcmap/packages').set(bearer(token)).field('caseNo', mgNo).attach('package', packageFor(mgNo, { county_code: 'MG' }), 'export.zip');
      expect(other.status).toBe(403);
      // Revoked, or the account lost its role: refused immediately.
      expect((await as('gis.mo').delete(`/api/gis/sync/tokens/${tokenId}`)).status).toBe(200);
      expect((await request(app).get('/api/gis/arcmap/ping').set(bearer(token))).status).toBe(401);
      expect((await as('gis.mo').get('/api/gis/sync/status')).body.state).toBe('not_configured');
    });
  });

  describe('validation rules (administrator-configurable, versioned)', () => {
    it('lets administrators change configurable rules only, with a reason and a new version', async () => {
      const before = (await as('gis.mo').get('/api/gis/validation/rules')).body;
      expect(before.canConfigure).toBe(false);
      expect((await as('gis.mo').patch('/api/gis/validation/rules/MULTIPART_GEOMETRY', { severity: 'error', reason: 'Policy change for testing' })).status).toBe(403);
      expect((await as('admin').patch('/api/gis/validation/rules/GEOMETRY_INVALID', { severity: 'warning', reason: 'Trying to weaken a safety rule' })).status).toBe(409);
      expect((await as('admin').patch('/api/gis/validation/rules/MULTIPART_GEOMETRY', { severity: 'error', reason: 'x' })).status).toBe(400);
      const res = await as('admin').patch('/api/gis/validation/rules/MULTIPART_GEOMETRY', { severity: 'error', reason: 'Multipart parcels must be split before submission' });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(before.currentVersion + 1);
      const after = (await as('gis.mo').get('/api/gis/validation/rules')).body;
      expect(after.history[0]).toMatchObject({ rule_code: 'MULTIPART_GEOMETRY', from_value: 'warning', to_value: 'error' });
      await expect(pool.query('UPDATE staging.rule_set_version SET reason = $1', ['rewritten'])).rejects.toThrow();
    });

    it('applies the configured severity and records the rule-set version on each run', async () => {
      const c = await newCase({ caseType: 'migration', countyId: 1, sourceReference: 'SYNTHETIC-MULTIPART' });
      const multi = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { legacy_ref: 'MP-1', land_category: 'private' },
        geometry: { type: 'MultiPolygon', coordinates: [
          [[[-10.72, 6.42], [-10.7192, 6.42], [-10.7192, 6.4208], [-10.72, 6.4208], [-10.72, 6.42]]],
          [[[-10.718, 6.42], [-10.7172, 6.42], [-10.7172, 6.4208], [-10.718, 6.4208], [-10.718, 6.42]]]] } }] }));
      const key = (await as('gis.mo').upload('/api/gis/uploads', multi, 'multi.geojson')).body.uploadKey;
      await importAndWait(c.id, key, { declaredCrs: 4326 });
      const v = await as('gis.mo').post(`/api/cases/${c.id}/validate`);
      const multipart = v.body.findings.find((f: any) => f.code === 'MULTIPART_GEOMETRY');
      expect(multipart).toMatchObject({ severity: 'error', detail: expect.objectContaining({ defaultSeverity: 'warning' }) });
      const { rows: [run] } = await pool.query('SELECT rule_set_version, boundary_status FROM staging.validation_run WHERE id = $1', [v.body.runId]);
      expect(run).toEqual({ rule_set_version: (await pool.query('SELECT max(version) AS v FROM staging.rule_set_version')).rows[0].v, boundary_status: 'synthetic' });
      const center = await as('gis.mo').get(`/api/gis/validation?caseId=${c.id}&code=MULTIPART_GEOMETRY`);
      expect(center.body.findings).toHaveLength(1);
      expect(center.body.findings[0].extent.type).toBe('Polygon');
      const csv = await as('gis.mo').get(`/api/gis/validation.csv?caseId=${c.id}`);
      expect(csv.text).toMatch(/MULTIPART_GEOMETRY/);
      await as('admin').patch('/api/gis/validation/rules/MULTIPART_GEOMETRY', { severity: 'warning', reason: 'Restore the default after the test' });
    });
  });

  describe('GIS tasks', () => {
    it('acknowledges, asks for clarification, claims, and cannot complete before the case is submitted', async () => {
      const c = await newCase({ caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-TASK' });
      const t = await as('sup.mo').post('/api/tasks', { taskType: 'gis_preparation', title: 'Prepare the parcel geometry', countyId: 1, caseId: c.id, assigneeId: await userId('gis.mo') });
      expect(t.status).toBe(201);
      expect((await as('gis.mo').post(`/api/tasks/${t.body.id}/acknowledge`)).status).toBe(200);
      expect((await as('gis.mo').post(`/api/tasks/${t.body.id}/clarification`, { question: 'Which survey plan applies?' })).status).toBe(201);
      expect((await as('gis.mg').post(`/api/tasks/${t.body.id}/acknowledge`)).status).toBe(403);
      expect((await as('gis.mo').post(`/api/tasks/${t.body.id}/status`, { to: 'in_progress' })).status).toBe(200);
      const done = await as('gis.mo').post(`/api/tasks/${t.body.id}/status`, { to: 'completed', note: 'Geometry prepared' });
      expect(done.status).toBe(409);
      expect(done.body.error).toMatch(/has not been submitted/);
      const mine = await as('gis.mo').get('/api/gis/tasks');
      const row = mine.body.mine.find((x: any) => x.id === t.body.id);
      expect(row.acknowledged_at).toBeTruthy();
      expect(row.last_clarification).toMatch(/survey plan/);

      const open = await as('sup.mo').post('/api/tasks', { taskType: 'gis_validation_correction', title: 'Open GIS check', countyId: 1 });
      expect(open.status).toBe(201);
      expect((await as('gis.mo').get('/api/gis/tasks')).body.claimable.some((x: any) => x.id === open.body.id)).toBe(true);
      expect((await as('gis.mg').post(`/api/tasks/${open.body.id}/claim`)).status).toBe(403);
      expect((await as('gis.mo').post(`/api/tasks/${open.body.id}/claim`)).status).toBe(200);
      expect((await as('gis.mo').post(`/api/tasks/${open.body.id}/claim`)).status).toBe(409);
    });
  });

  describe('conflict investigation', () => {
    it('adds notes, re-runs checks and submits findings, without resolving or deleting anything', async () => {
      const c = await newCase({ caseType: 'first_registration', countyId: 1, landCategory: 'private', landUse: 'residential', sourceReference: 'SYNTHETIC-OVERLAP' });
      const key = (await as('gis.mo').upload('/api/gis/uploads', fixture('overlap_published_4326.geojson'), 'overlap.geojson')).body.uploadKey;
      await importAndWait(c.id, key, { declaredCrs: 4326 });
      await as('gis.mo').post(`/api/cases/${c.id}/validate`);
      const list = await as('gis.mo').get(`/api/gis/conflicts?caseId=${c.id}`);
      const conflict = list.body.find((x: any) => x.code === 'OVERLAP_PUBLISHED_PARCEL');
      expect(conflict).toBeTruthy();
      expect((await as('gis.mg').get(`/api/gis/conflicts/${conflict.id}`)).status).toBe(403);
      expect((await as('gis.mo').post(`/api/gis/conflicts/${conflict.id}/actions`, { action: 'note', note: 'Compared with the survey plan' })).status).toBe(201);
      const rerun = await as('gis.mo').post(`/api/gis/conflicts/${conflict.id}/actions`, { action: 'revalidated', note: 'Re-ran after checking the plan' });
      expect(rerun.status).toBe(201);
      expect(rerun.body.rerun.stillDetected).toBe(true);
      expect((await as('gis.mo').post(`/api/gis/conflicts/${conflict.id}/actions`, { action: 'findings_submitted', note: 'short' })).status).toBe(400);
      expect((await as('gis.mo').post(`/api/gis/conflicts/${conflict.id}/actions`, { action: 'findings_submitted', note: 'Digitising error of about 5 m on the east boundary; the plan agrees with the published parcel.' })).status).toBe(201);
      // Supervisor-only actions are not open to the GIS officer, and there is no "resolve" action at all.
      expect((await as('gis.mo').post(`/api/gis/conflicts/${conflict.id}/actions`, { action: 'resolved', note: 'Closing this one' })).status).toBe(400);
      expect((await as('gis.mo').post(`/api/supervision/conflicts/${conflict.id}/actions`, { action: 'note', note: 'Trying the supervisor route' })).status).toBe(403);
      const detail = await as('sup.mo').get(`/api/supervision/conflicts/${conflict.id}`);
      expect(detail.body.events.map((e: any) => e.action)).toEqual(['note', 'revalidated', 'findings_submitted']);
      expect(detail.body.conflict.review_status).not.toBe('resolved');
      await expect(pool.query('DELETE FROM lais.conflict_review_event WHERE case_id = $1', [c.id])).rejects.toThrow();
    });
  });

  describe('dashboard, workspace and reports', () => {
    it('shows twelve indicators for the officer\'s counties only', async () => {
      const res = await as('gis.mo').get('/api/gis/summary');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.kpis).sort()).toEqual([
        'accepted_30d', 'awaiting_review', 'cases_in_preparation', 'cases_with_blocking_errors', 'claimable_tasks', 'jobs_active', 'jobs_failed_7d',
        'my_open_tasks', 'my_overdue_tasks', 'open_conflicts', 'returned_cases', 'versions_7d']);
      expect(res.body.kpis.jobs_failed_7d).toBeGreaterThan(0);
      expect((await as('gis.mg').get('/api/gis/summary?countyId=1')).status).toBe(403);
      expect((await as('proc.mo').get('/api/gis/summary')).status).toBe(403);
    });

    it('serves the workspace layers and finds features by identifier', async () => {
      const res = await as('gis.mo').get('/api/gis/workspace/layers');
      expect(res.status).toBe(200);
      for (const k of ['reference', 'working', 'submitted', 'invalid', 'overlaps', 'duplicates', 'boundary']) expect(res.body.layers[k].type).toBe('FeatureCollection');
      expect(res.body.layers.reference.features.length).toBeGreaterThan(0);
      expect(res.body.layers.boundary.features.map((f: any) => f.properties.code)).toEqual(['MO']);
      expect(res.body.layers.overlaps.features.length).toBeGreaterThan(0);
      expect((await as('gis.mg').get('/api/gis/workspace/layers')).body.layers.reference.features.every((f: any) => !String(f.properties.upi).includes('-MO-'))).toBe(true);
      const search = await as('gis.mo').get('/api/gis/workspace/search?q=PROV-MO');
      expect(search.body[0]).toMatchObject({ kind: 'parcel' });
    });

    it('generates GIS reports as JSON, CSV and PDF', async () => {
      const list = await as('gis.mo').get('/api/gis/reports');
      expect(list.body.map((r: any) => r.key)).toEqual(expect.arrayContaining(['import_jobs', 'validation_findings', 'submissions', 'returns', 'conflicts']));
      const json = await as('gis.mo').get('/api/gis/reports/import_jobs');
      expect(json.body.rows.length).toBeGreaterThan(0);
      expect(json.body.scope).toBe('MO');
      const csv = await as('gis.mo').get('/api/gis/reports/import_jobs.csv');
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toMatch(/synthetic/);
      const pdf = await as('gis.mo').get('/api/gis/reports/submissions.pdf').buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).toString('latin1')).toMatch(/%%EOF\s*$/);
      expect((await as('auditor').get('/api/gis/reports/import_jobs')).status).toBe(403);
    });
  });
});
