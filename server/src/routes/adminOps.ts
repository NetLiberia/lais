import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config, NATIONAL_EXTENT } from '../config.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { log } from '../logger.js';
import { ACCEPTED_SRIDS, extractFeatures } from '../services/geojson.js';
import { csvCell } from '../csv.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Operations API for administrators and supervisors: dashboard, activity, health, overviews, GIS job
 * monitoring, counties, settings, document categories, backups and reports. Everything is read from
 * real data; administrators see aggregates and case metadata, never party names, documents or identity data.
 */
export const adminOpsRouter = Router();

const OPEN = ['draft', 'validating', 'under_review', 'returned', 'approved'];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), countyId: z.coerce.number().int().optional() });

/** Resolves a date range (default: the last 30 days, inclusive), limited to 366 days. */
function dateRange(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 29 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('Invalid date range');
  if ((to.getTime() - from.getTime()) / 86_400_000 > 366) throw badRequest('Date range cannot exceed 366 days');
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

adminOpsRouter.get('/dashboard/summary', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'dashboard' });
  const { rows: [s] } = await pool.query(
    `SELECT
       (SELECT count(DISTINCT u.id)::int FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
         WHERE u.status = 'active' AND r.role <> 'landowner') AS active_staff,
       (SELECT count(*)::int FROM lais.app_user WHERE status = 'invited') AS pending_activations,
       (SELECT count(*)::int FROM lais.land_case) AS applications_total,
       (SELECT count(*)::int FROM lais.land_case WHERE status = ANY($1)) AS applications_open,
       (SELECT count(*)::int FROM lais.land_case WHERE status = 'under_review') AS applications_under_review,
       (SELECT count(*)::int FROM lais.parcel WHERE status <> 'retired') AS parcels_published,
       (SELECT count(*)::int FROM staging.feature f JOIN staging.batch b ON b.id = f.batch_id AND b.status = 'active'
          JOIN lais.land_case c ON c.id = b.case_id AND c.status = ANY($1) WHERE NOT f.excluded) AS parcels_in_staging,
       (SELECT count(*)::int FROM lais.spatial_conflict WHERE review_status = 'open') AS conflicts_open,
       (SELECT count(*)::int FROM staging.batch b
          LEFT JOIN LATERAL (SELECT error_count FROM staging.validation_run v WHERE v.batch_id = b.id ORDER BY run_at DESC LIMIT 1) r ON true
         WHERE b.status = 'active' AND (r.error_count IS NULL OR r.error_count > 0)) AS gis_jobs_attention,
       (SELECT count(*)::int FROM lais.county WHERE enabled) AS counties_enabled,
       (SELECT count(*)::int FROM lais.county) AS counties_total`,
    [OPEN],
  );
  res.json(s);
});

adminOpsRouter.get('/dashboard/charts', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'dashboard' });
  const q = rangeQuery.parse(req.query);
  const { from, to } = dateRange(q);
  const county = q.countyId ?? null;
  const [byStatus, overTime, byCounty, jobs, conflicts, activity] = await Promise.all([
    pool.query(
      `SELECT status, count(*)::int AS count FROM lais.land_case
        WHERE created_at >= $1::date AND created_at < $2::date + 1 AND ($3::smallint IS NULL OR county_id = $3)
        GROUP BY status ORDER BY status`,
      [from, to, county],
    ),
    pool.query(
      `SELECT d::date AS day, count(c.id)::int AS count
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN lais.land_case c ON c.created_at >= d AND c.created_at < d + interval '1 day' AND ($3::smallint IS NULL OR c.county_id = $3)
        GROUP BY d ORDER BY d`,
      [from, to, county],
    ),
    pool.query(
      `SELECT co.code, co.name, co.enabled,
              count(p.id) FILTER (WHERE p.status = 'active')::int AS active,
              count(p.id) FILTER (WHERE p.status = 'disputed')::int AS disputed,
              count(p.id) FILTER (WHERE p.status = 'retired')::int AS retired
         FROM lais.county co LEFT JOIN lais.parcel p ON p.county_id = co.id
        GROUP BY co.id ORDER BY co.id`,
    ),
    pool.query(
      `SELECT outcome, count(*)::int AS count FROM (
         SELECT CASE WHEN b.status = 'published' THEN 'published'
                     WHEN b.status = 'superseded' THEN 'superseded'
                     WHEN r.id IS NULL THEN 'awaiting validation'
                     WHEN r.error_count > 0 THEN 'failed validation'
                     ELSE 'passed validation' END AS outcome
           FROM staging.batch b
           JOIN lais.land_case c ON c.id = b.case_id
           LEFT JOIN LATERAL (SELECT id, error_count FROM staging.validation_run v WHERE v.batch_id = b.id ORDER BY run_at DESC LIMIT 1) r ON true
          WHERE b.created_at >= $1::date AND b.created_at < $2::date + 1 AND ($3::smallint IS NULL OR c.county_id = $3)) x
        GROUP BY outcome ORDER BY outcome`,
      [from, to, county],
    ),
    pool.query(
      `SELECT review_status, count(*)::int AS count FROM lais.spatial_conflict
        WHERE detected_at >= $1::date AND detected_at < $2::date + 1 AND ($3::smallint IS NULL OR county_id = $3)
        GROUP BY review_status ORDER BY review_status`,
      [from, to, county],
    ),
    pool.query(
      `SELECT d::date AS day,
              count(e.chain_seq) FILTER (WHERE e.outcome = 'success')::int AS sign_ins,
              count(e.chain_seq) FILTER (WHERE e.outcome = 'failure')::int AS failed_sign_ins
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN audit.event e ON e.action = 'auth.login' AND e.at >= d AND e.at < d + interval '1 day'
        GROUP BY d ORDER BY d`,
      [from, to],
    ),
  ]);
  res.json({
    range: { from, to, countyId: county },
    applicationsByStatus: byStatus.rows,
    applicationsOverTime: overTime.rows,
    parcelsByCounty: byCounty.rows,
    gisJobOutcomes: jobs.rows,
    conflictsByStatus: conflicts.rows,
    staffActivity: activity.rows,
  });
});

/** Events shown on the dashboard. Case events show the case number and status only. */
const ACTIVITY_ACTIONS = [
  'admin.user_create', 'admin.role_grant', 'admin.role_revoke', 'admin.user_status', 'admin.password_reset_initiated',
  'auth.account_activated', 'staging.import', 'case.create', 'case.submit', 'case.approve', 'case.reject', 'case.return',
  'case.publish', 'case.withdraw', 'authz.denied', 'county.update', 'county.boundary_import', 'county.boundary_verify',
  'settings.update', 'document_category.update', 'document_category.create', 'backup.run',
];

const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

adminOpsRouter.get('/dashboard/activity', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'dashboard' });
  const { limit } = activityQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT e.chain_seq, e.at, e.actor_username, e.action, e.outcome, e.entity_type, e.entity_id, e.case_id,
            c.case_no, co.code AS county_code
       FROM audit.event e
       LEFT JOIN lais.land_case c ON c.id = e.case_id
       LEFT JOIN lais.county co ON co.id = e.county_id
      WHERE e.action = ANY($1) OR (e.action = 'auth.login' AND e.outcome = 'failure')
      ORDER BY e.chain_seq DESC LIMIT $2`,
    [ACTIVITY_ACTIONS, limit],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// System health: every status comes from a real check
// ---------------------------------------------------------------------------

type HealthStatus = 'healthy' | 'warning' | 'error' | 'unknown';
interface Check { key: string; label: string; status: HealthStatus; summary: string; detail?: Record<string, unknown> }

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
  const t = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t };
  } catch (err) {
    return { ms: Date.now() - t, error: (err as Error).message };
  }
}

adminOpsRouter.get('/health', async (req, res) => {
  enforce(req, 'system.health', {}, { entityType: 'system' });
  const checks: Check[] = [];

  const db = await timed(() => pool.query('SELECT 1'));
  checks.push(db.error
    ? { key: 'database', label: 'Database', status: 'error', summary: 'The database did not respond' }
    : { key: 'database', label: 'Database', status: db.ms > 1000 ? 'warning' : 'healthy', summary: `Responded in ${db.ms} ms` });

  const gis = await timed(() => pool.query('SELECT postgis_lib_version() AS v'));
  checks.push(gis.error
    ? { key: 'postgis', label: 'PostGIS', status: 'error', summary: 'PostGIS functions are not available' }
    : { key: 'postgis', label: 'PostGIS', status: 'healthy', summary: `PostGIS ${gis.value!.rows[0].v}` });

  checks.push({
    key: 'api', label: 'API', status: 'healthy',
    summary: `Running for ${Math.round(process.uptime() / 60)} min`,
    detail: { node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
  });

  const queue = await timed(() => pool.query(
    `SELECT count(*)::int AS pending, min(b.created_at) AS oldest FROM staging.batch b
      WHERE b.status = 'active' AND NOT EXISTS (SELECT 1 FROM staging.validation_run v WHERE v.batch_id = b.id)`,
  ));
  if (queue.error) {
    checks.push({ key: 'gis_queue', label: 'GIS import queue', status: 'error', summary: 'Could not read the staging queue' });
  } else {
    const { pending, oldest } = queue.value!.rows[0];
    const stale = oldest && Date.now() - new Date(oldest).getTime() > 24 * 3600_000;
    checks.push({
      key: 'gis_queue', label: 'GIS import queue', status: stale ? 'warning' : 'healthy',
      summary: pending === 0 ? 'No imports awaiting validation' : `${pending} import(s) awaiting validation${stale ? ', oldest over 24 hours' : ''}`,
    });
  }

  checks.push({
    key: 'jobs', label: 'Background jobs', status: 'unknown',
    summary: 'No background job runner is configured: imports and validation run during the request',
  });

  const storage = await timed(async () => {
    await fs.mkdir(config.documentStorageDir, { recursive: true });
    const stat = await fs.statfs(config.documentStorageDir);
    const used = await pool.query('SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes FROM lais.document');
    return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize, documentBytes: Number(used.rows[0].bytes) };
  });
  if (storage.error) {
    checks.push({ key: 'storage', label: 'Document storage', status: 'unknown', summary: 'Free space could not be measured' });
  } else {
    const s = storage.value!;
    const pctFree = s.totalBytes ? (s.freeBytes / s.totalBytes) * 100 : 0;
    checks.push({
      key: 'storage', label: 'Document storage', status: pctFree < 5 ? 'error' : pctFree < 15 ? 'warning' : 'healthy',
      summary: `${(s.freeBytes / 1073741824).toFixed(1)} GB free (${pctFree.toFixed(0)}%); documents use ${(s.documentBytes / 1048576).toFixed(1)} MB`,
    });
  }

  const backup = await timed(() => pool.query(
    `SELECT max(finished_at) FILTER (WHERE status = 'succeeded') AS last_ok,
            (SELECT status FROM lais.backup_run ORDER BY started_at DESC LIMIT 1) AS last_status
       FROM lais.backup_run`,
  ));
  if (!backup.error) {
    const { last_ok, last_status } = backup.value!.rows[0];
    const ageDays = last_ok ? (Date.now() - new Date(last_ok).getTime()) / 86_400_000 : null;
    checks.push({
      key: 'backup', label: 'Latest successful backup',
      status: ageDays === null ? 'warning' : ageDays > 7 || last_status === 'failed' ? 'warning' : 'healthy',
      summary: ageDays === null ? 'No successful backup recorded' : `${new Date(last_ok).toLocaleString('en-GB')}${last_status === 'failed' ? '; the most recent attempt failed' : ''}`,
    });
  }

  const security = await timed(() => pool.query(
    `SELECT (SELECT count(*)::int FROM audit.event WHERE action = 'auth.login' AND outcome = 'failure' AND at > now() - interval '24 hours') AS failed_logins,
            (SELECT count(*)::int FROM audit.event WHERE action = 'authz.denied' AND at > now() - interval '24 hours') AS denials,
            (SELECT count(*)::int FROM lais.app_user WHERE locked_until > now()) AS locked`,
  ));
  if (!security.error) {
    const s = security.value!.rows[0];
    checks.push({
      key: 'security', label: 'Security events (24 h)', status: s.failed_logins > 50 || s.locked > 0 ? 'warning' : 'healthy',
      summary: `${s.failed_logins} failed sign-in(s), ${s.denials} access denial(s), ${s.locked} locked account(s)`,
    });
  }

  const chain = await timed(() => pool.query('SELECT * FROM audit.verify_chain()'));
  if (!chain.error) {
    const r = chain.value!.rows[0];
    checks.push(r.first_bad_seq === null
      ? { key: 'audit_chain', label: 'Audit trail integrity', status: 'healthy', summary: `${r.checked} events verified (${chain.ms} ms)` }
      : { key: 'audit_chain', label: 'Audit trail integrity', status: 'error', summary: `Hash chain broken at event #${r.first_bad_seq}` });
  }

  const rank: Record<HealthStatus, number> = { healthy: 0, unknown: 1, warning: 2, error: 3 };
  const overall = checks.reduce<HealthStatus>((worst, c) => (c.key !== 'jobs' && rank[c.status] > rank[worst] ? c.status : worst), 'healthy');
  res.json({ overall, checkedAt: new Date().toISOString(), checks });
});

// ---------------------------------------------------------------------------
// Overviews (aggregates and metadata only)
// ---------------------------------------------------------------------------

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n)).default(25),
});

const applicationsQuery = pageQuery.extend({
  status: z.string().max(20).optional(),
  type: z.string().max(30).optional(),
  countyId: z.coerce.number().int().optional(),
});

adminOpsRouter.get('/overview/applications', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'case' });
  const q = applicationsQuery.parse(req.query);
  const status = q.status === 'open' ? OPEN : q.status ? [q.status] : null;
  const params = [status, q.type ?? null, q.countyId ?? null];
  const [items, byType] = await Promise.all([
    pool.query(
      `SELECT c.case_no, c.case_type, c.status, co.code AS county_code, c.created_at, c.updated_at, count(*) OVER ()::int AS total
         FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id
        WHERE ($1::text[] IS NULL OR c.status = ANY($1)) AND ($2::text IS NULL OR c.case_type = $2) AND ($3::smallint IS NULL OR c.county_id = $3)
        ORDER BY c.updated_at DESC LIMIT $4 OFFSET $5`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    pool.query(
      `SELECT case_type, status, count(*)::int AS count FROM lais.land_case c
        WHERE ($1::text[] IS NULL OR c.status = ANY($1)) AND ($2::text IS NULL OR c.case_type = $2) AND ($3::smallint IS NULL OR c.county_id = $3)
        GROUP BY case_type, status ORDER BY case_type, status`,
      params,
    ),
  ]);
  res.json({ items: items.rows.map(({ total: _t, ...r }) => r), total: items.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize, byTypeAndStatus: byType.rows });
});

adminOpsRouter.get('/overview/parcels', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'parcel' });
  const { rows } = await pool.query(
    `SELECT co.id, co.code, co.name, co.enabled, co.boundary_status,
            count(p.id) FILTER (WHERE p.status = 'active')::int AS active,
            count(p.id) FILTER (WHERE p.status = 'disputed')::int AS disputed,
            count(p.id) FILTER (WHERE p.status = 'retired')::int AS retired,
            count(p.id) FILTER (WHERE p.legacy_ref IS NOT NULL AND p.status <> 'retired')::int AS migrated,
            count(p.id) FILTER (WHERE p.status <> 'retired' AND NOT EXISTS (
              SELECT 1 FROM lais.rrr r WHERE r.parcel_id = p.id AND r.valid_to IS NULL AND r.interest_status = 'registered'))::int AS unverified,
            (SELECT count(*)::int FROM staging.feature f JOIN staging.batch b ON b.id = f.batch_id AND b.status = 'active'
               JOIN lais.land_case c ON c.id = b.case_id AND c.county_id = co.id AND c.status = ANY($1) WHERE NOT f.excluded) AS in_staging
       FROM lais.county co LEFT JOIN lais.parcel p ON p.county_id = co.id
      GROUP BY co.id ORDER BY co.enabled DESC, co.name`,
    [OPEN],
  );
  res.json(rows);
});

const conflictsQuery = pageQuery.extend({
  status: z.enum(['open', 'acknowledged', 'closed']).optional(),
  countyId: z.coerce.number().int().optional(),
  code: z.string().max(40).optional(),
});

adminOpsRouter.get('/overview/conflicts', async (req, res) => {
  enforce(req, 'dashboard.view', {}, { entityType: 'conflict' });
  const q = conflictsQuery.parse(req.query);
  const params = [q.status ?? null, q.countyId ?? null, q.code ?? null];
  const [items, byCode] = await Promise.all([
    pool.query(
      `SELECT sc.id, sc.code, sc.severity, sc.message, sc.case_no, sc.case_type, sc.case_status, sc.review_status, sc.detected_at,
              sc.acknowledged_at, sc.feature_index, co.code AS county_code, count(*) OVER ()::int AS total
         FROM lais.spatial_conflict sc JOIN lais.county co ON co.id = sc.county_id
        WHERE ($1::text IS NULL OR sc.review_status = $1) AND ($2::smallint IS NULL OR sc.county_id = $2) AND ($3::text IS NULL OR sc.code = $3)
        ORDER BY sc.detected_at DESC LIMIT $4 OFFSET $5`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    pool.query(
      `SELECT code, review_status, count(*)::int AS count FROM lais.spatial_conflict sc
        WHERE ($1::text IS NULL OR sc.review_status = $1) AND ($2::smallint IS NULL OR sc.county_id = $2) AND ($3::text IS NULL OR sc.code = $3)
        GROUP BY code, review_status ORDER BY code`,
      params,
    ),
  ]);
  res.json({ items: items.rows.map(({ total: _t, ...r }) => r), total: items.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize, byCode: byCode.rows });
});

// ---------------------------------------------------------------------------
// GIS synchronization monitoring (staging import batches)
// ---------------------------------------------------------------------------

const JOB_STATUS_SQL = `CASE WHEN b.status = 'published' THEN 'published'
                             WHEN b.status = 'superseded' THEN 'superseded'
                             WHEN r.id IS NULL THEN 'awaiting_validation'
                             WHEN r.error_count > 0 THEN 'failed_validation'
                             ELSE 'passed_validation' END`;

const gisJobsQuery = pageQuery.extend({
  status: z.enum(['published', 'superseded', 'awaiting_validation', 'failed_validation', 'passed_validation']).optional(),
  countyId: z.coerce.number().int().optional(),
});

adminOpsRouter.get('/gis-jobs', async (req, res) => {
  enforce(req, 'gis.sync.read', {}, { entityType: 'staging_batch' });
  const q = gisJobsQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT b.id, b.source_filename, b.declared_srid, b.feature_count AS received, b.created_at AS started_at,
              r.run_at AS validated_at, coalesce(r.error_count, 0) AS errors, coalesce(r.warning_count, 0) AS warnings,
              ${JOB_STATUS_SQL} AS status, c.id AS case_id, c.case_no, c.case_type, c.status AS case_status,
              co.code AS county_code, co.name AS county_name, u.username AS uploaded_by,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND f.structural_ok AND NOT f.excluded) AS accepted,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND (NOT f.structural_ok OR f.excluded)) AS rejected,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND f.published_parcel_id IS NOT NULL) AS published_parcels,
              c.county_id
         FROM staging.batch b
         JOIN lais.land_case c ON c.id = b.case_id
         JOIN lais.county co ON co.id = c.county_id
         JOIN lais.app_user u ON u.id = b.uploaded_by
         LEFT JOIN LATERAL (SELECT id, run_at, error_count, warning_count FROM staging.validation_run v WHERE v.batch_id = b.id ORDER BY run_at DESC LIMIT 1) r ON true
     ) j
     WHERE ($1::text IS NULL OR j.status = $1) AND ($2::smallint IS NULL OR j.county_id = $2)
     ORDER BY j.started_at DESC LIMIT $3 OFFSET $4`,
    [q.status ?? null, q.countyId ?? null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const { rows: [count] } = await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT ${JOB_STATUS_SQL} AS status, c.county_id FROM staging.batch b JOIN lais.land_case c ON c.id = b.case_id
       LEFT JOIN LATERAL (SELECT id, error_count FROM staging.validation_run v WHERE v.batch_id = b.id ORDER BY run_at DESC LIMIT 1) r ON true) j
      WHERE ($1::text IS NULL OR j.status = $1) AND ($2::smallint IS NULL OR j.county_id = $2)`,
    [q.status ?? null, q.countyId ?? null],
  );
  res.json({ items: rows.map(({ county_id: _c, ...r }) => r), total: count.n, page: q.page, pageSize: q.pageSize });
});

/** Spatial and geometry findings of a job only: findings about parties or documents are not shown here. */
const SPATIAL_CODES = [
  'GEOMETRY_INVALID', 'AXIS_ORDER_SWAPPED_SUSPECTED', 'OUTSIDE_NATIONAL_EXTENT', 'CROSSES_COUNTY_BOUNDARY', 'OUTSIDE_CASE_COUNTY',
  'AREA_UNUSUALLY_SMALL', 'OVERLAP_PUBLISHED_PARCEL', 'DUPLICATE_GEOMETRY_SUSPECTED', 'CONFLICTING_OPEN_SUBMISSION',
  'NEW_PARCELS_OVERLAP', 'COVERAGE_GAP', 'COVERAGE_EXCEEDS_SOURCE', 'MIGRATION_INTERNAL_OVERLAP', 'SIGNIFICANT_BOUNDARY_CHANGE',
  'NO_GEOMETRY', 'FEATURE_COUNT', 'LEGACY_ATTRIBUTE_INVALID', 'DUPLICATE_LEGACY_REF', 'ALREADY_MIGRATED',
];

adminOpsRouter.get('/gis-jobs/:id', async (req, res) => {
  enforce(req, 'gis.sync.read', {}, { entityType: 'staging_batch' });
  const id = parseId(req.params.id);
  const { rows: [job] } = await pool.query(
    `SELECT b.id, b.source_filename, b.declared_srid, b.file_sha256, b.feature_count AS received, b.created_at AS started_at, b.status AS batch_status,
            c.case_no, c.case_type, c.status AS case_status, co.name AS county_name, u.username AS uploaded_by
       FROM staging.batch b JOIN lais.land_case c ON c.id = b.case_id JOIN lais.county co ON co.id = c.county_id
       JOIN lais.app_user u ON u.id = b.uploaded_by WHERE b.id = $1`,
    [id],
  );
  if (!job) throw notFound('Import job not found');
  const [features, runs, findings] = await Promise.all([
    pool.query(
      `SELECT feature_index, structural_ok, structural_message, excluded, exclusion_reason,
              properties ->> 'legacy_ref' AS legacy_ref, (published_parcel_id IS NOT NULL) AS published
         FROM staging.feature WHERE batch_id = $1 ORDER BY feature_index`,
      [id],
    ),
    pool.query('SELECT run_at, purpose, error_count, warning_count FROM staging.validation_run WHERE batch_id = $1 ORDER BY run_at DESC', [id]),
    pool.query(
      `SELECT f.code, f.severity, f.message, f.feature_index, (f.acknowledged_at IS NOT NULL) AS acknowledged
         FROM staging.finding f
        WHERE f.run_id = (SELECT id FROM staging.validation_run WHERE batch_id = $1 ORDER BY run_at DESC LIMIT 1)
          AND f.code = ANY($2)
        ORDER BY f.severity, f.feature_index NULLS FIRST, f.code`,
      [id, SPATIAL_CODES],
    ),
  ]);
  res.json({ job, features: features.rows, runs: runs.rows, findings: findings.rows });
});

// ---------------------------------------------------------------------------
// Counties
// ---------------------------------------------------------------------------

adminOpsRouter.get('/counties', async (req, res) => {
  enforce(req, 'counties.read', {}, { entityType: 'county' });
  const { rows } = await pool.query(
    `SELECT co.id, co.code, co.name, co.enabled, co.boundary_status, co.boundary_source, co.is_synthetic, co.updated_at,
            co.boundary_verified_at, v.username AS boundary_verified_by,
            CASE WHEN co.geom IS NOT NULL THEN round((ST_Area(co.geom::geography) / 1e6)::numeric, 1) END AS area_km2,
            (SELECT count(DISTINCT r.user_id)::int FROM lais.role_assignment r JOIN lais.app_user u ON u.id = r.user_id
              WHERE r.county_id = co.id AND r.revoked_at IS NULL AND u.status = 'active') AS staff,
            (SELECT count(*)::int FROM lais.parcel p WHERE p.county_id = co.id AND p.status <> 'retired') AS parcels,
            (SELECT count(*)::int FROM lais.land_case c WHERE c.county_id = co.id AND c.status = ANY($1)) AS open_cases
       FROM lais.county co LEFT JOIN lais.app_user v ON v.id = co.boundary_verified_by
      ORDER BY co.enabled DESC, co.name`,
    [OPEN],
  );
  res.json(rows);
});

adminOpsRouter.get('/counties/:id/boundary', async (req, res) => {
  enforce(req, 'counties.read', {}, { entityType: 'county' });
  const id = z.coerce.number().int().parse(req.params.id);
  const { rows: [c] } = await pool.query('SELECT ST_AsGeoJSON(geom, 6)::json AS geometry FROM lais.county WHERE id = $1', [id]);
  if (!c) throw notFound('County not found');
  res.json({ type: 'Feature', geometry: c.geometry, properties: {} });
});

const countyBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  enabled: z.boolean().optional(),
  boundarySource: z.string().trim().min(3).max(300).optional(),
  reason: z.string().trim().min(5).max(500),
});

adminOpsRouter.patch('/counties/:id', async (req, res) => {
  enforce(req, 'counties.manage', {}, { entityType: 'county' });
  const id = z.coerce.number().int().parse(req.params.id);
  const body = countyBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [c] } = await client.query('SELECT * FROM lais.county WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('County not found');
    if (body.enabled && !c.geom) throw conflict('Import a boundary before enabling the county: parcels are validated against it');
    if (body.boundarySource && c.boundary_status === 'verified') throw conflict('The source of a verified boundary cannot be changed; import a new boundary instead');
    await client.query(
      `UPDATE lais.county SET name = coalesce($2, name), enabled = coalesce($3, enabled), boundary_source = coalesce($4, boundary_source), updated_at = now()
        WHERE id = $1`,
      [id, body.name ?? null, body.enabled ?? null, body.boundarySource ?? null],
    );
    await writeAudit(req, { action: 'county.update', outcome: 'success', entityType: 'county', entityId: String(id), countyId: id, detail: { changes: { name: body.name, enabled: body.enabled, boundarySource: body.boundarySource }, reason: body.reason } }, client);
  });
  res.json({ ok: true });
});

const boundaryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const boundaryFields = z.object({
  crs: z.coerce.number().int(),
  source: z.string().trim().min(3).max(300),
  reason: z.string().trim().min(5).max(500),
  acknowledgeParcelsOutside: z.enum(['true', 'false']).optional(),
});

/** Imports a county boundary as "provisional". It never becomes "verified" without a separate verification step. */
adminOpsRouter.post('/counties/:id/boundary', boundaryUpload.single('file'), async (req, res) => {
  enforce(req, 'counties.manage', {}, { entityType: 'county' });
  const id = z.coerce.number().int().parse(req.params.id);
  if (!req.file) throw badRequest('Attach a GeoJSON file with the boundary');
  const fields = boundaryFields.parse(req.body ?? {});
  if (!ACCEPTED_SRIDS[fields.crs]) throw badRequest('Declare the coordinate reference system (EPSG:4326 or EPSG:32629)');
  const [feature] = extractFeatures(req.file.buffer.toString('utf8'), fields.crs, { min: 1, max: 1, label: 'A county boundary file takes exactly one feature' });

  const result = await tx(async (client) => {
    const { rows: [c] } = await client.query('SELECT id, name FROM lais.county WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('County not found');
    let g;
    try {
      ({ rows: [g] } = await client.query(
        `WITH i AS (SELECT ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1), $2)) AS gi)
         SELECT GeometryType(gi) AS gtype, ST_IsValid(gi) AS valid, ST_IsValidReason(gi) AS reason,
                CASE WHEN ST_IsValid(gi) THEN ST_Multi(ST_Transform(gi, 4326)) END AS g4326 FROM i`,
        [JSON.stringify(feature.geometry), fields.crs],
      ));
    } catch {
      throw badRequest('The boundary could not be read as GeoJSON');
    }
    if (!['POLYGON', 'MULTIPOLYGON'].includes(g.gtype)) throw badRequest(`A boundary must be a Polygon or MultiPolygon, not ${g.gtype}`);
    if (!g.valid) throw badRequest(`The boundary geometry is invalid: ${g.reason}. It is not repaired automatically.`);
    const { rows: [check] } = await client.query(
      `SELECT ST_Within($1::geometry, ST_MakeEnvelope($2, $3, $4, $5, 4326)) AS inside, round((ST_Area($1::geometry::geography) / 1e6)::numeric, 1) AS km2,
              (SELECT count(*)::int FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
                WHERE p.county_id = $6 AND p.status <> 'retired' AND NOT ST_CoveredBy(v.geom, $1::geometry)) AS parcels_outside`,
      [g.g4326, NATIONAL_EXTENT.minLon, NATIONAL_EXTENT.minLat, NATIONAL_EXTENT.maxLon, NATIONAL_EXTENT.maxLat, id],
    );
    if (!check.inside) throw badRequest('The boundary falls outside Liberia; check the declared coordinate reference system');
    if (check.parcels_outside > 0 && fields.acknowledgeParcelsOutside !== 'true') {
      throw conflict(`${check.parcels_outside} published parcel(s) of ${c.name} would fall outside this boundary`, { parcelsOutside: check.parcels_outside });
    }
    await client.query(
      `UPDATE lais.county SET geom = $2::geometry, boundary_status = 'provisional', boundary_source = $3, is_synthetic = false,
              boundary_verified_by = NULL, boundary_verified_at = NULL, updated_at = now() WHERE id = $1`,
      [id, g.g4326, fields.source],
    );
    await writeAudit(req, {
      action: 'county.boundary_import', outcome: 'success', entityType: 'county', entityId: String(id), countyId: id,
      detail: { source: fields.source, reason: fields.reason, areaKm2: Number(check.km2), parcelsOutside: check.parcels_outside, file: req.file!.originalname },
    }, client);
    return { areaKm2: Number(check.km2), parcelsOutside: check.parcels_outside, boundaryStatus: 'provisional' };
  });
  res.json(result);
});

const verifyBody = z.object({ source: z.string().trim().min(3).max(300), reason: z.string().trim().min(5).max(500) });

adminOpsRouter.post('/counties/:id/verify-boundary', async (req, res) => {
  enforce(req, 'counties.manage', {}, { entityType: 'county' });
  const id = z.coerce.number().int().parse(req.params.id);
  const body = verifyBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [c] } = await client.query('SELECT boundary_status FROM lais.county WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('County not found');
    if (c.boundary_status === 'synthetic') throw conflict('A synthetic boundary can never be marked verified; import an authoritative boundary first');
    if (c.boundary_status !== 'provisional') throw conflict(`Only a provisional boundary can be verified (this one is ${c.boundary_status})`);
    await client.query(
      `UPDATE lais.county SET boundary_status = 'verified', boundary_source = $2, boundary_verified_by = $3, boundary_verified_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, body.source, req.auth!.user.id],
    );
    await writeAudit(req, { action: 'county.boundary_verify', outcome: 'success', entityType: 'county', entityId: String(id), countyId: id, detail: body }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// System settings (allow-listed keys, typed values)
// ---------------------------------------------------------------------------

const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'portal.banner_message': z.string().max(300),
  'support.contact': z.string().min(3).max(300),
  'notifications.in_app_enabled': z.boolean(),
};

adminOpsRouter.get('/settings', async (req, res) => {
  enforce(req, 'system.configure', {}, { entityType: 'setting' });
  const { rows } = await pool.query(
    `SELECT s.key, s.value, s.description, s.updated_at, u.username AS updated_by
       FROM lais.system_setting s LEFT JOIN lais.app_user u ON u.id = s.updated_by ORDER BY s.key`,
  );
  res.json(rows);
});

const settingBody = z.object({ value: z.unknown(), reason: z.string().trim().min(5).max(500) });

adminOpsRouter.put('/settings/:key', async (req, res) => {
  enforce(req, 'system.configure', {}, { entityType: 'setting' });
  const key = req.params.key;
  const schema = SETTING_SCHEMAS[key];
  if (!schema) throw notFound('Unknown setting');
  const body = settingBody.parse(req.body);
  const value = schema.parse(body.value);
  await tx(async (client) => {
    const { rows: [old] } = await client.query('SELECT value FROM lais.system_setting WHERE key = $1 FOR UPDATE', [key]);
    await client.query('UPDATE lais.system_setting SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(value), req.auth!.user.id]);
    await writeAudit(req, { action: 'settings.update', outcome: 'success', entityType: 'setting', entityId: key, detail: { from: old?.value, to: value, reason: body.reason } }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Document categories
// ---------------------------------------------------------------------------

adminOpsRouter.get('/document-categories', async (req, res) => {
  enforce(req, 'system.configure', {}, { entityType: 'document_category' });
  const { rows } = await pool.query(
    `SELECT dc.code, dc.label, dc.description, dc.active, dc.system, dc.updated_at, u.username AS updated_by,
            (SELECT count(*)::int FROM lais.document d WHERE d.doc_type = dc.code) AS documents
       FROM lais.document_category dc LEFT JOIN lais.app_user u ON u.id = dc.updated_by ORDER BY dc.system DESC, dc.label`,
  );
  res.json(rows);
});

const categoryCreate = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{2,40}$/, 'Code: 3-41 lowercase letters, digits or underscores, starting with a letter'),
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(5).max(500),
});

adminOpsRouter.post('/document-categories', async (req, res) => {
  enforce(req, 'system.configure', {}, { entityType: 'document_category' });
  const body = categoryCreate.parse(req.body);
  await tx(async (client) => {
    const exists = await client.query('SELECT 1 FROM lais.document_category WHERE code = $1', [body.code]);
    if (exists.rows[0]) throw conflict('A category with that code already exists');
    await client.query(
      'INSERT INTO lais.document_category (code, label, description, updated_by) VALUES ($1, $2, $3, $4)',
      [body.code, body.label, body.description || null, req.auth!.user.id],
    );
    await writeAudit(req, { action: 'document_category.create', outcome: 'success', entityType: 'document_category', entityId: body.code, detail: { label: body.label, reason: body.reason } }, client);
  });
  res.status(201).json({ ok: true });
});

const categoryUpdate = z.object({
  label: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(5).max(500),
});

adminOpsRouter.patch('/document-categories/:code', async (req, res) => {
  enforce(req, 'system.configure', {}, { entityType: 'document_category' });
  const body = categoryUpdate.parse(req.body);
  await tx(async (client) => {
    const { rows: [c] } = await client.query('SELECT * FROM lais.document_category WHERE code = $1 FOR UPDATE', [req.params.code]);
    if (!c) throw notFound('Category not found');
    if (c.system && body.active === false) throw conflict('System categories are used by validation rules and cannot be deactivated');
    await client.query(
      `UPDATE lais.document_category SET label = coalesce($2, label), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              active = coalesce($5, active), updated_by = $6, updated_at = now() WHERE code = $1`,
      [c.code, body.label ?? null, body.description !== undefined, body.description ?? null, body.active ?? null, req.auth!.user.id],
    );
    await writeAudit(req, { action: 'document_category.update', outcome: 'success', entityType: 'document_category', entityId: c.code, detail: { label: body.label, active: body.active, reason: body.reason } }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Backups (pg_dump custom format). Restoring is a documented manual procedure, never a web action.
// ---------------------------------------------------------------------------

adminOpsRouter.get('/backups', async (req, res) => {
  enforce(req, 'system.health', {}, { entityType: 'backup' });
  const { rows } = await pool.query(
    `SELECT b.id, b.started_at, b.finished_at, b.status, b.method, b.file_name, b.size_bytes, b.sha256, b.error, u.username AS initiated_by
       FROM lais.backup_run b LEFT JOIN lais.app_user u ON u.id = b.initiated_by ORDER BY b.started_at DESC LIMIT 50`,
  );
  res.json({ items: rows, configured: { pgDump: config.pgDumpPath, backupDir: config.backupDir } });
});

function runPgDump(file: string): Promise<void> {
  const url = new URL(config.databaseUrl);
  return new Promise((resolve, reject) => {
    // No shell; the password travels in the child's environment, not on its command line.
    const child = spawn(config.pgDumpPath, [
      '--format=custom', '--no-owner', `--file=${file}`,
      `--host=${url.hostname}`, `--port=${url.port || '5432'}`, `--username=${decodeURIComponent(url.username)}`,
      `--dbname=${decodeURIComponent(url.pathname.slice(1))}`,
    ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 2000); });
    child.on('error', (err) => reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `pg_dump was not found (${config.pgDumpPath}); set PG_DUMP_PATH in server/.env`
      : err.message)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`))));
  });
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

const backupBody = z.object({ reason: z.string().trim().min(5).max(500) });

adminOpsRouter.post('/backups', async (req, res) => {
  enforce(req, 'backups.run', {}, { entityType: 'backup' });
  const { reason } = backupBody.parse(req.body);
  const running = await pool.query(`SELECT 1 FROM lais.backup_run WHERE status = 'running' AND started_at > now() - interval '1 hour'`);
  if (running.rows[0]) throw conflict('A backup is already running');
  await fs.mkdir(config.backupDir, { recursive: true });
  const fileName = `lais-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
  const file = path.join(config.backupDir, fileName);
  const { rows: [run] } = await pool.query(
    `INSERT INTO lais.backup_run (status, initiated_by, method, file_name) VALUES ('running', $1, 'pg_dump --format=custom', $2) RETURNING id`,
    [req.auth!.user.id, fileName],
  );
  try {
    await runPgDump(file);
    const [stat, sha256] = await Promise.all([fs.stat(file), sha256File(file)]);
    await pool.query(
      `UPDATE lais.backup_run SET status = 'succeeded', finished_at = now(), size_bytes = $2, sha256 = $3 WHERE id = $1`,
      [run.id, stat.size, sha256],
    );
    await writeAudit(req, { action: 'backup.run', outcome: 'success', entityType: 'backup', entityId: run.id, detail: { fileName, sizeBytes: stat.size, sha256, reason } });
    res.status(201).json({ id: run.id, status: 'succeeded', fileName, sizeBytes: stat.size, sha256 });
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await pool.query(`UPDATE lais.backup_run SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, message]);
    await writeAudit(req, { action: 'backup.run', outcome: 'failure', entityType: 'backup', entityId: run.id, detail: { reason, error: message } });
    log('error', 'backup failed', { requestId: req.requestId, error: message });
    throw new HttpError(502, `The backup failed: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// Reports (CSV; no personal contact or identity data)
// ---------------------------------------------------------------------------

const REPORTS: Record<string, { title: string; sql: string }> = {
  staff: {
    title: 'Staff accounts',
    sql: `SELECT u.staff_id, u.username, u.display_name, u.department, u.status, u.last_login_at, u.created_at,
                 string_agg(r.role || coalesce(' (' || c.code || ')', ''), '; ' ORDER BY r.role) AS roles
            FROM lais.app_user u
            LEFT JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
            LEFT JOIN lais.county c ON c.id = r.county_id
           -- Staff only: landowner portal accounts belong to members of the public.
           WHERE NOT EXISTS (SELECT 1 FROM lais.role_assignment x WHERE x.user_id = u.id AND x.role = 'landowner' AND x.revoked_at IS NULL)
           GROUP BY u.id ORDER BY u.username`,
  },
  applications: {
    title: 'Land applications (metadata only)',
    sql: `SELECT c.case_no, c.case_type, c.status, co.code AS county, c.created_at, c.updated_at
            FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id ORDER BY c.created_at`,
  },
  'gis-jobs': {
    title: 'GIS import jobs',
    sql: `SELECT b.created_at AS started_at, c.case_no, co.code AS county, b.source_filename, b.declared_srid, b.feature_count AS received,
                 b.status AS batch_status, r.error_count, r.warning_count, r.run_at AS validated_at
            FROM staging.batch b JOIN lais.land_case c ON c.id = b.case_id JOIN lais.county co ON co.id = c.county_id
            LEFT JOIN LATERAL (SELECT error_count, warning_count, run_at FROM staging.validation_run v WHERE v.batch_id = b.id ORDER BY run_at DESC LIMIT 1) r ON true
           ORDER BY b.created_at`,
  },
  counties: {
    title: 'County configuration',
    sql: `SELECT co.code, co.name, co.enabled, co.boundary_status, co.boundary_source, co.boundary_verified_at,
                 (SELECT count(*) FROM lais.parcel p WHERE p.county_id = co.id AND p.status <> 'retired') AS parcels
            FROM lais.county co ORDER BY co.name`,
  },
};

adminOpsRouter.get('/reports', (req, res) => {
  enforce(req, 'reports.export', {}, { entityType: 'report' });
  res.json(Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title })));
});

adminOpsRouter.get('/reports/:name.csv', async (req, res) => {
  enforce(req, 'reports.export', {}, { entityType: 'report' });
  const report = REPORTS[req.params.name];
  if (!report) throw notFound('Unknown report');
  const { rows, fields } = await pool.query(report.sql);
  const lines = [fields.map((f) => csvCell(f.name)).join(','), ...rows.map((r) => fields.map((f) => csvCell(r[f.name])).join(','))];
  await writeAudit(req, { action: 'report.export', outcome: 'success', entityType: 'report', entityId: req.params.name, detail: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lais-${req.params.name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /admin/dashboard/charts', rangeQuery);
documentQuery('GET /admin/dashboard/activity', activityQuery);
documentQuery('GET /admin/overview/applications', applicationsQuery);
documentQuery('GET /admin/overview/conflicts', conflictsQuery);
documentQuery('GET /admin/gis-jobs', gisJobsQuery);
documentBody('PATCH /admin/counties/{id}', countyBody);
documentBody('POST /admin/counties/{id}/boundary', boundaryFields);
documentBody('POST /admin/counties/{id}/verify-boundary', verifyBody);
documentBody('PUT /admin/settings/{key}', settingBody);
documentBody('POST /admin/document-categories', categoryCreate);
documentBody('PATCH /admin/document-categories/{code}', categoryUpdate);
documentBody('POST /admin/backups', backupBody);
