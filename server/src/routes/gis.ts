import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import multer from 'multer';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { pool } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { config } from '../config.js';
import { enforce } from '../authz/enforce.js';
import { scopeFor } from '../authz/policy.js';
import { EDITABLE_STATUSES, SPATIAL_CASE_TYPES } from '../authz/workflow.js';
import { caseContext, getCase } from '../services/cases.js';
import { ACCEPTED_SRIDS } from '../services/geojson.js';
import { LIMITS, UNSUPPORTED, inspection, openUpload } from '../services/gisFormats.js';
import {
  REQUIRED_FIELDS, TARGET_FIELDS, createJob, loadUpload, previewImport, saveUpload, startJob, type JobInput, type TargetField,
} from '../services/gisJobs.js';
import { CONFLICTS_SQL, OPEN_CONFLICT_STATUSES } from '../services/conflicts.js';
import { resolveScope } from '../services/supervision.js';
import { MAX_SYNC_TOKEN_DAYS, createSyncToken, listSyncTokens, revokeSyncToken } from '../auth/syncToken.js';
import { csvCell } from '../csv.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * The GIS officer's workspace: dashboard, tasks, map layers, the data import wizard, processing jobs and
 * ArcMap synchronization. GIS officers prepare data in staging; nothing here approves, publishes,
 * changes ownership, deletes a version or reaches outside the officer's counties.
 */
export const gisRouter = Router();

/** Version of the ArcMap adapter shipped in integrations/arcmap (checked by the diagnostic). */
export const ADAPTER_VERSION = '1.0.0';

const countyParam = z.coerce.number().int().positive().optional();
const OPEN_TASK = ['unassigned', 'assigned', 'in_progress', 'blocked', 'returned'];
const GIS_TASK_TYPES = ['gis_preparation', 'gis_validation_correction', 'attribute_verification', 'conflict_investigation',
  'application_follow_up', 'additional_information', 'correction_resubmission'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.maxUploadBytes, files: 1, fields: 20 } });

/** The officer must hold an import role somewhere; the case itself is checked when a job is created. */
function assertImporter(req: Request) {
  const scope = scopeFor(req.auth!.principal, 'case.import_geometry');
  if (scope !== 'all' && scope.length === 0) enforce(req, 'case.import_geometry', { countyId: null }, { entityType: 'import_job' });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const summaryQuery = z.object({ countyId: countyParam });

gisRouter.get('/summary', async (req, res) => {
  const q = summaryQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const me = req.auth!.user.id;
  const spatial = [...SPATIAL_CASE_TYPES];
  const [k, conflicts, lastSync, recentJobs, myTasks] = await Promise.all([
    pool.query(
      `WITH lr AS (SELECT DISTINCT ON (case_id) case_id, id, error_count, warning_count FROM staging.validation_run ORDER BY case_id, run_at DESC),
            cs AS (SELECT c.* FROM lais.land_case c WHERE c.case_type = ANY($2) AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)))
       SELECT
         (SELECT count(*) FROM lais.task t WHERE t.assignee_id = $3 AND t.status = ANY($4))::int AS my_open_tasks,
         (SELECT count(*) FROM lais.task t WHERE t.assignee_id = $3 AND t.status = ANY($4) AND t.due_date < current_date)::int AS my_overdue_tasks,
         (SELECT count(*) FROM lais.task t WHERE t.assignee_id IS NULL AND t.status = 'unassigned' AND t.task_type = ANY($5)
             AND ($1::smallint[] IS NULL OR t.county_id = ANY($1)))::int AS claimable_tasks,
         (SELECT count(*) FROM cs WHERE cs.status = 'draft')::int AS cases_in_preparation,
         (SELECT count(*) FROM cs WHERE cs.status = 'returned')::int AS returned_cases,
         (SELECT count(*) FROM cs JOIN lr ON lr.case_id = cs.id WHERE cs.status = ANY($6) AND lr.error_count > 0)::int AS cases_with_blocking_errors,
         (SELECT count(*) FROM cs WHERE cs.status = 'under_review')::int AS awaiting_review,
         (SELECT count(*) FROM lais.supervisory_review r WHERE r.decision = 'accepted' AND r.created_at > now() - interval '30 days'
             AND ($1::smallint[] IS NULL OR r.county_id = ANY($1)))::int AS accepted_30d,
         (SELECT count(*) FROM staging.import_job j WHERE j.status IN ('queued', 'running') AND ($1::smallint[] IS NULL OR j.county_id = ANY($1)))::int AS jobs_active,
         (SELECT count(*) FROM staging.import_job j WHERE j.status = 'failed' AND j.created_at > now() - interval '7 days'
             AND ($1::smallint[] IS NULL OR j.county_id = ANY($1)))::int AS jobs_failed_7d,
         (SELECT count(*) FROM staging.batch b JOIN cs ON cs.id = b.case_id WHERE b.created_at > now() - interval '7 days')::int AS versions_7d`,
      [counties, spatial, me, OPEN_TASK, GIS_TASK_TYPES, EDITABLE_STATUSES],
    ),
    pool.query(`SELECT count(*)::int AS n FROM (${CONFLICTS_SQL}) x WHERE x.review_status = ANY($2)`, [counties, OPEN_CONFLICT_STATUSES]),
    pool.query(
      `SELECT j.job_no, j.status, j.finished_at, j.created_at FROM staging.import_job j
        WHERE j.kind = 'arcmap_sync' AND j.initiated_by = $1 ORDER BY j.created_at DESC LIMIT 1`, [me]),
    pool.query(
      `SELECT j.id, j.job_no, j.kind, j.status, j.source_name, j.created_at, c.case_no FROM staging.import_job j JOIN lais.land_case c ON c.id = j.case_id
        WHERE ($1::smallint[] IS NULL OR j.county_id = ANY($1)) ORDER BY j.created_at DESC LIMIT 8`, [counties]),
    pool.query(
      `SELECT t.id, t.task_no, t.title, t.status, t.priority, t.due_date, c.case_no FROM lais.task t LEFT JOIN lais.land_case c ON c.id = t.case_id
        WHERE t.assignee_id = $1 AND t.status = ANY($2) ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 8`, [me, OPEN_TASK]),
  ]);
  const s = lastSync.rows[0] ?? null;
  res.json({
    kpis: { ...k.rows[0], open_conflicts: conflicts.rows[0].n },
    lastArcmapSync: s,
    recentJobs: recentJobs.rows,
    myTasks: myTasks.rows,
  });
});

// ---------------------------------------------------------------------------
// My GIS tasks (the moves themselves are the task endpoints under /tasks)
// ---------------------------------------------------------------------------

gisRouter.get('/tasks', async (req, res) => {
  const counties = resolveScope(req, 'task.work');
  const me = req.auth!.user.id;
  const cols = `t.id, t.task_no, t.task_type, t.title, t.description, t.status, t.priority, t.due_date, t.created_at, t.case_id, c.case_no, c.status AS case_status,
                co.code AS county_code, cu.username AS created_by_username,
                (t.due_date < current_date AND t.status = ANY($2)) AS overdue,
                (SELECT max(e.at) FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'acknowledged') AS acknowledged_at,
                (SELECT e.note FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'clarification_requested' ORDER BY e.id DESC LIMIT 1) AS last_clarification`;
  const from = `FROM lais.task t JOIN lais.county co ON co.id = t.county_id LEFT JOIN lais.land_case c ON c.id = t.case_id JOIN lais.app_user cu ON cu.id = t.created_by`;
  const [mine, claimable] = await Promise.all([
    pool.query(`SELECT ${cols} ${from} WHERE t.assignee_id = $1 ORDER BY (t.status = ANY($2)) DESC, t.due_date NULLS LAST, t.created_at DESC LIMIT 200`, [me, OPEN_TASK]),
    pool.query(
      `SELECT ${cols} ${from} WHERE t.assignee_id IS NULL AND t.status = 'unassigned' AND t.task_type = ANY($3)
          AND ($1::smallint[] IS NULL OR t.county_id = ANY($1)) ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 100`,
      [counties, OPEN_TASK, GIS_TASK_TYPES]),
  ]);
  res.json({ mine: mine.rows, claimable: claimable.rows });
});

// ---------------------------------------------------------------------------
// Cases a GIS officer works on (pickers)
// ---------------------------------------------------------------------------

const casesQuery = z.object({ countyId: countyParam, editable: z.enum(['true', 'false']).optional(), q: z.string().trim().max(60).optional() });

gisRouter.get('/cases', async (req, res) => {
  const q = casesQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `SELECT c.id, c.case_no, c.case_type, c.status, c.county_id, co.code AS county_code, c.proposed_upi, c.priority,
            b.id AS batch_id, b.version_no, b.feature_count, b.declared_srid, b.created_at AS version_at,
            lr.error_count, lr.warning_count, lr.run_at AS validated_at
       FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id
       LEFT JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active'
       LEFT JOIN LATERAL (SELECT error_count, warning_count, run_at FROM staging.validation_run r WHERE r.case_id = c.id ORDER BY run_at DESC LIMIT 1) lr ON true
      WHERE c.case_type = ANY($2) AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
        AND ($3::boolean IS NOT TRUE OR c.status = ANY($4))
        AND ($5::text IS NULL OR c.case_no ILIKE '%' || $5 || '%' OR c.proposed_upi ILIKE '%' || $5 || '%')
      ORDER BY c.created_at DESC LIMIT 200`,
    [counties, [...SPATIAL_CASE_TYPES], q.editable === 'true', EDITABLE_STATUSES, q.q || null],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Parcel workspace: map layers
// ---------------------------------------------------------------------------

const layersQuery = z.object({
  countyId: countyParam,
  caseId: z.string().uuid().optional(),
  bbox: z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/).optional(),
});
const MAX_LAYER_FEATURES = 3000;

const collection = (rows: { geometry: unknown; [k: string]: unknown }[]) => ({
  type: 'FeatureCollection',
  features: rows.filter((r) => r.geometry).map(({ geometry, ...properties }) => ({ type: 'Feature', geometry, properties })),
});

gisRouter.get('/workspace/layers', async (req, res) => {
  const q = layersQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const bbox = q.bbox ? q.bbox.split(',').map(Number) : null;
  if (bbox && (bbox[0] >= bbox[2] || bbox[1] >= bbox[3])) throw badRequest('bbox must be minLon,minLat,maxLon,maxLat');
  let caseFilter: string | null = null;
  if (q.caseId) {
    const cs = await getCase(pool, q.caseId);
    enforce(req, 'gis.workspace', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
    caseFilter = cs.id;
  }
  const env = `($2::float8[] IS NULL OR ST_Intersects(%s, ST_MakeEnvelope($2[1], $2[2], $2[3], $2[4], 4326)))`;
  const area = (g: string) => env.replace('%s', g);
  const staged = `FROM staging.feature f JOIN staging.batch b ON b.id = f.batch_id AND b.status = 'active'
                  JOIN lais.land_case c ON c.id = b.case_id
                 WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND ($3::uuid IS NULL OR c.id = $3) AND NOT f.excluded`;
  const latestFindings = `SELECT DISTINCT ON (r.case_id) r.id, r.case_id FROM staging.validation_run r ORDER BY r.case_id, r.run_at DESC`;
  const args = [counties, bbox, caseFilter];
  const [reference, working, submitted, invalid, overlaps, duplicates, boundary] = await Promise.all([
    // Approved reference parcels: the published register (shown whatever case is selected).
    pool.query(
      `SELECT ST_AsGeoJSON(v.geom, 7)::json AS geometry, p.upi, p.status, p.legacy_ref, v.version_no, v.land_category, v.area_m2_calculated
         FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
        WHERE p.status <> 'retired' AND ($1::smallint[] IS NULL OR p.county_id = ANY($1)) AND ${area('v.geom')} AND ($3::uuid IS NULL OR true)
        LIMIT ${MAX_LAYER_FEATURES}`,
      args),
    pool.query(
      `SELECT ST_AsGeoJSON(f.geom, 7)::json AS geometry, c.id AS case_id, c.case_no, c.status, b.version_no, f.feature_index,
              f.properties->>'source_id' AS source_id, f.properties->>'legacy_ref' AS legacy_ref
         ${staged} AND c.status = ANY($4) AND f.geom IS NOT NULL AND ${area('f.geom')} LIMIT ${MAX_LAYER_FEATURES}`,
      [...args, EDITABLE_STATUSES]),
    pool.query(
      `SELECT ST_AsGeoJSON(f.geom, 7)::json AS geometry, c.id AS case_id, c.case_no, c.status, b.version_no, f.feature_index
         ${staged} AND c.status IN ('validating', 'under_review', 'approved') AND f.geom IS NOT NULL AND ${area('f.geom')} LIMIT ${MAX_LAYER_FEATURES}`,
      args),
    // Invalid geometry is shown as received (transformed for display only), never repaired.
    pool.query(
      `SELECT ST_AsGeoJSON(ST_Transform(f.geom_input, 4326), 7)::json AS geometry, c.id AS case_id, c.case_no, b.version_no, f.feature_index,
              f.structural_message AS problem
         ${staged} AND NOT f.structural_ok AND ${area('ST_Transform(f.geom_input, 4326)')} LIMIT ${MAX_LAYER_FEATURES}`,
      args),
    pool.query(
      `WITH lr AS (${latestFindings})
       SELECT ST_AsGeoJSON(ST_Intersection(sf.geom, v.geom), 7)::json AS geometry, c.case_no, x.code, x.severity, p.upi AS related_upi,
              round(ST_Area(ST_Intersection(sf.geom, v.geom)::geography)::numeric, 1) AS overlap_m2, x.id AS finding_id
         FROM lr JOIN staging.finding x ON x.run_id = lr.id AND x.code IN ('OVERLAP_PUBLISHED_PARCEL', 'DUPLICATE_GEOMETRY_SUSPECTED')
         JOIN lais.land_case c ON c.id = lr.case_id
         JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active'
         JOIN staging.feature sf ON sf.batch_id = b.id AND sf.feature_index = coalesce(x.feature_index, 0) AND sf.geom IS NOT NULL
         JOIN lais.parcel p ON p.id = x.related_parcel_id JOIN lais.parcel_version v ON v.id = p.current_version_id
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND ($3::uuid IS NULL OR c.id = $3) AND ${area('sf.geom')}
        LIMIT ${MAX_LAYER_FEATURES}`,
      args),
    pool.query(
      `WITH lr AS (${latestFindings})
       SELECT ST_AsGeoJSON(sf.geom, 7)::json AS geometry, c.case_no, x.code, x.message, sf.feature_index
         FROM lr JOIN staging.finding x ON x.run_id = lr.id AND x.code IN ('DUPLICATE_LEGACY_REF', 'DUPLICATE_SOURCE_ID', 'DUPLICATE_UPI', 'UPI_IN_OTHER_OPEN_CASE')
         JOIN lais.land_case c ON c.id = lr.case_id
         JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active'
         JOIN staging.feature sf ON sf.batch_id = b.id AND sf.feature_index = coalesce(x.feature_index, 0) AND sf.geom IS NOT NULL
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND ($3::uuid IS NULL OR c.id = $3) AND ${area('sf.geom')}
        LIMIT ${MAX_LAYER_FEATURES}`,
      args),
    pool.query(
      `SELECT ST_AsGeoJSON(geom, 6)::json AS geometry, code, name, boundary_status FROM lais.county
        WHERE geom IS NOT NULL AND ($1::smallint[] IS NULL OR id = ANY($1))`, [counties]),
  ]);
  res.json({
    layers: {
      reference: collection(reference.rows), working: collection(working.rows), submitted: collection(submitted.rows),
      invalid: collection(invalid.rows), overlaps: collection(overlaps.rows), duplicates: collection(duplicates.rows), boundary: collection(boundary.rows),
    },
    truncated: [reference, working, submitted].some((r) => r.rows.length >= MAX_LAYER_FEATURES),
    limit: MAX_LAYER_FEATURES,
  });
});

const searchQuery = z.object({ q: z.string().trim().min(2).max(60), countyId: countyParam });

/** Finds parcels and cases by identifier, returning where they are so the map can zoom to them. */
gisRouter.get('/workspace/search', async (req, res) => {
  const q = searchQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `(SELECT 'parcel' AS kind, p.upi AS label, p.id::text AS id, ST_AsGeoJSON(ST_Envelope(v.geom), 7)::json AS extent
        FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
       WHERE ($1::smallint[] IS NULL OR p.county_id = ANY($1)) AND (p.upi ILIKE '%' || $2 || '%' OR p.legacy_ref ILIKE '%' || $2 || '%') LIMIT 10)
     UNION ALL
     (SELECT 'case', c.case_no, c.id::text, ST_AsGeoJSON(ST_Envelope(ST_Collect(f.geom)), 7)::json
        FROM lais.land_case c JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active' JOIN staging.feature f ON f.batch_id = b.id
       WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND c.case_no ILIKE '%' || $2 || '%' GROUP BY c.case_no, c.id LIMIT 10)`,
    [counties, q.q],
  );
  res.json(rows.filter((r) => r.extent));
});

// ---------------------------------------------------------------------------
// Data import center
// ---------------------------------------------------------------------------

/** What the import wizard needs to know before a file is chosen. */
gisRouter.get('/imports/options', (req, res) => {
  resolveScope(req, 'gis.workspace');
  res.json({
    formats: [
      { format: 'geojson', label: 'GeoJSON (.geojson, .json)', supported: true },
      { format: 'shapefile', label: 'Shapefile in a .zip (.shp, .shx, .dbf, optional .prj and .cpg)', supported: true },
      { format: 'csv_wkt', label: 'CSV with a WKT geometry column (.csv)', supported: true },
      { format: 'geopackage', label: 'GeoPackage (.gpkg), every feature table; CRS from gpkg_spatial_ref_sys', supported: true },
      { format: 'arcmap_package', label: 'LAIS ArcMap export package (.zip with manifest.json)', supported: true },
      ...Object.entries(UNSUPPORTED).map(([ext, why]) => ({ format: ext, label: ext, supported: false, reason: why })),
    ],
    acceptedCrs: Object.entries(ACCEPTED_SRIDS).map(([epsg, name]) => ({ epsg: Number(epsg), name })),
    targetFields: Object.entries(TARGET_FIELDS).map(([key, f]) => ({ key, ...f })),
    requiredFields: REQUIRED_FIELDS,
    limits: LIMITS,
  });
});

/** Step 1: upload and inspect. The file is stored under a random key for the next steps, then deleted after the retention period. */
gisRouter.post('/uploads', upload.single('file'), async (req, res) => {
  assertImporter(req);
  if (!req.file) throw badRequest('Attach a file (field "file")');
  const opened = await openUpload(req.file.buffer, req.file.originalname, { wktColumn: typeof req.body?.wktColumn === 'string' ? req.body.wktColumn : null });
  const meta = await saveUpload(req.file.buffer, req.file.originalname, req.auth!.user.id);
  const info = inspection(opened);
  // Suggest a mapping where a source field has a target's name (case-insensitive); the officer confirms it.
  const suggestedMapping = Object.fromEntries(info.layers.map((l) => [l.name, Object.fromEntries(
    Object.keys(TARGET_FIELDS).flatMap((t) => { const f = l.fields.find((x) => x.name.toLowerCase() === t); return f ? [[t, f.name]] : []; }),
  )]));
  await writeAudit(req, { action: 'gis.upload_inspected', outcome: 'success', entityType: 'gis_upload', entityId: meta.key, detail: { file: meta.filename, size: meta.size, sha256: meta.sha256, format: info.format, layers: info.layers.length } });
  res.status(201).json({ uploadKey: meta.key, file: meta.filename, size: meta.size, sha256: meta.sha256, ...info, suggestedMapping, expiresInHours: config.gisUploadRetentionHours });
});

const importBody = z.object({
  caseId: z.string().uuid(),
  uploadKey: z.string().regex(/^[0-9a-f]{32}$/),
  layer: z.string().trim().max(120).nullable().optional(),
  declaredCrs: z.number().int().nullable().optional(),
  crsExceptionReason: z.string().trim().max(1000).nullable().optional(),
  fieldMapping: z.partialRecord(z.enum(Object.keys(TARGET_FIELDS) as [TargetField, ...TargetField[]]), z.string().trim().max(60)).optional(),
  purpose: z.string().trim().max(500).nullable().optional(),
  wktColumn: z.string().trim().max(60).nullable().optional(),
});
const confirmBody = importBody.extend({
  confirm: z.literal(true, { message: 'Confirm the import after reviewing the preview' }),
  wait: z.boolean().optional(),
});

async function authorizeImport(req: Request, caseId: string) {
  const cs = await getCase(pool, caseId);
  enforce(req, 'case.import_geometry', await caseContext(pool, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
  return cs;
}

/** Steps 2-6: target case, field mapping and CRS, then a preview of what would be staged. Nothing is written. */
gisRouter.post('/imports/preview', async (req, res) => {
  const body = importBody.parse(req.body);
  await authorizeImport(req, body.caseId);
  res.json(await previewImport(req, { kind: 'import', ...body } as JobInput));
});

/** Step 7: confirm. A job is queued and runs in the background; poll GET /gis/jobs/{id}. */
gisRouter.post('/imports', async (req, res) => {
  const body = confirmBody.parse(req.body);
  await authorizeImport(req, body.caseId);
  const job = await createJob(req, { kind: 'import', ...body } as JobInput);
  if (!job.duplicate) {
    const done = startJob(job.id);
    if (body.wait) await Promise.race([done, new Promise((r) => setTimeout(r, 20_000))]);
  }
  res.status(202).json({ jobId: job.id, jobNo: job.job_no, duplicate: job.duplicate, job: await jobRow(job.id) });
});

// ---------------------------------------------------------------------------
// Processing jobs
// ---------------------------------------------------------------------------

const JOB_COLUMNS = `j.id, j.job_no, j.kind, j.status, j.county_id, co.code AS county_code, j.case_id, c.case_no, c.status AS case_status,
  j.initiated_by, u.username AS initiated_by_username, j.purpose, j.source_name, j.source_format, j.source_layer, j.source_size_bytes, j.source_sha256,
  j.source_crs_detected, j.source_crs_declared, j.crs_exception_reason, j.target_crs, j.adapter_version, j.source_dataset, j.source_version, j.export_id,
  j.field_mapping, j.records_received, j.records_accepted, j.records_rejected, j.records_inserted, j.records_updated, j.records_unchanged,
  jsonb_array_length(j.warnings) AS warning_count, j.error_summary, j.batch_id, b.version_no, j.retry_of, r.job_no AS retry_of_job_no,
  j.created_at, j.started_at, j.finished_at,
  round(extract(epoch FROM (coalesce(j.finished_at, now()) - coalesce(j.started_at, j.created_at)))::numeric, 1) AS duration_s`;
const JOB_FROM = `FROM staging.import_job j JOIN lais.land_case c ON c.id = j.case_id JOIN lais.county co ON co.id = j.county_id
  JOIN lais.app_user u ON u.id = j.initiated_by LEFT JOIN staging.batch b ON b.id = j.batch_id LEFT JOIN staging.import_job r ON r.id = j.retry_of`;

async function jobRow(id: string) {
  const { rows: [j] } = await pool.query(`SELECT ${JOB_COLUMNS}, j.warnings, j.rejections, j.manifest ${JOB_FROM} WHERE j.id = $1`, [id]);
  return j ?? null;
}

async function loadJob(req: Request, id: string) {
  const j = await jobRow(id);
  if (!j) throw notFound('Job not found');
  enforce(req, 'gis.workspace', { countyId: j.county_id }, { entityType: 'import_job', entityId: j.id, caseId: j.case_id });
  return j;
}

const jobsQuery = z.object({
  countyId: countyParam,
  status: z.enum(['queued', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled']).optional(),
  kind: z.enum(['import', 'arcmap_sync', 'correction']).optional(),
  caseId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

gisRouter.get('/jobs', async (req, res) => {
  const q = jobsQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `SELECT ${JOB_COLUMNS}, count(*) OVER () AS total ${JOB_FROM}
      WHERE ($1::smallint[] IS NULL OR j.county_id = ANY($1)) AND ($2::text IS NULL OR j.status = $2) AND ($3::text IS NULL OR j.kind = $3)
        AND ($4::uuid IS NULL OR j.case_id = $4) AND ($5::uuid IS NULL OR j.initiated_by = $5)
      ORDER BY j.created_at DESC LIMIT $6 OFFSET $7`,
    [counties, q.status ?? null, q.kind ?? null, q.caseId ?? null, q.mine === 'true' ? req.auth!.user.id : null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const { rows: counts } = await pool.query(
    `SELECT status, count(*)::int AS n FROM staging.import_job WHERE ($1::smallint[] IS NULL OR county_id = ANY($1)) GROUP BY status`, [counties]);
  res.json({ items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
});

gisRouter.get('/jobs/:id', async (req, res) => {
  const j = await loadJob(req, parseId(req.params.id));
  // A diagnostic for the officer: what was checked and where it stopped. No file contents, no secrets.
  const diagnostic = [
    { step: 'File received', ok: true, detail: `${j.source_name} (${j.source_format}, ${j.source_size_bytes ?? '?'} bytes, sha256 ${String(j.source_sha256 ?? '').slice(0, 12)}…)` },
    { step: 'Coordinate reference system', ok: j.source_crs_declared !== null,
      detail: j.source_crs_detected ? `EPSG:${j.source_crs_detected} from the file metadata` : `Declared EPSG:${j.source_crs_declared} without file metadata: ${j.crs_exception_reason ?? ''}` },
    { step: 'Records', ok: j.status !== 'failed', detail: `${j.records_received ?? '?'} received, ${j.records_accepted ?? 0} accepted, ${j.records_rejected ?? 0} rejected` },
    { step: 'Staged version', ok: j.batch_id !== null, detail: j.batch_id ? `Version ${j.version_no}` : j.error_summary ?? 'Not staged' },
  ];
  res.json({ ...j, diagnostic, canRetry: ['failed', 'cancelled'].includes(j.status) && j.initiated_by === req.auth!.user.id });
});

/** The rejected records and warnings of a job, as CSV (the error report). */
gisRouter.get('/jobs/:id/report.csv', async (req, res) => {
  const j = await loadJob(req, parseId(req.params.id));
  const lines = [
    `# Import job ${j.job_no} (${j.kind}) for ${j.case_no}: ${j.status}`,
    `# Source ${j.source_name}; CRS EPSG:${j.source_crs_declared ?? 'unknown'}; ${j.records_received ?? 0} received, ${j.records_accepted ?? 0} accepted, ${j.records_rejected ?? 0} rejected`,
    '# Research prototype: synthetic demonstration data, not real land records.',
    ['type', 'record', 'message'].map(csvCell).join(','),
    ...(j.error_summary ? [['error', '', j.error_summary].map(csvCell).join(',')] : []),
    ...(j.rejections as { record: number; reason: string }[]).map((r) => ['rejected', r.record, r.reason].map(csvCell).join(',')),
    ...(j.warnings as string[]).map((w) => ['warning', (/^Record (\d+):/.exec(w)?.[1]) ?? '', w].map(csvCell).join(',')),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lais-${j.job_no}-report.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

/** A failed or cancelled job is retried as a new job with the same settings (the old one stays as evidence). */
gisRouter.post('/jobs/:id/retry', async (req, res) => {
  const j = await loadJob(req, parseId(req.params.id));
  if (!['failed', 'cancelled'].includes(j.status)) throw conflict(`A ${j.status} job cannot be retried`);
  if (j.initiated_by !== req.auth!.user.id) throw new HttpError(403, 'Only the officer who started the job can retry it (the uploaded file is theirs)');
  const { rows: [src] } = await pool.query('SELECT upload_key, manifest FROM staging.import_job WHERE id = $1', [j.id]);
  await authorizeImport(req, j.case_id);
  await loadUpload(src.upload_key, req.auth!.user.id);
  const job = await createJob(req, {
    kind: j.kind === 'arcmap_sync' ? 'arcmap_sync' : 'import', caseId: j.case_id, uploadKey: src.upload_key, layer: j.source_layer,
    declaredCrs: j.source_crs_declared, crsExceptionReason: j.crs_exception_reason, fieldMapping: j.field_mapping, purpose: j.purpose,
    wktColumn: src.manifest?.wkt_column ?? null, retryOf: j.id,
  });
  if (!job.duplicate) await Promise.race([startJob(job.id), new Promise((r) => setTimeout(r, 20_000))]);
  res.status(202).json({ jobId: job.id, jobNo: job.job_no, duplicate: job.duplicate, job: await jobRow(job.id) });
});

gisRouter.post('/jobs/:id/cancel', async (req, res) => {
  const j = await loadJob(req, parseId(req.params.id));
  if (j.initiated_by !== req.auth!.user.id) throw new HttpError(403, 'Only the officer who started the job can cancel it');
  const { rowCount } = await pool.query(`UPDATE staging.import_job SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'`, [j.id]);
  if (!rowCount) throw conflict('Only a queued job can be cancelled; a running job finishes or fails as a whole');
  await writeAudit(req, { action: 'gis.job_cancelled', outcome: 'success', entityType: 'import_job', entityId: j.id, caseId: j.case_id, countyId: j.county_id, detail: { jobNo: j.job_no } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ArcMap synchronization: tokens, status, diagnostic, adapter download
// ---------------------------------------------------------------------------

gisRouter.get('/sync/tokens', async (req, res) => {
  enforce(req, 'gis.sync_token', {}, { entityType: 'sync_token' });
  res.json(await listSyncTokens(pool, req.auth!.user.id));
});

const tokenBody = z.object({ label: z.string().trim().min(3).max(80), days: z.number().int().min(1).max(MAX_SYNC_TOKEN_DAYS).default(30) });

/** Creates a token. It is returned once and never again; only its hash is stored. */
gisRouter.post('/sync/tokens', async (req, res) => {
  enforce(req, 'gis.sync_token', {}, { entityType: 'sync_token' });
  const body = tokenBody.parse(req.body);
  const { rows: [{ n }] } = await pool.query(
    'SELECT count(*)::int AS n FROM lais.sync_token WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [req.auth!.user.id]);
  if (n >= 5) throw conflict('You already have 5 active sync tokens; revoke one first');
  const t = await createSyncToken(pool, req.auth!.user.id, body.label, body.days);
  await writeAudit(req, { action: 'gis.sync_token_created', outcome: 'success', entityType: 'sync_token', entityId: t.id, detail: { label: t.label, hint: t.token_hint, expiresAt: t.expires_at } });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(t);
});

gisRouter.delete('/sync/tokens/:tokenId', async (req, res) => {
  enforce(req, 'gis.sync_token', {}, { entityType: 'sync_token' });
  const id = parseId(req.params.tokenId);
  if (!(await revokeSyncToken(pool, req.auth!.user.id, id))) throw notFound('Token not found or already revoked');
  await writeAudit(req, { action: 'gis.sync_token_revoked', outcome: 'success', entityType: 'sync_token', entityId: id });
  res.json({ ok: true });
});

/**
 * Sync status as the server has observed it: when a token was last used and what the last ArcMap jobs did.
 * The server cannot see ArcMap itself, so it never reports a "live connection".
 */
gisRouter.get('/sync/status', async (req, res) => {
  const counties = resolveScope(req, 'gis.workspace');
  const me = req.auth!.user.id;
  const [tokens, jobs, stats] = await Promise.all([
    listSyncTokens(pool, me),
    pool.query(`SELECT ${JOB_COLUMNS} ${JOB_FROM} WHERE j.kind = 'arcmap_sync' AND ($1::smallint[] IS NULL OR j.county_id = ANY($1)) ORDER BY j.created_at DESC LIMIT 25`, [counties]),
    pool.query(
      `SELECT max(finished_at) FILTER (WHERE status IN ('completed', 'completed_with_warnings')) AS last_success,
              max(finished_at) FILTER (WHERE status = 'failed') AS last_failure,
              count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS failed_7d,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS total_7d
         FROM staging.import_job WHERE kind = 'arcmap_sync' AND initiated_by = $1`, [me]),
  ]);
  const active = tokens.filter((t) => t.status === 'active');
  const lastUsed = active.map((t) => t.last_used_at).filter(Boolean).sort().pop() ?? null;
  const state = active.length === 0 ? 'not_configured' : !lastUsed ? 'token_unused' : 'configured';
  res.json({
    state,
    explanation: {
      not_configured: 'No active sync token: create one and configure the ArcMap adapter with it.',
      token_unused: 'A token exists but the adapter has not contacted the server with it yet. Run the adapter\'s "Test connection" tool.',
      configured: 'The adapter has contacted the server with an active token. This is the last observed contact, not a live connection.',
    }[state],
    lastContact: lastUsed, activeTokens: active.length, adapterVersion: ADAPTER_VERSION, ...stats.rows[0], jobs: jobs.rows,
  });
});

gisRouter.get('/sync/diagnostic', async (req, res) => {
  resolveScope(req, 'gis.workspace');
  const me = req.auth!.user.id;
  const tokens = await listSyncTokens(pool, me);
  const active = tokens.filter((t) => t.status === 'active');
  let uploadDirOk = true;
  try { await fs.mkdir(config.gisUploadDir, { recursive: true }); await fs.access(config.gisUploadDir); } catch { uploadDirOk = false; }
  const { rows: [last] } = await pool.query(
    `SELECT job_no, status, error_summary, adapter_version, finished_at FROM staging.import_job WHERE kind = 'arcmap_sync' AND initiated_by = $1 ORDER BY created_at DESC LIMIT 1`, [me]);
  const soon = active.filter((t) => new Date(t.expires_at).getTime() - Date.now() < 7 * 86_400_000);
  const checks = [
    { check: 'GIS officer role', ok: scopeFor(req.auth!.principal, 'case.import_geometry') !== 'all' ? (scopeFor(req.auth!.principal, 'case.import_geometry') as number[]).length > 0 : true, detail: 'Sync jobs run with your own county permissions.' },
    { check: 'Active sync token', ok: active.length > 0, detail: active.length ? `${active.length} active (…${active.map((t) => t.token_hint).join(', …')})` : 'Create a token on this page.' },
    { check: 'Token expiry', ok: soon.length === 0, detail: soon.length ? `${soon.length} token(s) expire within 7 days` : 'No token expires within 7 days.' },
    { check: 'Adapter has contacted the server', ok: active.some((t) => t.last_used_at), detail: active.find((t) => t.last_used_at)?.last_used_at ? `Last contact ${new Date(active.map((t) => t.last_used_at).filter(Boolean).sort().pop()).toISOString()}` : 'No contact yet with an active token.' },
    { check: 'Adapter version', ok: !last?.adapter_version || last.adapter_version === ADAPTER_VERSION, detail: last?.adapter_version ? `Last package from adapter ${last.adapter_version}; current ${ADAPTER_VERSION}` : `Current adapter ${ADAPTER_VERSION}` },
    { check: 'Server upload storage', ok: uploadDirOk, detail: uploadDirOk ? 'Writable' : 'The upload directory is not writable: contact the system administrator.' },
    { check: 'Last sync job', ok: !last || last.status !== 'failed', detail: last ? `${last.job_no}: ${last.status}${last.error_summary ? ` (${last.error_summary})` : ''}` : 'No sync job yet.' },
  ];
  res.json({ checks, acceptedCrs: Object.keys(ACCEPTED_SRIDS).map(Number), endpoint: '/api/gis/arcmap' });
});

/** The ArcMap adapter (Python toolbox and command line), as a zip. Contains no tokens or configuration. */
gisRouter.get('/sync/adapter.zip', async (req, res) => {
  resolveScope(req, 'gis.workspace');
  const dir = path.resolve(process.cwd(), '..', 'integrations', 'arcmap');
  const files: Record<string, Uint8Array> = {};
  try {
    for (const name of await fs.readdir(dir)) {
      if (/^[\w.-]+\.(py|pyt|md|txt|example)$/i.test(name) && !/token/i.test(name)) files[`lais-arcmap/${name}`] = await fs.readFile(path.join(dir, name));
    }
  } catch { throw notFound('The adapter is not installed on this server'); }
  if (!Object.keys(files).length) throw notFound('The adapter is not installed on this server');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="lais-arcmap-adapter-${ADAPTER_VERSION}.zip"`);
  res.send(Buffer.from(zipSync(files)));
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /gis/summary', summaryQuery);
documentQuery('GET /gis/cases', casesQuery);
documentQuery('GET /gis/workspace/layers', layersQuery);
documentQuery('GET /gis/workspace/search', searchQuery);
documentQuery('GET /gis/jobs', jobsQuery);
documentBody('POST /gis/uploads', z.object({ wktColumn: z.string().optional() }));
documentBody('POST /gis/imports/preview', importBody);
documentBody('POST /gis/imports', confirmBody);
documentBody('POST /gis/sync/tokens', tokenBody);
