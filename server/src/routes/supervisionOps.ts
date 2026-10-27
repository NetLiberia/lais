import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound } from '../http.js';
import { writeAudit } from '../audit.js';
import { csvCell } from '../csv.js';
import { CONFLICTS_SQL, OPEN_CONFLICT_STATUSES } from '../services/conflicts.js';
import { CASE_JOINS, STAGE_SINCE_SQL, STAGES, TASK_TYPE_KEYS, dateRange, resolveScope, stageSql, stageTargets } from '../services/supervision.js';
import { applicationQueue, stageDurations, staffWorkload } from './supervision.js';
import { documentQuery } from '../openapi.js';

/** Workload, overdue work and bottlenecks, operational reports and supervisory activity. Mounted at /supervision. */
export const supervisionOpsRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countyParam = z.coerce.number().int().positive().optional();

// ---------------------------------------------------------------------------
// Staff workload
// ---------------------------------------------------------------------------

const workloadQuery = z.object({
  countyId: countyParam,
  role: z.enum(['gis_officer', 'processor']).optional(),
  staffId: z.string().uuid().optional(),
  taskType: z.enum(TASK_TYPE_KEYS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

supervisionOpsRouter.get('/workload', async (req, res) => {
  const q = workloadQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { from, to } = dateRange(q);
  const [staff, { rows: assignments }] = await Promise.all([
    staffWorkload(counties, from, to, { role: q.role, staffId: q.staffId, taskType: q.taskType }),
    pool.query(
      `SELECT t.id, t.task_no, t.task_type, t.title, t.status, t.priority, t.due_date, t.assignee_id, c.case_no, c.status AS case_status
         FROM lais.task t LEFT JOIN lais.land_case c ON c.id = t.case_id
        WHERE t.status NOT IN ('completed', 'cancelled') AND t.assignee_id IS NOT NULL
          AND ($1::smallint[] IS NULL OR t.county_id = ANY($1)) AND ($2::text IS NULL OR t.task_type = $2) AND ($3::uuid IS NULL OR t.assignee_id = $3)
        ORDER BY t.due_date NULLS LAST, t.created_at`,
      [counties, q.taskType ?? null, q.staffId ?? null],
    ),
  ]);
  res.json({ range: { from, to }, staff, assignments });
});

// ---------------------------------------------------------------------------
// Overdue work and bottlenecks
// ---------------------------------------------------------------------------

supervisionOpsRouter.get('/overdue', async (req, res) => {
  const countyId = countyParam.parse(req.query.countyId);
  const counties = resolveScope(req, 'supervision.view', countyId);
  const targets = await stageTargets(pool);
  const [{ rows: tasks }, cases] = await Promise.all([
    pool.query(
      `SELECT t.id, t.task_no, t.task_type, t.title, t.status, t.priority, t.due_date, current_date - t.due_date AS days_overdue,
              t.county_id, co.code AS county_code, c.id AS case_id, c.case_no, u.username AS assignee,
              round((extract(epoch FROM now() - t.updated_at) / 86400)::numeric, 1) AS days_in_status,
              fu.at AS last_follow_up, bl.note AS blocking_issue
         FROM lais.task t JOIN lais.county co ON co.id = t.county_id
         LEFT JOIN lais.land_case c ON c.id = t.case_id LEFT JOIN lais.app_user u ON u.id = t.assignee_id
         LEFT JOIN LATERAL (SELECT max(e.at) AS at FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'follow_up') fu ON true
         LEFT JOIN LATERAL (SELECT e.note FROM lais.task_event e WHERE e.task_id = t.id AND e.to_value = 'blocked' ORDER BY e.id DESC LIMIT 1) bl ON t.status = 'blocked'
        WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_date < current_date AND ($1::smallint[] IS NULL OR t.county_id = ANY($1))
        ORDER BY t.due_date`,
      [counties],
    ),
    applicationQueue(req, { countyId, overdue: 'true', sort: 'overdue', dir: 'desc', pageSize: 100 }),
  ]);
  const { rows: followUps } = await pool.query(
    `SELECT e.case_id, max(e.at) AS at FROM lais.case_event e WHERE e.case_id = ANY($1) AND e.action = 'supervisor_follow_up' GROUP BY e.case_id`,
    [cases.items.map((c) => c.id)],
  );
  res.json({
    tasks,
    cases: cases.items.map((c) => ({ ...c, last_follow_up: followUps.find((f) => f.case_id === c.id)?.at ?? null })),
    targetsConfigured: targets !== null,
    targets,
    // Due dates and targets are internal operational settings, not statutory or regulatory deadlines.
    basis: targets ? 'Case due dates, task due dates and the configured operational stage targets' : 'Case and task due dates only: no stage targets are configured',
  });
});

supervisionOpsRouter.get('/bottlenecks', async (req, res) => {
  const q = z.object({ countyId: countyParam, from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { from, to } = dateRange(q);
  const targets = await stageTargets(pool);
  const [durations, { rows: current }] = await Promise.all([
    stageDurations(counties, from, to),
    pool.query(
      `SELECT ${stageSql()} AS stage, c.status, count(*)::int AS n,
              round((avg(extract(epoch FROM now() - ${STAGE_SINCE_SQL})) / 86400)::numeric, 1) AS avg_age_days,
              round((max(extract(epoch FROM now() - ${STAGE_SINCE_SQL})) / 86400)::numeric, 1) AS max_age_days
         FROM lais.land_case c ${CASE_JOINS}
        WHERE c.status IN ('draft', 'validating', 'under_review', 'returned', 'approved') AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
        GROUP BY 1, 2`,
      [counties],
    ),
  ]);
  res.json({
    range: { from, to },
    informational: targets === null,
    targets,
    completedStays: durations,
    currentlyIn: current.map((r) => ({
      ...r, label: STAGES.find((s) => s.key === r.stage)?.label ?? r.stage,
      avg_age_days: Number(r.avg_age_days), max_age_days: Number(r.max_age_days),
      target_days: targets?.[r.status] ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

type Kind = 'value' | 'count' | 'derived';
interface Column { key: string; label: string; kind: Kind }
interface ReportFilters { counties: number[] | null; from: string; to: string; stage?: string; taskType?: string; role?: string }
interface ReportDef { title: string; description: string; columns: Column[]; rows: (f: ReportFilters) => Promise<Record<string, unknown>[]> }

const col = (key: string, label: string, kind: Kind = 'value'): Column => ({ key, label, kind });

const REPORTS: Record<string, ReportDef> = {
  application_status: {
    title: 'Application processing status',
    description: 'Applications opened in the period, with their current workflow stage.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('case_type', 'Type'), col('stage', 'Stage'), col('status', 'Status'),
      col('priority', 'Priority'), col('created_at', 'Opened'), col('submitted_at', 'First submitted'), col('days_in_stage', 'Days in current stage', 'derived')],
    rows: async (f) => (await pool.query(
      `SELECT * FROM (SELECT c.case_no, co.code AS county, c.case_type, ${stageSql()} AS stage, c.status, c.priority, c.created_at,
              (SELECT min(e.at) FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = 'validating') AS submitted_at,
              round((extract(epoch FROM now() - ${STAGE_SINCE_SQL}) / 86400)::numeric, 1) AS days_in_stage
         FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id ${CASE_JOINS}
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND c.created_at >= $2::date AND c.created_at < $3::date + 1) x
        WHERE ($4::text IS NULL OR x.stage = $4) ORDER BY x.created_at`,
      [f.counties, f.from, f.to, f.stage ?? null])).rows,
  },
  gis_validation_outcomes: {
    title: 'GIS validation outcomes',
    description: 'Validation runs in the period: blocking errors and warnings per run.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('run_at', 'Run at'), col('purpose', 'Purpose'), col('source_filename', 'Source file'),
      col('error_count', 'Errors', 'count'), col('warning_count', 'Warnings', 'count'), col('outcome', 'Outcome', 'derived')],
    rows: async (f) => (await pool.query(
      `SELECT c.case_no, co.code AS county, r.run_at, r.purpose, b.source_filename, r.error_count, r.warning_count,
              CASE WHEN r.error_count > 0 THEN 'failed' WHEN r.warning_count > 0 THEN 'passed with warnings' ELSE 'passed' END AS outcome
         FROM staging.validation_run r JOIN lais.land_case c ON c.id = r.case_id JOIN lais.county co ON co.id = c.county_id
         LEFT JOIN staging.batch b ON b.id = r.batch_id
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND r.run_at >= $2::date AND r.run_at < $3::date + 1 ORDER BY r.run_at`,
      [f.counties, f.from, f.to])).rows,
  },
  returned_submissions: {
    title: 'Returned submissions and correction reasons',
    description: 'Cases returned in the period by automated validation, a supervisor or a registrar, with the reason.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('at', 'Returned at'), col('returned_by', 'Returned by'), col('source', 'Source'),
      col('issue_categories', 'Issue categories'), col('reason', 'Reason')],
    rows: async (f) => (await pool.query(
      `SELECT c.case_no, co.code AS county, e.at, coalesce(u.username, 'automated validation') AS returned_by,
              CASE e.action WHEN 'supervisor_return' THEN 'supervisor' WHEN 'validation_failed' THEN 'validation' ELSE 'registrar' END AS source,
              (SELECT array_to_string(s.issue_categories, '; ') FROM lais.supervisory_review s WHERE s.case_id = c.id AND s.decision = 'returned'
                  AND abs(extract(epoch FROM s.created_at - e.at)) < 5 LIMIT 1) AS issue_categories, e.note AS reason
         FROM lais.case_event e JOIN lais.land_case c ON c.id = e.case_id JOIN lais.county co ON co.id = c.county_id
         LEFT JOIN lais.app_user u ON u.id = e.actor_id
        WHERE e.to_status = 'returned' AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND e.at >= $2::date AND e.at < $3::date + 1 ORDER BY e.at`,
      [f.counties, f.from, f.to])).rows,
  },
  conflict_backlog: {
    title: 'Spatial conflict backlog',
    description: 'Unresolved conflict signals (new, investigating, awaiting correction, escalated). Not legal findings.',
    columns: [col('case_no', 'Application'), col('county_code', 'County'), col('category_label', 'Category'), col('code', 'Rule'), col('severity', 'Severity'),
      col('review_status', 'Review status', 'derived'), col('detected_at', 'First detected'), col('investigator', 'Investigator'), col('related', 'Related record')],
    rows: async (f) => (await pool.query(
      `SELECT x.case_no, x.county_code, x.category_label, x.code, x.severity, x.review_status, x.detected_at, x.investigator,
              coalesce(x.related_upi, x.related_case_no) AS related
         FROM (${CONFLICTS_SQL}) x WHERE x.review_status = ANY($2) ORDER BY x.detected_at`,
      [f.counties, OPEN_CONFLICT_STATUSES])).rows,
  },
  stage_times: {
    title: 'Average processing time by stage',
    description: 'Completed stays in each status that ended in the period, from the case history. Hours.',
    columns: [col('status', 'Status'), col('n', 'Completed stays', 'count'), col('avgHours', 'Average hours', 'derived'), col('medianHours', 'Median hours', 'derived')],
    rows: async (f) => stageDurations(f.counties, f.from, f.to),
  },
  overdue_work: {
    title: 'Overdue work',
    description: 'Open tasks past their due date. Due dates are internal operational targets, not statutory deadlines.',
    columns: [col('task_no', 'Task'), col('county', 'County'), col('task_type', 'Type'), col('case_no', 'Application'), col('assignee', 'Assignee'),
      col('status', 'Status'), col('due_date', 'Due'), col('days_overdue', 'Days overdue', 'derived')],
    rows: async (f) => (await pool.query(
      `SELECT t.task_no, co.code AS county, t.task_type, c.case_no, u.username AS assignee, t.status, t.due_date, current_date - t.due_date AS days_overdue
         FROM lais.task t JOIN lais.county co ON co.id = t.county_id LEFT JOIN lais.land_case c ON c.id = t.case_id LEFT JOIN lais.app_user u ON u.id = t.assignee_id
        WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_date < current_date AND ($1::smallint[] IS NULL OR t.county_id = ANY($1))
          AND ($2::text IS NULL OR t.task_type = $2) ORDER BY t.due_date`,
      [f.counties, f.taskType ?? null])).rows,
  },
  reassignment_history: {
    title: 'Task reassignment history',
    description: 'Every reassignment in the period, with who made it and why.',
    columns: [col('at', 'When'), col('task_no', 'Task'), col('county', 'County'), col('from_user', 'From'), col('to_user', 'To'), col('by', 'By'), col('reason', 'Reason')],
    rows: async (f) => (await pool.query(
      `SELECT e.at, t.task_no, co.code AS county, fu.username AS from_user, tu.username AS to_user, u.username AS by, e.note AS reason
         FROM lais.task_event e JOIN lais.task t ON t.id = e.task_id JOIN lais.county co ON co.id = t.county_id JOIN lais.app_user u ON u.id = e.actor_id
         LEFT JOIN lais.app_user fu ON fu.id::text = e.from_value LEFT JOIN lais.app_user tu ON tu.id::text = e.to_value
        WHERE e.action = 'reassigned' AND ($1::smallint[] IS NULL OR t.county_id = ANY($1)) AND e.at >= $2::date AND e.at < $3::date + 1
          AND ($4::text IS NULL OR t.task_type = $4) ORDER BY e.at`,
      [f.counties, f.from, f.to, f.taskType ?? null])).rows,
  },
  repeated_quality_issues: {
    title: 'Repeated data-quality issues',
    description: 'Validation rules triggered in submission runs during the period, and how many applications hit the same rule more than once.',
    columns: [col('code', 'Rule'), col('severity', 'Severity'), col('county', 'County'), col('occurrences', 'Occurrences', 'count'),
      col('applications', 'Applications', 'count'), col('repeated_in', 'Applications failing it in 2+ submissions', 'count')],
    rows: async (f) => (await pool.query(
      `WITH hits AS (
         SELECT x.code, x.severity, co.code AS county, r.case_id, count(*) AS n FROM staging.finding x
           JOIN staging.validation_run r ON r.id = x.run_id JOIN lais.land_case c ON c.id = r.case_id JOIN lais.county co ON co.id = c.county_id
          WHERE r.purpose = 'submission' AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND r.run_at >= $2::date AND r.run_at < $3::date + 1
          GROUP BY 1, 2, 3, 4)
       SELECT code, severity, county, sum(n)::int AS occurrences, count(*)::int AS applications, count(*) FILTER (WHERE n > 1)::int AS repeated_in
         FROM hits GROUP BY 1, 2, 3 ORDER BY occurrences DESC`,
      [f.counties, f.from, f.to])).rows,
  },
  supervisory_review_outcomes: {
    title: 'Supervisory review outcomes',
    description: 'Quality reviews recorded in the period. Acceptance is an operational check, not a legal approval.',
    columns: [col('created_at', 'When'), col('case_no', 'Application'), col('county', 'County'), col('decision', 'Decision'), col('reviewer', 'Reviewer'),
      col('issue_categories', 'Issue categories'), col('notes', 'Notes')],
    rows: async (f) => (await pool.query(
      `SELECT s.created_at, c.case_no, co.code AS county, s.decision, u.username AS reviewer, array_to_string(s.issue_categories, '; ') AS issue_categories, s.notes
         FROM lais.supervisory_review s JOIN lais.land_case c ON c.id = s.case_id JOIN lais.county co ON co.id = s.county_id JOIN lais.app_user u ON u.id = s.reviewer_id
        WHERE ($1::smallint[] IS NULL OR s.county_id = ANY($1)) AND s.created_at >= $2::date AND s.created_at < $3::date + 1 ORDER BY s.created_at`,
      [f.counties, f.from, f.to])).rows,
  },
  escalated_cases: {
    title: 'Escalated cases',
    description: 'Escalations raised in the period and their current status.',
    columns: [col('escalation_no', 'Escalation'), col('county', 'County'), col('category', 'Category'), col('severity', 'Severity'), col('status', 'Status'),
      col('responsible', 'Responsible'), col('case_no', 'Application'), col('created_at', 'Raised'), col('closed_at', 'Closed'), col('closure_reason', 'Closure reason')],
    rows: async (f) => (await pool.query(
      `SELECT x.escalation_no, co.code AS county, x.category, x.severity, x.status, x.responsible_level || ' ' || x.responsible_role AS responsible,
              c.case_no, x.created_at, x.closed_at, x.closure_reason
         FROM lais.escalation x JOIN lais.county co ON co.id = x.county_id LEFT JOIN lais.land_case c ON c.id = x.case_id
        WHERE ($1::smallint[] IS NULL OR x.county_id = ANY($1)) AND x.created_at >= $2::date AND x.created_at < $3::date + 1 ORDER BY x.created_at`,
      [f.counties, f.from, f.to])).rows,
  },
  workflow_exceptions: {
    title: 'Workflow exceptions',
    description: 'Returns, rejections, withdrawals and publications refused because the record changed after approval, in the period.',
    columns: [col('at', 'When'), col('case_no', 'Application'), col('county', 'County'), col('action', 'Event'), col('from_status', 'From'), col('to_status', 'To'),
      col('actor', 'By'), col('note', 'Note')],
    rows: async (f) => (await pool.query(
      `SELECT e.at, c.case_no, co.code AS county, e.action, e.from_status, e.to_status, coalesce(u.username, 'system') AS actor, e.note
         FROM lais.case_event e JOIN lais.land_case c ON c.id = e.case_id JOIN lais.county co ON co.id = c.county_id LEFT JOIN lais.app_user u ON u.id = e.actor_id
        WHERE (e.to_status IN ('returned', 'rejected', 'withdrawn') OR (e.from_status = 'approved' AND e.to_status = 'under_review'))
          AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND e.at >= $2::date AND e.at < $3::date + 1 ORDER BY e.at`,
      [f.counties, f.from, f.to])).rows,
  },
  staff_workload: {
    title: 'Staff workload',
    description: 'Tasks per officer. Raw counts do not account for task complexity, leave or assignment volume and are not a performance rating.',
    columns: [col('username', 'Officer'), col('roles', 'Roles'), col('assigned', 'Assigned', 'count'), col('active', 'Active', 'count'), col('overdue', 'Overdue', 'count'),
      col('returned', 'Returned', 'count'), col('completed', 'Completed in period', 'count'), col('avg_completion_hours', 'Average hours to complete', 'derived')],
    rows: async (f) => (await staffWorkload(f.counties, f.from, f.to, { role: f.role, taskType: f.taskType })) as unknown as Record<string, unknown>[],
  },
};

supervisionOpsRouter.get('/reports', (req, res) => {
  resolveScope(req, 'reports.supervision');
  res.json(Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description })));
});

const reportQuery = z.object({
  countyId: countyParam,
  from: isoDate.optional(),
  to: isoDate.optional(),
  stage: z.enum(STAGES.map((s) => s.key) as [string, ...string[]]).optional(),
  taskType: z.enum(TASK_TYPE_KEYS).optional(),
  role: z.enum(['gis_officer', 'processor']).optional(),
});

async function generate(req: Request, key: string, format: 'json' | 'csv') {
  const def = REPORTS[key];
  if (!def) throw notFound('Unknown report');
  const q = reportQuery.parse(req.query);
  const counties = resolveScope(req, 'reports.supervision', q.countyId);
  const { from, to } = dateRange(q);
  const rows = await def.rows({ counties, from, to, stage: q.stage, taskType: q.taskType, role: q.role });
  const { rows: scopeRows } = await pool.query(
    `SELECT string_agg(code, ', ' ORDER BY code) AS codes, bool_or(is_synthetic) AS synthetic FROM lais.county WHERE $1::smallint[] IS NULL OR id = ANY($1)`,
    [counties],
  );
  const report = {
    reportId: randomUUID(),
    key,
    title: def.title,
    description: def.description,
    generatedAt: new Date().toISOString(),
    generatedBy: req.auth!.user.username,
    scope: counties === null ? 'All counties' : scopeRows[0].codes,
    filters: { from, to, stage: q.stage ?? null, taskType: q.taskType ?? null, role: q.role ?? null },
    dataNotice: 'Research prototype: synthetic demonstration data, not real land records.',
    columns: def.columns,
    rows,
  };
  await writeAudit(req, {
    action: 'report.supervision', outcome: 'success', entityType: 'report', entityId: key,
    countyId: q.countyId ?? null, detail: { reportId: report.reportId, format, rows: rows.length, filters: report.filters, scope: report.scope },
  });
  return report;
}

supervisionOpsRouter.get('/reports/:key.csv', async (req, res) => {
  const r = await generate(req, req.params.key, 'csv');
  const meta = [
    `# ${r.title}`, `# Report ${r.reportId}, generated ${r.generatedAt} by ${r.generatedBy}`,
    `# Scope: ${r.scope}; period ${r.filters.from} to ${r.filters.to}${r.filters.stage ? `; stage ${r.filters.stage}` : ''}${r.filters.taskType ? `; task type ${r.filters.taskType}` : ''}${r.filters.role ? `; role ${r.filters.role}` : ''}`,
    `# ${r.dataNotice}`, `# Column kinds: ${r.columns.map((c) => `${c.label} = ${c.kind}`).join('; ')}`,
  ];
  const lines = [...meta, r.columns.map((c) => csvCell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lais-${r.key}-${r.filters.from}-${r.filters.to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

supervisionOpsRouter.get('/reports/:key', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await generate(req, req.params.key, 'json'));
});

// ---------------------------------------------------------------------------
// Supervisory activity history (from the immutable audit trail)
// ---------------------------------------------------------------------------

const activityQuery = z.object({
  countyId: countyParam,
  mine: z.enum(['true', 'false']).default('false'),
  action: z.string().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

supervisionOpsRouter.get('/activity', async (req, res) => {
  const q = activityQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { rows } = await pool.query(
    `SELECT e.chain_seq, e.at, e.actor_username, e.action, e.outcome, e.entity_type, e.entity_id, e.case_id, c.case_no, co.code AS county_code, e.detail
       FROM audit.event e LEFT JOIN lais.land_case c ON c.id = e.case_id LEFT JOIN lais.county co ON co.id = e.county_id
      WHERE (split_part(e.action, '.', 1) IN ('supervision', 'task', 'escalation', 'conflict')
             OR e.action IN ('report.supervision', 'case.approve', 'case.reject', 'case.return', 'case.publish', 'case.submit'))
        AND ($1::smallint[] IS NULL OR e.county_id = ANY($1)) AND ($2::uuid IS NULL OR e.actor_id = $2)
        AND ($3::text IS NULL OR e.action LIKE $3 || '%') AND ($4::bigint IS NULL OR e.chain_seq < $4)
      ORDER BY e.chain_seq DESC LIMIT $5`,
    [counties, q.mine === 'true' ? req.auth!.user.id : null, q.action ?? null, q.before ?? null, q.limit],
  );
  res.json({ events: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].chain_seq : null });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /supervision/workload', workloadQuery);
documentQuery(['GET /supervision/reports/{key}', 'GET /supervision/reports/{key}.csv'], reportQuery);
documentQuery('GET /supervision/activity', activityQuery);
