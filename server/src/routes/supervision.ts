import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { CASE_STATUSES, OPEN_STATUSES, SPATIAL_CASE_TYPES } from '../authz/workflow.js';
import { caseContext, getCase, recordEvent, setStatus } from '../services/cases.js';
import { latestRun } from '../services/validation.js';
import { notifyRoles, notifyUsers } from '../services/notify.js';
import { CONFLICTS_SQL, OPEN_CONFLICT_STATUSES } from '../services/conflicts.js';
import {
  ACCEPTED_SQL, CASE_JOINS, STAGE_SINCE_SQL, STAGES, TASK_TYPE_KEYS, TASK_TYPES, assertEligibleAssignee, dateRange, eligibleStaff,
  resolveScope, responsibleOfficer, reviewMode, stageSql, stageTargets,
} from '../services/supervision.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Supervisor oversight: dashboards, the application work queue and quality review of submitted cases.
 * Every query is limited to the counties of the caller's supervisor grants; a county asked for by the
 * client is verified, never trusted. Quality acceptance is not a legal decision and moves no parcel.
 */
export const supervisionRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countyParam = z.coerce.number().int().positive().optional();

// ---------------------------------------------------------------------------
// Scope and reference data
// ---------------------------------------------------------------------------

supervisionRouter.get('/scope', async (req, res) => {
  const counties = resolveScope(req, 'supervision.view');
  const [{ rows: countyRows }, { rows: categories }, mode, targets] = await Promise.all([
    pool.query(
      `SELECT id, code, name, enabled, boundary_status FROM lais.county
        WHERE ($1::smallint[] IS NULL OR id = ANY($1)) AND ($1::smallint[] IS NOT NULL OR enabled) ORDER BY name`,
      [counties],
    ),
    pool.query('SELECT code, label, applies_to FROM lais.review_issue_category WHERE active ORDER BY label'),
    reviewMode(pool),
    stageTargets(pool),
  ]);
  res.json({
    national: counties === null,
    counties: countyRows,
    reviewMode: mode,
    stageTargets: targets,
    issueCategories: categories,
    taskTypes: Object.entries(TASK_TYPES).map(([key, t]) => ({ key, label: t.label, roles: t.roles })),
    stages: STAGES.map(({ key, label, statuses }) => ({ key, label, statuses })),
  });
});

const staffQuery = z.object({ countyId: z.coerce.number().int().positive(), taskType: z.enum(TASK_TYPE_KEYS).optional() });

/** Staff a task of the given type may be assigned to in the county (active, eligible role and county). */
supervisionRouter.get('/staff', async (req, res) => {
  const q = staffQuery.parse(req.query);
  enforce(req, 'task.manage', { countyId: q.countyId }, { entityType: 'county', entityId: String(q.countyId) });
  res.json(await eligibleStaff(pool, q.countyId, q.taskType));
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const rangeQuery = z.object({ countyId: countyParam, from: isoDate.optional(), to: isoDate.optional() });

supervisionRouter.get('/dashboard/summary', async (req, res) => {
  const q = rangeQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { from, to } = dateRange(q);
  const params = [counties, from, to, SPATIAL_CASE_TYPES, OPEN_STATUSES];
  const [{ rows: [s] }, { rows: [conflicts] }] = await Promise.all([
    pool.query(
      `WITH scoped AS (
         SELECT c.*, ${ACCEPTED_SQL} AS accepted FROM lais.land_case c ${CASE_JOINS}
          WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
       ), decided AS (
         -- Submission to legal decision, for cases decided in the period.
         SELECT extract(epoch FROM d.decided_at - sub.at) / 86400 AS days
           FROM lais.case_decision d JOIN scoped c ON c.id = d.case_id
           JOIN LATERAL (SELECT min(e.at) AS at FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = 'validating') sub ON true
          WHERE d.superseded_at IS NULL AND d.decision IN ('approved', 'rejected')
            AND d.decided_at >= $2::date AND d.decided_at < $3::date + 1 AND sub.at IS NOT NULL
       ), submissions AS (
         SELECT r.error_count FROM staging.validation_run r JOIN scoped c ON c.id = r.case_id
          WHERE r.purpose = 'submission' AND r.run_at >= $2::date AND r.run_at < $3::date + 1
       )
       SELECT (SELECT count(*)::int FROM scoped) AS applications_total,
              (SELECT count(*)::int FROM scoped WHERE status = ANY($5)) AS applications_open,
              (SELECT count(*)::int FROM scoped WHERE status = 'draft') AS awaiting_processing,
              (SELECT count(*)::int FROM scoped WHERE status = 'under_review' AND case_type = ANY($4) AND NOT coalesce(accepted, false)) AS awaiting_quality_review,
              (SELECT count(*)::int FROM scoped WHERE status = 'returned') AS returned_for_correction,
              (SELECT count(*)::int FROM scoped WHERE status = 'under_review' AND (NOT (case_type = ANY($4)) OR coalesce(accepted, false))) AS awaiting_registrar_accepted,
              (SELECT count(*)::int FROM scoped WHERE status = 'under_review') AS under_review,
              (SELECT count(*)::int FROM lais.task t WHERE ($1::smallint[] IS NULL OR t.county_id = ANY($1))
                  AND t.status NOT IN ('completed', 'cancelled') AND t.due_date < current_date) AS overdue_tasks,
              (SELECT count(*)::int FROM lais.task t WHERE ($1::smallint[] IS NULL OR t.county_id = ANY($1))
                  AND t.status = 'completed' AND t.completed_at >= $2::date AND t.completed_at < $3::date + 1) AS tasks_completed,
              (SELECT round(avg(days)::numeric, 1) FROM decided) AS avg_processing_days,
              (SELECT count(*)::int FROM decided) AS decided_count,
              (SELECT count(*)::int FROM submissions) AS submissions_validated,
              (SELECT count(*)::int FROM submissions WHERE error_count = 0) AS submissions_passed`,
      params,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE review_status = ANY($2))::int AS unresolved FROM (${CONFLICTS_SQL}) x`,
      [counties, OPEN_CONFLICT_STATUSES],
    ),
  ]);
  const mode = await reviewMode(pool);
  res.json({
    range: { from, to, countyId: q.countyId ?? null },
    reviewMode: mode,
    ...s,
    // In "required" mode only accepted cases can be decided; in "optional" mode the registrar may decide any submitted case.
    awaiting_registrar: mode === 'required' ? s.awaiting_registrar_accepted : s.under_review,
    unresolved_conflicts: conflicts.unresolved,
    // Only a rate when something was measured: never 0% or 100% from nothing.
    quality_pass_rate: s.submissions_validated > 0 ? Math.round((1000 * s.submissions_passed) / s.submissions_validated) / 10 : null,
    refreshedAt: new Date().toISOString(),
  });
});

const chartsQuery = rangeQuery.extend({ staffId: z.string().uuid().optional(), taskType: z.enum(TASK_TYPE_KEYS).optional() });

supervisionRouter.get('/dashboard/charts', async (req, res) => {
  const q = chartsQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { from, to } = dateRange(q);
  const [stages, work, quality, durations, workload, conflicts] = await Promise.all([
    pool.query(
      `SELECT ${stageSql()} AS stage, count(*)::int AS count FROM lais.land_case c ${CASE_JOINS}
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) GROUP BY 1`,
      [counties],
    ),
    // Work completed per day: tasks completed, and case stage completions performed by staff.
    pool.query(
      `SELECT d::date AS day,
              (SELECT count(*)::int FROM lais.task t WHERE ($1::smallint[] IS NULL OR t.county_id = ANY($1)) AND t.status = 'completed'
                  AND t.completed_at >= d AND t.completed_at < d + interval '1 day'
                  AND ($4::uuid IS NULL OR t.assignee_id = $4) AND ($5::text IS NULL OR t.task_type = $5)) AS tasks_completed,
              (SELECT count(*)::int FROM lais.case_event e JOIN lais.land_case c ON c.id = e.case_id
                WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND e.to_status IS NOT NULL AND e.actor_id IS NOT NULL
                  AND e.at >= d AND e.at < d + interval '1 day' AND ($4::uuid IS NULL OR e.actor_id = $4) AND $5::text IS NULL) AS stage_completions
         FROM generate_series($2::date, $3::date, interval '1 day') d ORDER BY d`,
      [counties, from, to, q.staffId ?? null, q.taskType ?? null],
    ),
    gisQuality(counties),
    stageDurations(counties, from, to),
    staffWorkload(counties, from, to),
    pool.query(`SELECT review_status, count(*)::int AS count FROM (${CONFLICTS_SQL}) x GROUP BY 1`, [counties]),
  ]);
  res.json({
    range: { from, to, countyId: q.countyId ?? null },
    stages: STAGES.map((s) => ({ key: s.key, label: s.label, count: stages.rows.find((r) => r.stage === s.key)?.count ?? 0 })),
    workCompleted: work.rows,
    gisQuality: quality,
    stageDurations: durations,
    staffWorkload: workload,
    conflictStatus: conflicts.rows,
  });
});

/** Feature-level quality of the current submission of every open spatial case in scope. */
export async function gisQuality(counties: number[] | null) {
  const { rows: [g] } = await pool.query(
    `WITH current AS (
       SELECT b.id AS batch_id, c.id AS case_id, c.county_id, lr.id AS run_id FROM staging.batch b
         JOIN lais.land_case c ON c.id = b.case_id ${CASE_JOINS}
        WHERE b.status = 'active' AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND lr.id IS NOT NULL
     ), feats AS (
       SELECT f.feature_index, f.structural_ok, cur.run_id,
              EXISTS (SELECT 1 FROM staging.finding x WHERE x.run_id = cur.run_id AND x.severity = 'error' AND x.feature_index = f.feature_index) AS has_error,
              EXISTS (SELECT 1 FROM staging.finding x WHERE x.run_id = cur.run_id AND x.severity = 'warning' AND x.feature_index = f.feature_index) AS has_warning
         FROM current cur JOIN staging.feature f ON f.batch_id = cur.batch_id AND NOT f.excluded
     ), findings AS (
       SELECT x.code FROM current cur JOIN staging.finding x ON x.run_id = cur.run_id
     )
     SELECT (SELECT count(*)::int FROM feats WHERE structural_ok AND NOT has_error AND NOT has_warning) AS valid,
            (SELECT count(*)::int FROM feats WHERE NOT structural_ok OR has_error) AS invalid,
            (SELECT count(*)::int FROM feats WHERE structural_ok AND NOT has_error AND has_warning) AS warnings,
            (SELECT count(*)::int FROM findings WHERE code IN ('DUPLICATE_UPI', 'UPI_IN_OTHER_OPEN_CASE', 'DUPLICATE_LEGACY_REF')) AS duplicate_identifiers,
            (SELECT count(*)::int FROM findings WHERE code IN ('GEOMETRY_INVALID', 'NO_GEOMETRY')) AS invalid_geometries,
            (SELECT count(*)::int FROM findings WHERE code IN ('OVERLAP_PUBLISHED_PARCEL', 'NEW_PARCELS_OVERLAP', 'MIGRATION_INTERNAL_OVERLAP', 'CONFLICTING_OPEN_SUBMISSION')) AS potential_overlaps,
            (SELECT count(*)::int FROM findings WHERE code IN ('OUTSIDE_CASE_COUNTY', 'CROSSES_COUNTY_BOUNDARY')) AS out_of_boundary,
            (SELECT count(*)::int FROM feats) AS features`,
    [counties],
  );
  const { rows: boundaries } = await pool.query(
    `SELECT boundary_status, count(*)::int AS n FROM lais.county WHERE ($1::smallint[] IS NULL OR id = ANY($1)) AND enabled GROUP BY 1`,
    [counties],
  );
  // Boundary checks are only authoritative against verified boundaries; synthetic or provisional ones are indicative.
  return { ...g, boundariesVerified: boundaries.length > 0 && boundaries.every((b) => b.boundary_status === 'verified') };
}

/**
 * Time spent in each status, from consecutive status changes in the case history. Only completed stays
 * count (the case has left the status), ending within the period. Hours, so short demo stays still show.
 */
export async function stageDurations(counties: number[] | null, from: string, to: string) {
  const { rows } = await pool.query(
    `WITH changes AS (
       SELECT e.case_id, e.to_status AS status, e.at AS entered,
              lead(e.at) OVER (PARTITION BY e.case_id ORDER BY e.id) AS left_at
         FROM lais.case_event e JOIN lais.land_case c ON c.id = e.case_id
        WHERE e.to_status IS NOT NULL AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
     ), firsts AS (
       -- The draft stage starts when the case is opened.
       SELECT c.id AS case_id, 'draft' AS status, c.created_at AS entered,
              (SELECT min(e.at) FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status IS NOT NULL) AS left_at
         FROM lais.land_case c WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
     ), stays AS (SELECT * FROM changes UNION ALL SELECT * FROM firsts)
     SELECT status, count(*)::int AS n,
            round((avg(extract(epoch FROM left_at - entered)) / 3600)::numeric, 2) AS avg_hours,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM left_at - entered)) / 3600)::numeric, 2) AS median_hours
       FROM stays WHERE left_at IS NOT NULL AND left_at >= $2::date AND left_at < $3::date + 1
      GROUP BY status`,
    [counties, from, to],
  );
  return CASE_STATUSES.filter((s) => !['published', 'rejected', 'withdrawn'].includes(s)).map((status) => {
    const r = rows.find((x) => x.status === status);
    return { status, n: r?.n ?? 0, avgHours: r ? Number(r.avg_hours) : null, medianHours: r ? Number(r.median_hours) : null };
  });
}

/** Tasks per eligible officer (GIS officers and processors in scope). Raw counts: not a performance measure. */
export async function staffWorkload(counties: number[] | null, from: string, to: string, filters: { role?: string; staffId?: string; taskType?: string } = {}) {
  const { rows } = await pool.query(
    `WITH staff AS (
       SELECT DISTINCT u.id, u.username, u.display_name, string_agg(DISTINCT r.role, ',') AS roles
         FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
        WHERE u.status = 'active' AND r.role IN ('gis_officer', 'processor') AND ($4::text IS NULL OR r.role = $4)
          AND ($1::smallint[] IS NULL OR r.county_id = ANY($1)) AND ($5::uuid IS NULL OR u.id = $5)
        GROUP BY u.id
     )
     SELECT s.id, s.username, s.display_name, s.roles,
            count(t.id) FILTER (WHERE t.status = 'assigned')::int AS assigned,
            count(t.id) FILTER (WHERE t.status IN ('in_progress', 'blocked', 'returned'))::int AS active,
            count(t.id) FILTER (WHERE t.status = 'blocked')::int AS blocked,
            count(t.id) FILTER (WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_date < current_date)::int AS overdue,
            count(t.id) FILTER (WHERE t.status = 'returned')::int AS returned,
            count(t.id) FILTER (WHERE t.task_type = 'additional_information' AND t.status NOT IN ('completed', 'cancelled'))::int AS awaiting_response,
            count(t.id) FILTER (WHERE t.status = 'completed' AND t.completed_at >= $2::date AND t.completed_at < $3::date + 1)::int AS completed,
            round((avg(extract(epoch FROM t.completed_at - t.created_at)) FILTER (WHERE t.status = 'completed'
                    AND t.completed_at >= $2::date AND t.completed_at < $3::date + 1) / 3600)::numeric, 1) AS avg_completion_hours,
            (SELECT count(*)::int FROM lais.supervisory_review sr JOIN lais.task rt ON rt.id = sr.task_id
              WHERE sr.decision = 'returned' AND rt.assignee_id = s.id AND sr.created_at >= $2::date AND sr.created_at < $3::date + 1) AS submissions_returned,
            coalesce(jsonb_object_agg(t.task_type, 1) FILTER (WHERE t.id IS NOT NULL), '{}') AS _types
       FROM staff s
       LEFT JOIN lais.task t ON t.assignee_id = s.id AND ($1::smallint[] IS NULL OR t.county_id = ANY($1)) AND ($6::text IS NULL OR t.task_type = $6)
      GROUP BY s.id, s.username, s.display_name, s.roles
      ORDER BY s.username`,
    [counties, from, to, filters.role ?? null, filters.staffId ?? null, filters.taskType ?? null],
  );
  const { rows: byType } = await pool.query(
    `SELECT t.assignee_id, t.task_type, count(*)::int AS n FROM lais.task t
      WHERE t.assignee_id IS NOT NULL AND t.status NOT IN ('completed', 'cancelled') AND ($1::smallint[] IS NULL OR t.county_id = ANY($1))
      GROUP BY 1, 2`,
    [counties],
  );
  return rows.map(({ _types: _ignored, ...r }) => ({
    ...r,
    avg_completion_hours: r.avg_completion_hours === null ? null : Number(r.avg_completion_hours),
    openByType: Object.fromEntries(byType.filter((b) => b.assignee_id === r.id).map((b) => [b.task_type, b.n])),
  }));
}

// ---------------------------------------------------------------------------
// Application work queue
// ---------------------------------------------------------------------------

const SORTS: Record<string, string> = {
  case_no: 'case_no', created: 'created_at', submitted: 'submitted_at', activity: 'last_activity',
  due: 'due_date', overdue: 'days_overdue', priority: 'priority_rank', stage: 'stage',
};

const queueQuery = z.object({
  q: z.string().trim().max(60).optional(),
  countyId: countyParam,
  stage: z.enum(STAGES.map((s) => s.key) as [string, ...string[]]).optional(),
  type: z.string().max(30).optional(),
  assigneeId: z.string().uuid().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  overdue: z.enum(['true', 'false']).optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('activity'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), 'Page size must be 10, 25, 50 or 100').default(25),
});

/** Days past the case due date, or past the configured target for its status; null when neither applies. */
const DAYS_OVERDUE_SQL = `greatest(
    CASE WHEN c.due_date IS NOT NULL THEN current_date - c.due_date END,
    CASE WHEN ($2::jsonb ->> c.status) IS NOT NULL
         THEN floor(extract(epoch FROM now() - ${STAGE_SINCE_SQL}) / 86400)::int - ($2::jsonb ->> c.status)::int END)`;

export async function applicationQueue(req: Request, raw: unknown) {
  const q = queueQuery.parse(raw);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const targets = await stageTargets(pool);
  const { rows } = await pool.query(
    `WITH q AS (
       SELECT c.id, c.case_no, c.case_type, c.status, c.priority, c.due_date, c.created_at, c.county_id,
              co.code AS county_code, co.name AS county_name, coalesce(p.upi, c.proposed_upi) AS upi,
              ${stageSql()} AS stage, ${STAGE_SINCE_SQL} AS stage_since, sub.at AS submitted_at, act.at AS last_activity,
              cu.username AS opened_by, asg.assignees, asg.assignee_ids,
              (SELECT count(*)::int FROM lais.case_right_proposal rp WHERE rp.case_id = c.id) AS proposed_holders,
              lr.error_count, lr.warning_count, coalesce(${ACCEPTED_SQL}, false) AS quality_accepted,
              ${DAYS_OVERDUE_SQL} AS days_overdue,
              array_position(ARRAY['urgent', 'high', 'normal', 'low'], c.priority) AS priority_rank
         FROM lais.land_case c
         JOIN lais.county co ON co.id = c.county_id
         LEFT JOIN lais.parcel p ON p.id = c.parcel_id
         JOIN lais.app_user cu ON cu.id = c.created_by
         ${CASE_JOINS}
         LEFT JOIN LATERAL (SELECT min(e.at) AS at FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = 'validating') sub ON true
         LEFT JOIN LATERAL (SELECT max(e.at) AS at FROM lais.case_event e WHERE e.case_id = c.id) act ON true
         LEFT JOIN LATERAL (SELECT string_agg(DISTINCT u.username, ', ') AS assignees, array_agg(DISTINCT u.id) AS assignee_ids
                              FROM lais.task t JOIN lais.app_user u ON u.id = t.assignee_id
                             WHERE t.case_id = c.id AND t.status NOT IN ('completed', 'cancelled')) asg ON true
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
     )
     SELECT q.*, count(*) OVER () AS total FROM q
      WHERE ($3::text IS NULL OR q.case_no ILIKE '%' || $3 || '%' OR q.upi ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR q.stage = $4) AND ($5::text IS NULL OR q.case_type = $5)
        AND ($6::uuid IS NULL OR $6 = ANY(q.assignee_ids)) AND ($7::text IS NULL OR q.priority = $7)
        AND ($8::date IS NULL OR q.created_at >= $8) AND ($9::date IS NULL OR q.created_at < $9::date + 1)
        AND (NOT $10::boolean OR coalesce(q.days_overdue, 0) > 0)
      ORDER BY ${SORTS[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, q.case_no
      LIMIT $11 OFFSET $12`,
    [counties, targets ? JSON.stringify(targets) : null, q.q || null, q.stage ?? null, q.type ?? null, q.assigneeId ?? null,
      q.priority ?? null, q.from ?? null, q.to ?? null, q.overdue === 'true', q.pageSize, (q.page - 1) * q.pageSize],
  );
  return {
    items: rows.map(({ total: _t, assignee_ids: _a, priority_rank: _p, ...r }) => r),
    total: Number(rows[0]?.total ?? 0),
    page: q.page,
    pageSize: q.pageSize,
    targetsConfigured: targets !== null,
  };
}

supervisionRouter.get('/applications', async (req, res) => {
  res.json(await applicationQueue(req, req.query));
});

// ---------------------------------------------------------------------------
// One case: supervision view and review actions
// ---------------------------------------------------------------------------

async function caseInScope(req: Request, id: string) {
  const cs = await getCase(pool, id);
  enforce(req, 'supervision.view', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
  return cs;
}

/** Why the current submission cannot be accepted (empty when it can). */
async function acceptProblems(db: typeof pool | import('pg').PoolClient, cs: { id: string; status: string; case_type: string }) {
  const problems: string[] = [];
  if (cs.status !== 'under_review') problems.push('Only a submitted case awaiting review can be accepted');
  const latest = await latestRun(db, cs.id);
  if (!latest) problems.push('The case has not been validated');
  else {
    const errors = latest.findings.filter((f: { severity: string }) => f.severity === 'error').length;
    if (errors > 0) problems.push(`The latest validation has ${errors} blocking error(s): return it for correction instead`);
    if ((SPATIAL_CASE_TYPES as readonly string[]).includes(cs.case_type)) {
      const { rows: [b] } = await db.query(`SELECT id FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
      if (!b) problems.push('No current geometry submission');
      else if (latest.run.batch_id && latest.run.batch_id !== b.id) problems.push('The latest validation does not cover the current geometry');
    }
    const { rows: [already] } = await db.query(
      `SELECT 1 FROM lais.supervisory_review WHERE case_id = $1 AND decision = 'accepted' AND validation_run_id = $2
          AND NOT EXISTS (SELECT 1 FROM lais.supervisory_review r2 WHERE r2.case_id = $1 AND r2.created_at > supervisory_review.created_at)`,
      [cs.id, latest.run.id],
    );
    if (already) problems.push('These validation results have already been accepted');
  }
  return { problems, latest };
}

supervisionRouter.get('/cases/:id', async (req, res) => {
  const cs = await caseInScope(req, parseId(req.params.id));
  const principal = req.auth!.principal;
  const [reviews, tasks, escalations, notes, officer, { problems }, mode, stage] = await Promise.all([
    pool.query(
      `SELECT s.id, s.decision, s.issue_categories, s.affected_features, s.notes, s.instructions, s.case_status, s.created_at,
              s.validation_run_id, u.username AS reviewer, t.task_no, t.status AS task_status, t.completion_note AS response
         FROM lais.supervisory_review s JOIN lais.app_user u ON u.id = s.reviewer_id LEFT JOIN lais.task t ON t.id = s.task_id
        WHERE s.case_id = $1 ORDER BY s.created_at DESC`,
      [cs.id],
    ),
    pool.query(
      `SELECT t.id, t.task_no, t.task_type, t.title, t.status, t.priority, t.due_date, u.username AS assignee
         FROM lais.task t LEFT JOIN lais.app_user u ON u.id = t.assignee_id WHERE t.case_id = $1 ORDER BY t.created_at DESC`,
      [cs.id],
    ),
    pool.query(
      `SELECT id, escalation_no, category, severity, status, responsible_role, title, created_at FROM lais.escalation
        WHERE case_id = $1 ORDER BY created_at DESC`,
      [cs.id],
    ),
    pool.query(
      `SELECT e.action, e.note, e.at, u.username AS actor FROM lais.case_event e LEFT JOIN lais.app_user u ON u.id = e.actor_id
        WHERE e.case_id = $1 AND e.action IN ('supervisor_note', 'supervisor_follow_up', 'priority_changed') ORDER BY e.id DESC`,
      [cs.id],
    ),
    responsibleOfficer(pool, cs.id, cs.county_id),
    acceptProblems(pool, cs),
    reviewMode(pool),
    pool.query(`SELECT ${stageSql()} AS stage, ${ACCEPTED_SQL} AS accepted FROM lais.land_case c ${CASE_JOINS} WHERE c.id = $1`, [cs.id]),
  ]);
  const ctx = await caseContext(pool, cs);
  res.json({
    caseId: cs.id,
    caseNo: cs.case_no,
    countyId: cs.county_id,
    status: cs.status,
    stage: stage.rows[0].stage,
    qualityAccepted: Boolean(stage.rows[0].accepted),
    priority: cs.priority,
    dueDate: cs.due_date,
    reviewMode: mode,
    responsibleOfficer: officer,
    canReview: authorize(principal, 'supervision.review', ctx).allowed,
    canSetPriority: authorize(principal, 'supervision.set_priority', ctx).allowed,
    acceptBlockedBy: problems,
    reviews: reviews.rows,
    tasks: tasks.rows,
    escalations: escalations.rows,
    notes: notes.rows,
  });
});

const acceptBody = z.object({ notes: z.string().trim().min(5).max(2000) });

/** Records that the submission meets quality requirements. Not a legal decision: nothing is approved or published. */
supervisionRouter.post('/cases/:id/accept', async (req, res) => {
  const body = acceptBody.parse(req.body);
  const result = await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.review', await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
    const { problems, latest } = await acceptProblems(client, cs);
    if (problems.length > 0) throw conflict(problems[0], { problems });
    const { rows: [review] } = await client.query(
      `INSERT INTO lais.supervisory_review (case_id, county_id, batch_id, validation_run_id, decision, notes, case_status, reviewer_id)
       VALUES ($1, $2, $3, $4, 'accepted', $5, $6, $7) RETURNING id, created_at`,
      [cs.id, cs.county_id, latest!.run.batch_id ?? null, latest!.run.id, body.notes, cs.status, req.auth!.user.id],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'quality_review_accepted', body.notes);
    await notifyRoles(client, ['registrar'], { category: 'review', title: `${cs.case_no} passed supervisory quality review`, body: 'Ready for a registrar decision', link: `/work/cases/${cs.id}` }, cs.county_id);
    await writeAudit(req, {
      action: 'supervision.accept', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { reviewId: review.id, validationRunId: latest!.run.id, batchId: latest!.run.batch_id ?? null },
    }, client);
    return { reviewId: review.id, validationRunId: latest!.run.id };
  });
  res.status(201).json(result);
});

const returnBody = z.object({
  reason: z.string().trim().min(10).max(2000),
  issueCategories: z.array(z.string().max(40)).min(1, 'Select at least one issue category').max(11),
  affectedFeatures: z.array(z.number().int().min(0).max(999)).max(1000).default([]),
  findingIds: z.array(z.string().uuid()).max(200).default([]),
  instructions: z.string().trim().max(4000).optional(),
  dueDate: isoDate.optional(),
});

/**
 * Returns a submitted case to its preparers for correction. The submission, its validation results and
 * every earlier review stay as history; a correction task goes to the responsible officer.
 */
supervisionRouter.post('/cases/:id/return', async (req, res) => {
  const body = returnBody.parse(req.body);
  const result = await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.review', await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
    const { rows: known } = await client.query('SELECT code FROM lais.review_issue_category WHERE active AND code = ANY($1)', [body.issueCategories]);
    if (known.length !== new Set(body.issueCategories).size) throw badRequest('Unknown issue category');
    const latest = await latestRun(client, cs.id);
    const findingIds = new Set((latest?.findings ?? []).map((f: { id: string }) => f.id));
    if (body.findingIds.some((id) => !findingIds.has(id))) throw badRequest('A selected finding is not in the latest validation of this case');
    const { rows: [batch] } = await client.query(`SELECT id, feature_count FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
    if (body.affectedFeatures.some((i) => !batch || i >= batch.feature_count)) throw badRequest('A selected record is not in the current submission');

    const officer = await responsibleOfficer(client, cs.id, cs.county_id);
    const { rows: [task] } = await client.query(
      `INSERT INTO lais.task (task_type, title, description, instructions, county_id, case_id, batch_id, assignee_id, status, priority, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, task_no`,
      [officer?.role === 'processor' ? 'correction_resubmission' : 'gis_validation_correction', `Correct and resubmit ${cs.case_no}`,
        body.reason, body.instructions ?? null, cs.county_id, cs.id, batch?.id ?? null, officer?.id ?? null,
        officer ? 'assigned' : 'unassigned', cs.priority, body.dueDate ?? null, req.auth!.user.id],
    );
    await client.query(
      `INSERT INTO lais.task_event (task_id, actor_id, action, to_value, note) VALUES ($1, $2, 'created', $3, $4)`,
      [task.id, req.auth!.user.id, officer?.username ?? 'unassigned', 'Created by a supervisory return for correction'],
    );
    const { rows: [review] } = await client.query(
      `INSERT INTO lais.supervisory_review (case_id, county_id, batch_id, validation_run_id, decision, issue_categories, affected_features,
                                             notes, instructions, task_id, case_status, reviewer_id)
       VALUES ($1, $2, $3, $4, 'returned', $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [cs.id, cs.county_id, batch?.id ?? null, latest?.run.id ?? null, body.issueCategories, body.affectedFeatures,
        body.reason, body.instructions ?? null, task.id, cs.status, req.auth!.user.id],
    );
    for (const findingId of body.findingIds) {
      await client.query(
        `INSERT INTO lais.conflict_review_event (finding_id, case_id, action, note, task_id, actor_id) VALUES ($1, $2, 'returned_for_correction', $3, $4, $5)`,
        [findingId, cs.id, body.reason, task.id, req.auth!.user.id],
      );
    }
    await setStatus(client, cs, 'returned', req.auth!.user.id, 'supervisor_return', body.reason);
    await notifyUsers(client, [officer?.id, cs.created_by], {
      category: 'review', title: `${cs.case_no} was returned for correction by a supervisor`, body: body.reason.slice(0, 200), link: `/work/cases/${cs.id}`,
    });
    await writeAudit(req, {
      action: 'supervision.return', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { reviewId: review.id, taskId: task.id, issueCategories: body.issueCategories, affectedFeatures: body.affectedFeatures.length, findings: body.findingIds.length },
    }, client);
    return { reviewId: review.id, task: { id: task.id, taskNo: task.task_no, assignee: officer?.username ?? null } };
  });
  res.status(201).json(result);
});

const infoBody = z.object({
  message: z.string().trim().min(10).max(2000),
  assigneeId: z.string().uuid().optional(),
  dueDate: isoDate.optional(),
});

/** Asks the responsible officer for information. Tracked as a task: its completion note is the response. */
supervisionRouter.post('/cases/:id/request-info', async (req, res) => {
  const body = infoBody.parse(req.body);
  const result = await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.review', await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
    let assignee: { id: string; username: string } | null;
    if (body.assigneeId) {
      await assertEligibleAssignee(client, body.assigneeId, 'additional_information', cs.county_id);
      const { rows: [u] } = await client.query('SELECT id, username FROM lais.app_user WHERE id = $1', [body.assigneeId]);
      assignee = u;
    } else {
      assignee = await responsibleOfficer(client, cs.id, cs.county_id);
    }
    const latest = await latestRun(client, cs.id);
    const { rows: [task] } = await client.query(
      `INSERT INTO lais.task (task_type, title, description, county_id, case_id, assignee_id, status, priority, due_date, created_by)
       VALUES ('additional_information', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, task_no`,
      [`Information requested on ${cs.case_no}`, body.message, cs.county_id, cs.id, assignee?.id ?? null,
        assignee ? 'assigned' : 'unassigned', cs.priority, body.dueDate ?? null, req.auth!.user.id],
    );
    await client.query(
      `INSERT INTO lais.task_event (task_id, actor_id, action, to_value, note) VALUES ($1, $2, 'created', $3, 'Created by a supervisory information request')`,
      [task.id, req.auth!.user.id, assignee?.username ?? 'unassigned'],
    );
    const { rows: [review] } = await client.query(
      `INSERT INTO lais.supervisory_review (case_id, county_id, validation_run_id, decision, notes, task_id, case_status, reviewer_id)
       VALUES ($1, $2, $3, 'info_requested', $4, $5, $6, $7) RETURNING id`,
      [cs.id, cs.county_id, latest?.run.id ?? null, body.message, task.id, cs.status, req.auth!.user.id],
    );
    await notifyUsers(client, [assignee?.id], { category: 'review', title: `Information requested on ${cs.case_no}`, body: body.message.slice(0, 200), link: '/work/tasks' });
    await writeAudit(req, {
      action: 'supervision.request_info', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { reviewId: review.id, taskId: task.id },
    }, client);
    return { reviewId: review.id, task: { id: task.id, taskNo: task.task_no, assignee: assignee?.username ?? null } };
  });
  res.status(201).json(result);
});

const priorityBody = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueDate: isoDate.nullable().optional(),
  reason: z.string().trim().min(5).max(500),
}).refine((b) => b.priority !== undefined || b.dueDate !== undefined, 'Change the priority or the due date');

/** Operational priority and due date. Internal targets only: they are not legal deadlines. */
supervisionRouter.patch('/cases/:id/priority', async (req, res) => {
  const body = priorityBody.parse(req.body);
  await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.set_priority', await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
    const priority = body.priority ?? cs.priority;
    const due = body.dueDate === undefined ? cs.due_date : body.dueDate;
    await client.query('UPDATE lais.land_case SET priority = $2, due_date = $3 WHERE id = $1', [cs.id, priority, due]);
    const change = `priority ${cs.priority} → ${priority}; due ${cs.due_date ? String(cs.due_date).slice(0, 10) : 'none'} → ${due ? String(due).slice(0, 10) : 'none'}`;
    await recordEvent(client, cs.id, req.auth!.user.id, 'priority_changed', `${change}. ${body.reason}`);
    await writeAudit(req, {
      action: 'supervision.priority', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { from: { priority: cs.priority, dueDate: cs.due_date }, to: { priority, dueDate: due }, reason: body.reason },
    }, client);
  });
  res.json({ ok: true });
});

const noteBody = z.object({ note: z.string().trim().min(5).max(2000) });

/** An internal supervisory note in the case history (not shown to landowners). */
supervisionRouter.post('/cases/:id/notes', async (req, res) => {
  const { note } = noteBody.parse(req.body);
  await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.view', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
    await recordEvent(client, cs.id, req.auth!.user.id, 'supervisor_note', note);
    await writeAudit(req, { action: 'supervision.note', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id }, client);
  });
  res.status(201).json({ ok: true });
});

const followUpBody = z.object({ message: z.string().trim().min(5).max(1000) });

/** Sends a follow-up (progress request) to the officers currently working on the case. */
supervisionRouter.post('/cases/:id/follow-up', async (req, res) => {
  const { message } = followUpBody.parse(req.body);
  const recipients = await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'supervision.view', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
    const { rows } = await client.query(
      `SELECT DISTINCT u.id, u.username FROM lais.task t JOIN lais.app_user u ON u.id = t.assignee_id
        WHERE t.case_id = $1 AND t.status NOT IN ('completed', 'cancelled')`,
      [cs.id],
    );
    const people = rows.length > 0 ? rows : [await responsibleOfficer(client, cs.id, cs.county_id)].filter(Boolean) as { id: string; username: string }[];
    if (people.length === 0) throw conflict('Nobody is currently responsible for this case; assign a task first');
    await notifyUsers(client, people.map((p) => p.id), { category: 'task', title: `Progress update requested on ${cs.case_no}`, body: message, link: `/work/cases/${cs.id}` });
    await recordEvent(client, cs.id, req.auth!.user.id, 'supervisor_follow_up', `${message} (to ${people.map((p) => p.username).join(', ')})`);
    await writeAudit(req, { action: 'supervision.follow_up', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { recipients: people.length } }, client);
    return people.map((p) => p.username);
  });
  res.json({ notified: recipients });
});

export { caseInScope };

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /supervision/staff', staffQuery);
documentQuery('GET /supervision/dashboard/summary', rangeQuery);
documentQuery('GET /supervision/dashboard/charts', chartsQuery);
documentQuery('GET /supervision/applications', queueQuery);
documentBody('POST /supervision/cases/{id}/accept', acceptBody);
documentBody('POST /supervision/cases/{id}/return', returnBody);
documentBody('POST /supervision/cases/{id}/request-info', infoBody);
documentBody('PATCH /supervision/cases/{id}/priority', priorityBody);
documentBody('POST /supervision/cases/{id}/notes', noteBody);
documentBody('POST /supervision/cases/{id}/follow-up', followUpBody);
