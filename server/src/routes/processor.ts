import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound } from '../http.js';
import { writeAudit } from '../audit.js';
import { dateRange, resolveScope } from '../services/supervision.js';
import { STAGE_JOINS, STAGE_LABELS, STAGE_SQL } from './applications.js';
import { csvCell } from '../csv.js';
import { tablePdf } from '../services/pdf.js';
import { documentQuery } from '../openapi.js';

/**
 * The processor's dashboard, work lists and reports, in the officer's counties. Every figure is computed
 * from the database at request time; nothing is cached or invented. Only applications registered through
 * intake are counted (cases opened directly by GIS officers, such as legacy migrations, are not
 * applications in this sense).
 */
export const processorRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countyParam = z.coerce.number().int().positive().optional();
const OPEN_STATUSES = ['draft', 'validating', 'under_review', 'returned', 'approved'];
const PROCESSOR_TASK_TYPES = ['document_review', 'application_follow_up', 'additional_information', 'correction_resubmission', 'attribute_verification'];

const APPS_CTE = `apps AS (
  SELECT c.*, cp.comp, ${STAGE_SQL} AS stage FROM lais.land_case c ${STAGE_JOINS}
   WHERE c.applicant_id IS NOT NULL AND ($1::smallint[] IS NULL OR c.county_id = ANY($1)))`;

const summaryQuery = z.object({ countyId: countyParam, from: isoDate.optional(), to: isoDate.optional() });

processorRouter.get('/summary', async (req, res) => {
  const q = summaryQuery.parse(req.query);
  const counties = resolveScope(req, 'case.view', q.countyId);
  const { from, to } = dateRange(q);
  const { rows: [k] } = await pool.query(
    `WITH ${APPS_CTE}
     SELECT
       (SELECT count(*) FROM apps WHERE intake_status = 'registered')::int AS total_registered,
       (SELECT count(*) FROM apps WHERE coalesce(submission_date, created_at::date) BETWEEN $2 AND $3)::int AS new_in_period,
       (SELECT count(*) FROM apps a WHERE a.status IN ('draft', 'returned') AND a.intake_status = 'registered'
           AND EXISTS (SELECT 1 FROM lais.document d WHERE d.case_id = a.id AND d.review_status IN ('not_reviewed', 'under_review')))::int AS awaiting_document_review,
       (SELECT count(*) FROM apps WHERE status IN ('draft', 'returned') AND comp = 'complete')::int AS complete,
       (SELECT count(*) FROM apps WHERE status IN ('draft', 'returned') AND comp IN ('incomplete', 'ready_for_review'))::int AS incomplete,
       (SELECT count(*) FROM apps WHERE status IN ('draft', 'returned') AND comp = 'awaiting_information')::int AS awaiting_information,
       (SELECT count(*) FROM apps WHERE stage = 'awaiting_gis')::int AS awaiting_gis,
       (SELECT count(*) FROM apps WHERE stage = 'gis_processing')::int AS gis_processing,
       (SELECT count(*) FROM apps WHERE status = 'returned')::int AS returned,
       (SELECT count(*) FROM apps WHERE status IN ('validating', 'under_review'))::int AS awaiting_registrar,
       (SELECT count(DISTINCT e.case_id) FROM lais.case_event e JOIN apps a ON a.id = e.case_id
         WHERE e.to_status IN ('approved', 'rejected', 'published') AND e.at::date BETWEEN $2 AND $3)::int AS completed_in_period,
       ((SELECT count(*) FROM lais.info_request i WHERE i.status IN ('pending', 'response_received', 'partially_satisfied') AND i.due_date < current_date
            AND ($1::smallint[] IS NULL OR i.county_id = ANY($1)))
        + (SELECT count(*) FROM lais.task t WHERE t.task_type = ANY($5) AND t.status NOT IN ('completed', 'cancelled') AND t.due_date < current_date
            AND ($1::smallint[] IS NULL OR t.county_id = ANY($1))))::int AS overdue_tasks,
       (SELECT count(*) FROM apps WHERE assigned_processor_id = $4 AND status = ANY($6))::int AS my_open`,
    [counties, from, to, req.auth!.user.id, PROCESSOR_TASK_TYPES, OPEN_STATUSES],
  );
  res.json({ kpis: k, range: { from, to }, refreshedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Returned applications: by validation, a supervisor or a registrar, plus GIS clarification requests
// ---------------------------------------------------------------------------

processorRouter.get('/returned', async (req, res) => {
  const counties = resolveScope(req, 'case.view', z.object({ countyId: countyParam }).parse(req.query).countyId);
  const { rows } = await pool.query(
    `WITH ${APPS_CTE}
     SELECT a.id, a.case_no, a.county_id, a.status, a.priority, a.due_date, pu.username AS processor, ap.applicant_no, ap.name AS applicant_name,
            CASE ev.action WHEN 'validation_failed' THEN 'validation' WHEN 'decide' THEN 'registrar' WHEN 'supervisor_return' THEN 'supervisor' ELSE 'other' END AS source,
            ev.at AS returned_at, ev.note AS reason, eu.username AS returned_by,
            rv.instructions, rv.issue_categories,
            (SELECT count(*) FROM lais.document d WHERE d.case_id = a.id AND d.review_status <> 'superseded')::int AS documents,
            NULL::text AS task_no
       FROM apps a
       JOIN lais.applicant ap ON ap.id = a.applicant_id
       LEFT JOIN lais.app_user pu ON pu.id = a.assigned_processor_id
       LEFT JOIN LATERAL (SELECT e.action, e.at, e.note, e.actor_id FROM lais.case_event e WHERE e.case_id = a.id AND e.to_status = 'returned' ORDER BY e.id DESC LIMIT 1) ev ON true
       LEFT JOIN lais.app_user eu ON eu.id = ev.actor_id
       LEFT JOIN LATERAL (SELECT s.instructions, s.issue_categories FROM lais.supervisory_review s WHERE s.case_id = a.id AND s.decision = 'returned' AND ev.action = 'supervisor_return'
                            ORDER BY s.created_at DESC LIMIT 1) rv ON true
      WHERE a.status = 'returned'
     UNION ALL
     SELECT a.id, a.case_no, a.county_id, a.status, a.priority, a.due_date, pu.username, ap.applicant_no, ap.name,
            'gis_officer', cl.at, cl.note, cu.username, NULL, NULL,
            (SELECT count(*) FROM lais.document d WHERE d.case_id = a.id AND d.review_status <> 'superseded')::int, t.task_no
       FROM apps a
       JOIN lais.applicant ap ON ap.id = a.applicant_id
       LEFT JOIN lais.app_user pu ON pu.id = a.assigned_processor_id
       JOIN lais.application_handoff h ON h.case_id = a.id
       JOIN lais.task t ON t.id = h.task_id AND t.status NOT IN ('completed', 'cancelled')
       JOIN LATERAL (SELECT e.at, e.note, e.actor_id FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'clarification_requested' ORDER BY e.id DESC LIMIT 1) cl ON true
       LEFT JOIN lais.app_user cu ON cu.id = cl.actor_id
      -- A clarification counts until the processor answers it with a comment on the task.
      WHERE NOT EXISTS (SELECT 1 FROM lais.task_event r WHERE r.task_id = t.id AND r.action = 'comment' AND r.at > cl.at AND r.actor_id = h.processor_id)
     ORDER BY returned_at DESC NULLS LAST`,
    [counties],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Registrar decision tracking (read-only: every value comes from the registrar's own records)
// ---------------------------------------------------------------------------

processorRouter.get('/decisions', async (req, res) => {
  const counties = resolveScope(req, 'case.view', z.object({ countyId: countyParam }).parse(req.query).countyId);
  const { rows } = await pool.query(
    `WITH ${APPS_CTE}
     SELECT a.id, a.case_no, co.code AS county_code, pp.upi AS parcel_upi, a.declared_parcel_ref, sub.at AS submitted_at,
            d.decision, d.decided_at, d.reason AS decision_summary, du.username AS registrar,
            sr.decision AS supervisor_decision, sr.created_at AS supervisor_at,
            CASE
              WHEN a.status = 'approved' OR a.status = 'published' THEN 'approved'
              WHEN a.status = 'rejected' THEN 'rejected'
              WHEN a.status = 'returned' AND d.decision = 'returned' AND d.decided_at >= coalesce(sub.at, d.decided_at) THEN 'returned_for_correction'
              WHEN a.status = 'under_review' AND sr.decision = 'info_requested' THEN 'additional_information_requested'
              WHEN a.status = 'under_review' AND EXISTS (SELECT 1 FROM staging.finding f JOIN staging.validation_run r ON r.id = f.run_id
                                                          WHERE r.case_id = a.id AND f.acknowledged_at > sub.at) THEN 'under_registrar_review'
              WHEN a.status IN ('validating', 'under_review') THEN 'awaiting_registrar_review'
              ELSE a.status END AS tracking_status, a.status
       FROM apps a
       JOIN lais.county co ON co.id = a.county_id
       LEFT JOIN lais.parcel pp ON pp.id = a.parcel_id
       LEFT JOIN LATERAL (SELECT e.at FROM lais.case_event e WHERE e.case_id = a.id AND e.action = 'submit' ORDER BY e.id DESC LIMIT 1) sub ON true
       LEFT JOIN LATERAL (SELECT x.decision, x.decided_at, x.reason, x.decided_by FROM lais.case_decision x WHERE x.case_id = a.id AND x.superseded_at IS NULL
                           ORDER BY x.decided_at DESC LIMIT 1) d ON true
       LEFT JOIN lais.app_user du ON du.id = d.decided_by
       LEFT JOIN LATERAL (SELECT s.decision, s.created_at FROM lais.supervisory_review s WHERE s.case_id = a.id ORDER BY s.created_at DESC LIMIT 1) sr ON true
      WHERE sub.at IS NOT NULL
      ORDER BY coalesce(d.decided_at, sub.at) DESC LIMIT 500`,
    [counties],
  );
  res.json({
    items: rows,
    labels: {
      awaiting_registrar_review: 'Awaiting Registrar review', under_registrar_review: 'Under Registrar review', additional_information_requested: 'Additional information requested',
      approved: 'Approved', rejected: 'Rejected', returned_for_correction: 'Returned for correction',
    },
    notice: 'Read-only. Decisions are made and recorded by the Land Registrar; processors cannot change them.',
  });
});

// ---------------------------------------------------------------------------
// GIS processing queue: the processor's handoffs and the state of their GIS tasks
// ---------------------------------------------------------------------------

processorRouter.get('/gis-queue', async (req, res) => {
  const counties = resolveScope(req, 'case.view', z.object({ countyId: countyParam }).parse(req.query).countyId);
  const { rows } = await pool.query(
    `SELECT h.id, h.handoff_no, h.created_at, h.task_type, h.priority, c.id AS case_id, c.case_no, c.status AS case_status, co.code AS county_code,
            t.id AS task_id, t.task_no, t.status AS task_status, t.due_date, gu.username AS gis_officer, pu.username AS processor,
            b.version_no, lr.error_count, lr.warning_count,
            (SELECT e.note FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'clarification_requested' ORDER BY e.id DESC LIMIT 1) AS last_clarification
       FROM lais.application_handoff h JOIN lais.land_case c ON c.id = h.case_id JOIN lais.county co ON co.id = c.county_id
       JOIN lais.task t ON t.id = h.task_id LEFT JOIN lais.app_user gu ON gu.id = t.assignee_id JOIN lais.app_user pu ON pu.id = h.processor_id
       LEFT JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active'
       LEFT JOIN LATERAL (SELECT error_count, warning_count FROM staging.validation_run r WHERE r.case_id = c.id ORDER BY run_at DESC LIMIT 1) lr ON true
      WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
      ORDER BY (t.status NOT IN ('completed', 'cancelled')) DESC, h.created_at DESC LIMIT 300`,
    [counties],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Analytics (charts) and reports
// ---------------------------------------------------------------------------

const filterQuery = z.object({
  countyId: countyParam, from: isoDate.optional(), to: isoDate.optional(),
  category: z.string().trim().max(41).optional(), stage: z.string().trim().max(40).optional(), processor: z.string().uuid().optional(),
});
interface Filters { counties: number[] | null; from: string; to: string; category: string | null; stage: string | null; processor: string | null }
// $2 and $3 (the period) are typed here, so reports that do not use them still bind.
const FILTERED = `WITH ${APPS_CTE}, f AS (SELECT * FROM apps WHERE $2::date <= $3::date AND ($4::text IS NULL OR category_code = $4) AND ($5::text IS NULL OR stage = $5) AND ($6::uuid IS NULL OR assigned_processor_id = $6))`;
const args = (f: Filters) => [f.counties, f.from, f.to, f.category, f.stage, f.processor];

function filters(req: Request) {
  const q = filterQuery.parse(req.query);
  const counties = resolveScope(req, 'reports.processing', q.countyId);
  const { from, to } = dateRange(q);
  return { counties, from, to, category: q.category || null, stage: q.stage || null, processor: q.processor ?? null } as Filters;
}

processorRouter.get('/analytics', async (req, res) => {
  const f = filters(req);
  const a = args(f);
  const [overTime, byCategory, byStage, missingDocs, requests, handoffs, returns, processing] = await Promise.all([
    pool.query(`${FILTERED} SELECT d::date AS day, (SELECT count(*) FROM f WHERE coalesce(f.submission_date, f.created_at::date) = d::date)::int AS registered
                 FROM generate_series($2::date, $3::date, '1 day') d ORDER BY d`, a),
    pool.query(`${FILTERED} SELECT coalesce(ac.label, f.category_code) AS label, count(*)::int AS count FROM f LEFT JOIN lais.application_category ac ON ac.code = f.category_code GROUP BY 1 ORDER BY 2 DESC`, a),
    pool.query(`${FILTERED} SELECT stage, count(*)::int AS count FROM f GROUP BY stage ORDER BY 2 DESC`, a),
    pool.query(`${FILTERED} SELECT s.label, count(*)::int AS count FROM f CROSS JOIN LATERAL lais.application_requirement_states(f.id) s
                 WHERE f.status IN ('draft', 'returned') AND s.kind = 'document' AND s.applies AND s.mandatory AND s.state = 'missing' GROUP BY s.label ORDER BY 2 DESC`, a),
    pool.query(`${FILTERED} SELECT CASE WHEN i.status IN ('pending', 'response_received', 'partially_satisfied') AND i.due_date < current_date THEN 'overdue' ELSE i.status END AS status,
                 count(*)::int AS count FROM lais.info_request i JOIN f ON f.id = i.case_id WHERE i.created_at::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, a),
    pool.query(`${FILTERED} SELECT d::date AS day, (SELECT count(*) FROM lais.application_handoff h JOIN f ON f.id = h.case_id WHERE h.created_at::date = d::date)::int AS handoffs
                 FROM generate_series($2::date, $3::date, '1 day') d ORDER BY d`, a),
    pool.query(`${FILTERED} SELECT CASE e.action WHEN 'validation_failed' THEN 'Validation' WHEN 'decide' THEN 'Registrar' WHEN 'supervisor_return' THEN 'Supervisor' ELSE 'Other' END AS source,
                 count(*)::int AS count FROM lais.case_event e JOIN f ON f.id = e.case_id WHERE e.to_status = 'returned' AND e.at::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, a),
    pool.query(`${FILTERED} SELECT round(avg(extract(epoch FROM (s.at - f.created_at)) / 86400)::numeric, 1) AS avg_days_to_submission, count(s.at)::int AS submitted,
                 (SELECT count(*) FROM f WHERE f.status IN ('validating', 'under_review'))::int AS awaiting_registrar
                 FROM f LEFT JOIN LATERAL (SELECT min(e.at) AS at FROM lais.case_event e WHERE e.case_id = f.id AND e.action = 'submit') s ON true
                 WHERE s.at::date BETWEEN $2 AND $3`, a),
  ]);
  res.json({
    range: { from: f.from, to: f.to }, registeredOverTime: overTime.rows, byCategory: byCategory.rows,
    byStage: byStage.rows.map((r) => ({ ...r, label: STAGE_LABELS[r.stage] ?? r.stage })), missingDocuments: missingDocs.rows, infoRequests: requests.rows,
    handoffsOverTime: handoffs.rows, returnsBySource: returns.rows, processing: processing.rows[0],
  });
});

type Col = { key: string; label: string };
const col = (key: string, label: string): Col => ({ key, label });
const REPORTS: Record<string, { title: string; description: string; columns: Col[]; sql: string }> = {
  registered: {
    title: 'Applications registered', description: 'Applications registered in the period (by submission date), without applicant contact details.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('category', 'Category'), col('submission_date', 'Submitted'), col('stage', 'Stage'), col('processor', 'Processor')],
    sql: `SELECT f.case_no, co.code AS county, coalesce(ac.label, f.category_code) AS category, coalesce(f.submission_date, f.created_at::date) AS submission_date, f.stage, u.username AS processor
            FROM f JOIN lais.county co ON co.id = f.county_id LEFT JOIN lais.application_category ac ON ac.code = f.category_code LEFT JOIN lais.app_user u ON u.id = f.assigned_processor_id
           WHERE coalesce(f.submission_date, f.created_at::date) BETWEEN $2 AND $3 ORDER BY 4`,
  },
  by_category: {
    title: 'Applications by category', description: 'Applications registered in the period, by category.',
    columns: [col('category', 'Category'), col('count', 'Applications')],
    sql: `SELECT coalesce(ac.label, f.category_code) AS category, count(*)::int AS count FROM f LEFT JOIN lais.application_category ac ON ac.code = f.category_code
           WHERE coalesce(f.submission_date, f.created_at::date) BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`,
  },
  by_status: {
    title: 'Applications by workflow stage', description: 'Current stage of every application in scope.',
    columns: [col('stage', 'Stage'), col('count', 'Applications')],
    sql: `SELECT f.stage, count(*)::int AS count FROM f GROUP BY 1 ORDER BY 2 DESC`,
  },
  incomplete: {
    title: 'Incomplete applications', description: 'Open applications whose configured requirements are not all met, with what is outstanding.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('completeness', 'Completeness'), col('outstanding', 'Outstanding'), col('processor', 'Processor')],
    sql: `SELECT f.case_no, co.code AS county, f.comp AS completeness,
                 (SELECT string_agg(s.label || ' (' || s.state || ')', '; ') FROM lais.application_requirement_states(f.id) s
                   WHERE s.applies AND s.mandatory AND s.state <> 'complete' AND cardinality(s.waived_for) = 0) AS outstanding, u.username AS processor
            FROM f JOIN lais.county co ON co.id = f.county_id LEFT JOIN lais.app_user u ON u.id = f.assigned_processor_id
           WHERE f.status IN ('draft', 'returned') AND f.comp IN ('incomplete', 'ready_for_review', 'awaiting_information', 'draft') ORDER BY f.case_no`,
  },
  missing_documents: {
    title: 'Missing documents by category', description: 'Required documents not yet received on open applications.',
    columns: [col('document', 'Document category'), col('count', 'Applications missing it')],
    sql: `SELECT s.label AS document, count(*)::int AS count FROM f CROSS JOIN LATERAL lais.application_requirement_states(f.id) s
           WHERE f.status IN ('draft', 'returned') AND s.kind = 'document' AND s.applies AND s.mandatory AND s.state = 'missing' GROUP BY 1 ORDER BY 2 DESC`,
  },
  info_requests: {
    title: 'Information requests', description: 'Requests created in the period and their status. "Not sent" means no provider was available; nothing was sent automatically.',
    columns: [col('request_no', 'Request'), col('case_no', 'Application'), col('category', 'Category'), col('channel', 'Channel'), col('delivery_status', 'Delivery'), col('status', 'Status'), col('due_date', 'Due'), col('created_at', 'Created')],
    sql: `SELECT i.request_no, f.case_no, i.category, i.channel, i.delivery_status, i.status, i.due_date, i.created_at
            FROM lais.info_request i JOIN f ON f.id = i.case_id WHERE i.created_at::date BETWEEN $2 AND $3 ORDER BY i.created_at`,
  },
  handoffs: {
    title: 'Applications handed off to GIS', description: 'GIS handoffs in the period and the state of their GIS tasks.',
    columns: [col('handoff_no', 'Handoff'), col('case_no', 'Application'), col('task_no', 'GIS task'), col('task_status', 'Task status'), col('gis_officer', 'GIS officer'), col('created_at', 'Handed off')],
    sql: `SELECT h.handoff_no, f.case_no, t.task_no, t.status AS task_status, u.username AS gis_officer, h.created_at
            FROM lais.application_handoff h JOIN f ON f.id = h.case_id JOIN lais.task t ON t.id = h.task_id LEFT JOIN lais.app_user u ON u.id = t.assignee_id
           WHERE h.created_at::date BETWEEN $2 AND $3 ORDER BY h.created_at`,
  },
  returns: {
    title: 'Applications returned for correction', description: 'Returns in the period by source (validation, supervisor, registrar).',
    columns: [col('case_no', 'Application'), col('source', 'Source'), col('at', 'Returned'), col('reason', 'Reason')],
    sql: `SELECT f.case_no, CASE e.action WHEN 'validation_failed' THEN 'validation' WHEN 'decide' THEN 'registrar' WHEN 'supervisor_return' THEN 'supervisor' ELSE 'other' END AS source,
                 e.at, e.note AS reason FROM lais.case_event e JOIN f ON f.id = e.case_id WHERE e.to_status = 'returned' AND e.at::date BETWEEN $2 AND $3 ORDER BY e.at`,
  },
  processing_time: {
    title: 'Administrative processing time', description: 'Days from registration to first submission for review, for applications submitted in the period.',
    columns: [col('case_no', 'Application'), col('registered', 'Registered'), col('submitted', 'First submitted'), col('days', 'Days (derived)')],
    sql: `SELECT f.case_no, f.created_at AS registered, s.at AS submitted, round((extract(epoch FROM (s.at - f.created_at)) / 86400)::numeric, 1) AS days
            FROM f JOIN LATERAL (SELECT min(e.at) AS at FROM lais.case_event e WHERE e.case_id = f.id AND e.action = 'submit') s ON s.at IS NOT NULL
           WHERE s.at::date BETWEEN $2 AND $3 ORDER BY s.at`,
  },
  awaiting_registrar: {
    title: 'Applications awaiting a Registrar decision', description: 'Submitted applications without a decision yet.',
    columns: [col('case_no', 'Application'), col('county', 'County'), col('category', 'Category'), col('submitted', 'Submitted')],
    sql: `SELECT f.case_no, co.code AS county, coalesce(ac.label, f.category_code) AS category,
                 (SELECT max(e.at) FROM lais.case_event e WHERE e.case_id = f.id AND e.action = 'submit') AS submitted
            FROM f JOIN lais.county co ON co.id = f.county_id LEFT JOIN lais.application_category ac ON ac.code = f.category_code
           WHERE f.status IN ('validating', 'under_review') ORDER BY 4`,
  },
};

processorRouter.get('/reports', (req, res) => {
  resolveScope(req, 'reports.processing');
  res.json(Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description })));
});

async function generate(req: Request, key: string, format: 'json' | 'csv' | 'pdf') {
  const def = REPORTS[key];
  if (!def) throw notFound('Unknown report');
  const f = filters(req);
  const { rows } = await pool.query(`${FILTERED} ${def.sql}`, args(f));
  const { rows: [scope] } = await pool.query(`SELECT string_agg(code, ', ' ORDER BY code) AS codes FROM lais.county WHERE $1::smallint[] IS NULL OR id = ANY($1)`, [f.counties]);
  const report = {
    reportId: randomUUID(), key, title: def.title, description: def.description, generatedAt: new Date().toISOString(), generatedBy: req.auth!.user.username,
    scope: f.counties === null ? 'All counties' : scope.codes, filters: { from: f.from, to: f.to, category: f.category, stage: f.stage, processor: f.processor },
    dataNotice: 'Research prototype: synthetic demonstration data, not real land records.', columns: def.columns,
    rows: rows.map((r) => ('stage' in r ? { ...r, stage: STAGE_LABELS[r.stage] ?? r.stage } : r)),
  };
  await writeAudit(req, { action: 'report.processing', outcome: 'success', entityType: 'report', entityId: key, detail: { reportId: report.reportId, format, rows: rows.length, filters: report.filters, scope: report.scope } });
  return report;
}
const meta = (r: Awaited<ReturnType<typeof generate>>) => [
  `Report ${r.reportId}, generated ${r.generatedAt} by ${r.generatedBy}`,
  `Scope: ${r.scope}; period ${r.filters.from} to ${r.filters.to}${r.filters.category ? `; category ${r.filters.category}` : ''}${r.filters.stage ? `; stage ${r.filters.stage}` : ''}${r.filters.processor ? '; one processor' : ''}`,
  r.description, r.dataNotice,
];

processorRouter.get('/reports/:key.csv', async (req, res) => {
  const r = await generate(req, req.params.key, 'csv');
  const lines = [`# ${r.title}`, ...meta(r).map((m) => `# ${m}`), r.columns.map((c) => csvCell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => csvCell((row as Record<string, unknown>)[c.key])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lais-processing-${r.key}-${r.filters.from}-${r.filters.to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

processorRouter.get('/reports/:key.pdf', async (req, res) => {
  const r = await generate(req, req.params.key, 'pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="lais-processing-${r.key}-${r.filters.from}-${r.filters.to}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(tablePdf({ title: r.title, meta: meta(r), columns: r.columns, rows: r.rows as Record<string, unknown>[] }));
});

processorRouter.get('/reports/:key', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await generate(req, req.params.key, 'json'));
});

documentQuery('GET /processor/summary', summaryQuery);
documentQuery(['GET /processor/analytics', 'GET /processor/reports/{key}', 'GET /processor/reports/{key}.csv', 'GET /processor/reports/{key}.pdf'], filterQuery);
