import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { getCase } from '../services/cases.js';
import { latestRun } from '../services/validation.js';
import { notifyUsers } from '../services/notify.js';
import { CONFLICTS_SQL, CONFLICT_STATUSES, OPEN_CONFLICT_STATUSES } from '../services/conflicts.js';
import { ACCEPTED_SQL, CASE_JOINS, assertEligibleAssignee, resolveScope } from '../services/supervision.js';
import { documentBody, documentQuery } from '../openapi.js';

/** GIS quality review of submitted geometry, and spatial conflict review. Mounted at /supervision. */
export const supervisionReviewRouter = Router();

const countyParam = z.coerce.number().int().positive().optional();
const pageParams = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), 'Page size must be 10, 25, 50 or 100').default(25),
};

/** How findings are grouped in a review. Codes not listed fall under "other checks". */
const FINDING_GROUPS: Record<string, string[]> = {
  geometry: ['GEOMETRY_INVALID', 'NO_GEOMETRY', 'AXIS_ORDER_SWAPPED_SUSPECTED', 'AREA_UNUSUALLY_SMALL', 'FEATURE_COUNT', 'NON_CONTIGUOUS_CONSOLIDATION'],
  spatial_conflicts: ['OVERLAP_PUBLISHED_PARCEL', 'NEW_PARCELS_OVERLAP', 'MIGRATION_INTERNAL_OVERLAP', 'DUPLICATE_GEOMETRY_SUSPECTED', 'CONFLICTING_OPEN_SUBMISSION', 'COVERAGE_GAP', 'COVERAGE_EXCEEDS_SOURCE', 'SIGNIFICANT_BOUNDARY_CHANGE'],
  boundary: ['OUTSIDE_CASE_COUNTY', 'CROSSES_COUNTY_BOUNDARY', 'OUTSIDE_NATIONAL_EXTENT'],
  identifiers: ['UPI_FORMAT_INVALID', 'DUPLICATE_UPI', 'UPI_IN_OTHER_OPEN_CASE', 'DUPLICATE_LEGACY_REF', 'ALREADY_MIGRATED', 'PARCEL_IN_OTHER_OPEN_CASE'],
  attributes: ['LAND_CATEGORY_MISSING', 'SOURCE_REFERENCE_MISSING', 'LEGACY_ATTRIBUTE_INVALID', 'CATEGORY_CHANGE', 'MIXED_SOURCE_CATEGORIES', 'CORRECTION_REASON_MISSING', 'NO_CHANGE'],
  completeness: ['MISSING_SURVEY_PLAN', 'MISSING_EVIDENCE_OF_INTEREST', 'MISSING_TRANSFER_DEED', 'MISSING_MIGRATION_SOURCE', 'MISSING_CORRECTION_EVIDENCE', 'DOCUMENT_PENDING_VERIFICATION', 'DOCUMENT_REJECTED', 'NO_PROPOSED_RIGHTS', 'PARTY_IDENTITY_UNVERIFIED'],
};
const groupOf = (code: string) => Object.entries(FINDING_GROUPS).find(([, codes]) => codes.includes(code))?.[0] ?? 'other';
const OVERLAP_CODES = ['OVERLAP_PUBLISHED_PARCEL', 'NEW_PARCELS_OVERLAP', 'MIGRATION_INTERNAL_OVERLAP', 'DUPLICATE_GEOMETRY_SUSPECTED', 'CONFLICTING_OPEN_SUBMISSION'];

/** Attributes from imported files that may carry personal data are not shown in the record inspector. */
const PERSONAL_KEY = /holder|owner|name|national|id_?no|phone|contact|email|address/i;
const permittedProperties = (props: Record<string, unknown> | null) =>
  Object.fromEntries(Object.entries(props ?? {}).filter(([k]) => !PERSONAL_KEY.test(k)));

// ---------------------------------------------------------------------------
// GIS quality review queue
// ---------------------------------------------------------------------------

const REVIEW_STATUSES = ['awaiting_review', 'accepted', 'returned', 'returned_by_validation', 'not_submitted', 'decided'] as const;
const gisQueueQuery = z.object({
  countyId: countyParam,
  status: z.enum(REVIEW_STATUSES).optional(),
  q: z.string().trim().max(60).optional(),
  ...pageParams,
});

supervisionReviewRouter.get('/gis-reviews', async (req, res) => {
  const q = gisQueueQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const { rows } = await pool.query(
    `WITH subs AS (
       SELECT c.id AS case_id, c.case_no, c.case_type, c.status AS case_status, c.county_id, co.code AS county_code,
              b.id AS batch_id, b.source_filename, b.declared_srid, b.feature_count, b.created_at AS imported_at,
              u.username AS gis_officer, sub.at AS submitted_at,
              lr.id AS run_id, lr.run_at, lr.error_count, lr.warning_count, rv.decision AS last_review, rv.created_at AS last_review_at,
              coalesce(${ACCEPTED_SQL}, false) AS accepted,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND NOT f.excluded AND f.structural_ok
                  AND NOT EXISTS (SELECT 1 FROM staging.finding x WHERE x.run_id = lr.id AND x.severity = 'error' AND x.feature_index = f.feature_index)) AS valid_records,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND NOT f.excluded AND (NOT f.structural_ok
                  OR EXISTS (SELECT 1 FROM staging.finding x WHERE x.run_id = lr.id AND x.severity = 'error' AND x.feature_index = f.feature_index))) AS invalid_records,
              (SELECT count(*)::int FROM staging.feature f WHERE f.batch_id = b.id AND f.excluded) AS excluded_records,
              (SELECT count(*)::int FROM staging.finding x WHERE x.run_id = lr.id AND x.code = ANY($2)) AS potential_conflicts
         FROM staging.batch b
         JOIN lais.land_case c ON c.id = b.case_id
         JOIN lais.county co ON co.id = c.county_id
         JOIN lais.app_user u ON u.id = b.uploaded_by
         ${CASE_JOINS}
         LEFT JOIN LATERAL (SELECT max(e.at) AS at FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = 'validating') sub ON true
        WHERE b.status IN ('active', 'published') AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
     ), q AS (
       SELECT s.*,
              CASE WHEN s.case_status = 'under_review' AND s.accepted THEN 'accepted'
                   WHEN s.case_status = 'under_review' THEN 'awaiting_review'
                   WHEN s.case_status = 'returned' AND s.last_review = 'returned' THEN 'returned'
                   WHEN s.case_status = 'returned' THEN 'returned_by_validation'
                   WHEN s.case_status IN ('draft', 'validating') THEN 'not_submitted'
                   ELSE 'decided' END AS review_status,
              CASE WHEN s.run_id IS NULL THEN 'not_validated' WHEN s.error_count > 0 THEN 'failed' WHEN s.warning_count > 0 THEN 'passed_with_warnings' ELSE 'passed' END AS validation_status
         FROM subs s
     )
     SELECT q.*, count(*) OVER () AS total FROM q
      WHERE ($3::text IS NULL OR q.review_status = $3) AND ($4::text IS NULL OR q.case_no ILIKE '%' || $4 || '%' OR q.source_filename ILIKE '%' || $4 || '%')
      ORDER BY (q.review_status = 'awaiting_review') DESC, coalesce(q.submitted_at, q.imported_at) DESC
      LIMIT $5 OFFSET $6`,
    [counties, OVERLAP_CODES, q.status ?? null, q.q || null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  res.json({ items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize });
});

supervisionReviewRouter.get('/gis-reviews/:caseId', async (req, res) => {
  const cs = await getCase(pool, parseId(req.params.caseId));
  enforce(req, 'supervision.view', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
  const counties = resolveScope(req, 'supervision.view');
  const { rows: [batch] } = await pool.query(
    `SELECT b.id, b.source_filename, b.file_sha256, b.declared_srid, b.feature_count, b.status, b.created_at, u.username AS uploaded_by
       FROM staging.batch b JOIN lais.app_user u ON u.id = b.uploaded_by
      WHERE b.case_id = $1 AND b.status IN ('active', 'published') ORDER BY b.created_at DESC LIMIT 1`,
    [cs.id],
  );
  const latest = await latestRun(pool, cs.id);
  const [features, history, events, county, references, overlaps] = await Promise.all([
    batch
      ? pool.query(
          `SELECT f.feature_index, f.properties, f.structural_ok, f.structural_message, f.excluded, f.exclusion_reason,
                  ST_AsGeoJSON(coalesce(f.geom, ST_Transform(f.geom_input, 4326)), 7)::json AS geometry,
                  CASE WHEN f.geom IS NOT NULL THEN round(ST_Area(f.geom::geography)::numeric, 2) END AS area_m2,
                  CASE WHEN f.geom IS NOT NULL THEN GeometryType(f.geom) END AS geometry_type
             FROM staging.feature f WHERE f.batch_id = $1 ORDER BY f.feature_index`,
          [batch.id],
        )
      : { rows: [] },
    // Every submission of this case with the outcome of its validation runs: the correction history.
    pool.query(
      `SELECT b.id, b.source_filename, b.status, b.created_at, b.feature_count, u.username AS uploaded_by,
              coalesce((SELECT json_agg(json_build_object('id', r.id, 'runAt', r.run_at, 'purpose', r.purpose, 'errors', r.error_count, 'warnings', r.warning_count) ORDER BY r.run_at)
                          FROM staging.validation_run r WHERE r.batch_id = b.id), '[]') AS runs
         FROM staging.batch b JOIN lais.app_user u ON u.id = b.uploaded_by WHERE b.case_id = $1 ORDER BY b.created_at`,
      [cs.id],
    ),
    pool.query(
      `SELECT e.action, e.from_status, e.to_status, e.note, e.at, u.username AS actor
         FROM lais.case_event e LEFT JOIN lais.app_user u ON u.id = e.actor_id WHERE e.case_id = $1 ORDER BY e.id`,
      [cs.id],
    ),
    pool.query(
      `SELECT id, name, boundary_status, boundary_source,
              CASE WHEN geom IS NOT NULL THEN ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0005), 6)::json END AS geometry
         FROM lais.county WHERE id = $1`,
      [cs.county_id],
    ),
    // Published reference parcels: those the findings point at, and those the case replaces (in scope only).
    pool.query(
      `SELECT p.id, p.upi, p.status, ST_AsGeoJSON(v.geom, 7)::json AS geometry
         FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
        WHERE ($3::smallint[] IS NULL OR p.county_id = ANY($3))
          AND (p.id IN (SELECT related_parcel_id FROM staging.finding WHERE run_id = $2)
               OR p.id IN (SELECT parcel_id FROM lais.case_source_parcel WHERE case_id = $1) OR p.id = (SELECT parcel_id FROM lais.land_case WHERE id = $1))`,
      [cs.id, latest?.run.id ?? null, counties],
    ),
    // The overlapping area itself, measured geodesically (m²), for overlap findings with a published parcel.
    latest && batch
      ? pool.query(
          `SELECT x.id AS finding_id, x.code, x.feature_index, p.upi,
                  ST_AsGeoJSON(ST_Intersection(f.geom, v.geom), 7)::json AS geometry,
                  round(ST_Area(ST_Intersection(f.geom, v.geom)::geography)::numeric, 2) AS area_m2
             FROM staging.finding x
             JOIN staging.feature f ON f.batch_id = $2 AND f.feature_index = x.feature_index AND f.geom IS NOT NULL
             JOIN lais.parcel p ON p.id = x.related_parcel_id
             JOIN lais.parcel_version v ON v.id = p.current_version_id
            WHERE x.run_id = $1 AND x.code IN ('OVERLAP_PUBLISHED_PARCEL', 'DUPLICATE_GEOMETRY_SUSPECTED')`,
          [latest.run.id, batch.id],
        )
      : { rows: [] },
  ]);
  type FindingRow = { code: string; severity: string; feature_index: number | null };
  const findings = (latest?.findings ?? []).map((f: FindingRow) => ({ ...f, group: groupOf(f.code) }));
  res.json({
    case: { id: cs.id, caseNo: cs.case_no, caseType: cs.case_type, status: cs.status, countyId: cs.county_id },
    submission: batch ? { ...batch, sourceCrs: `EPSG:${batch.declared_srid}`, targetCrs: 'EPSG:4326 (stored); areas measured geodesically' } : null,
    validation: latest ? { run: latest.run, findings, summary: summarize(findings) } : null,
    records: features.rows.map((f) => {
      const own = findings.filter((x) => x.feature_index === f.feature_index);
      return { ...f, properties: permittedProperties(f.properties), errors: own.filter((x) => x.severity === 'error').length, warnings: own.filter((x) => x.severity === 'warning').length };
    }),
    county: county.rows[0],
    references: references.rows,
    overlaps: overlaps.rows,
    history: history.rows,
    events: events.rows,
  });
});

function summarize(findings: { group: string; severity: string }[]) {
  const groups = [...Object.keys(FINDING_GROUPS), 'other'];
  return groups.map((g) => ({
    group: g,
    errors: findings.filter((f) => f.group === g && f.severity === 'error').length,
    warnings: findings.filter((f) => f.group === g && f.severity === 'warning').length,
  }));
}

// ---------------------------------------------------------------------------
// Spatial conflict review
// ---------------------------------------------------------------------------

const conflictQuery = z.object({
  countyId: countyParam,
  status: z.union([z.enum(CONFLICT_STATUSES), z.literal('unresolved')]).default('unresolved'),
  category: z.string().max(40).optional(),
  severity: z.enum(['error', 'warning']).optional(),
  q: z.string().trim().max(60).optional(),
  ...pageParams,
});

supervisionReviewRouter.get('/conflicts', async (req, res) => {
  const q = conflictQuery.parse(req.query);
  const counties = resolveScope(req, 'supervision.view', q.countyId);
  const statuses = q.status === 'unresolved' ? OPEN_CONFLICT_STATUSES : [q.status];
  const { rows } = await pool.query(
    `SELECT x.*, count(*) OVER () AS total FROM (${CONFLICTS_SQL}) x
      WHERE x.review_status = ANY($2) AND ($3::text IS NULL OR x.category = $3) AND ($4::text IS NULL OR x.severity = $4)
        AND ($5::text IS NULL OR x.case_no ILIKE '%' || $5 || '%' OR x.related_upi ILIKE '%' || $5 || '%' OR x.case_parcel_upi ILIKE '%' || $5 || '%')
      ORDER BY x.detected_at DESC LIMIT $6 OFFSET $7`,
    [counties, statuses, q.category ?? null, q.severity ?? null, q.q || null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const { rows: categories } = await pool.query('SELECT DISTINCT category, label FROM lais.conflict_rule ORDER BY label');
  res.json({ items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize, categories });
});

/** Loads a conflict (any occurrence id) after checking the caller may see its county. */
async function loadConflict(req: Request, findingId: string) {
  const { rows: [f] } = await pool.query(
    `SELECT f.id, f.code, f.related_parcel_id, f.related_case_id, f.feature_index, r.case_id, c.county_id
       FROM staging.finding f JOIN staging.validation_run r ON r.id = f.run_id JOIN lais.land_case c ON c.id = r.case_id
       JOIN lais.conflict_rule cr ON cr.code = f.code WHERE f.id = $1`,
    [findingId],
  );
  if (!f) throw notFound('Conflict not found');
  enforce(req, 'supervision.view', { countyId: f.county_id }, { entityType: 'finding', entityId: f.id, caseId: f.case_id });
  const { rows: [conflictRow] } = await pool.query(
    `SELECT * FROM (${CONFLICTS_SQL}) x
      WHERE x.case_id = $2 AND x.code = $3 AND x.related_parcel_id IS NOT DISTINCT FROM $4
        AND x.related_case_id IS NOT DISTINCT FROM $5 AND x.feature_index IS NOT DISTINCT FROM $6`,
    [[f.county_id], f.case_id, f.code, f.related_parcel_id, f.related_case_id, f.feature_index],
  );
  return conflictRow;
}

supervisionReviewRouter.get('/conflicts/:findingId', async (req, res) => {
  const c = await loadConflict(req, parseId(req.params.findingId));
  const key = [c.case_id, c.code, c.related_parcel_id, c.related_case_id, c.feature_index];
  const sameIssue = `f.code = $2 AND f.related_parcel_id IS NOT DISTINCT FROM $3 AND f.related_case_id IS NOT DISTINCT FROM $4 AND f.feature_index IS NOT DISTINCT FROM $5`;
  const [occurrences, events, tasks, escalations, geometry] = await Promise.all([
    pool.query(
      `SELECT f.id, f.severity, f.message, f.detail, r.run_at, r.purpose, f.acknowledged_at, f.acknowledgement_note
         FROM staging.finding f JOIN staging.validation_run r ON r.id = f.run_id WHERE r.case_id = $1 AND ${sameIssue} ORDER BY r.run_at`,
      key,
    ),
    pool.query(
      `SELECT e.id, e.action, e.note, e.at, u.username AS actor, t.task_no, x.escalation_no
         FROM lais.conflict_review_event e JOIN staging.finding f ON f.id = e.finding_id JOIN lais.app_user u ON u.id = e.actor_id
         LEFT JOIN lais.task t ON t.id = e.task_id LEFT JOIN lais.escalation x ON x.id = e.escalation_id
        WHERE e.case_id = $1 AND ${sameIssue} ORDER BY e.id`,
      key,
    ),
    pool.query(
      `SELECT t.id, t.task_no, t.task_type, t.status, t.due_date, u.username AS assignee, t.completion_note
         FROM lais.task t JOIN staging.finding f ON f.id = t.finding_id LEFT JOIN lais.app_user u ON u.id = t.assignee_id
        WHERE t.case_id = $1 AND ${sameIssue} ORDER BY t.created_at`,
      key,
    ),
    pool.query(
      `SELECT x.id, x.escalation_no, x.status, x.severity, x.responsible_role, x.created_at, x.closure_reason
         FROM lais.escalation x JOIN staging.finding f ON f.id = x.finding_id WHERE x.case_id = $1 AND ${sameIssue} ORDER BY x.created_at`,
      key,
    ),
    // Evidence on the map: the submitted feature, the related published parcel, and their intersection.
    pool.query(
      `SELECT ST_AsGeoJSON(coalesce(sf.geom, ST_Transform(sf.geom_input, 4326)), 7)::json AS feature,
              ST_AsGeoJSON(v.geom, 7)::json AS related_parcel,
              CASE WHEN sf.geom IS NOT NULL AND v.geom IS NOT NULL THEN ST_AsGeoJSON(ST_Intersection(sf.geom, v.geom), 7)::json END AS intersection,
              CASE WHEN sf.geom IS NOT NULL AND v.geom IS NOT NULL THEN round(ST_Area(ST_Intersection(sf.geom, v.geom)::geography)::numeric, 2) END AS intersection_m2,
              CASE WHEN sf.geom IS NOT NULL THEN round(ST_Area(sf.geom::geography)::numeric, 2) END AS feature_m2
         FROM staging.finding x
         LEFT JOIN staging.feature sf ON sf.batch_id = $2 AND sf.feature_index = coalesce(x.feature_index, 0)
         LEFT JOIN lais.parcel p ON p.id = x.related_parcel_id
         LEFT JOIN lais.parcel_version v ON v.id = p.current_version_id
        WHERE x.id = $1`,
      [c.id, c.batch_id],
    ),
  ]);
  res.json({ conflict: c, occurrences: occurrences.rows, events: events.rows, tasks: tasks.rows, escalations: escalations.rows, evidence: geometry.rows[0] ?? null });
});

const conflictActionBody = z.object({
  action: z.enum(['note', 'investigation_assigned', 'gis_check_requested']),
  note: z.string().trim().min(5).max(2000),
  assigneeId: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Records what a supervisor did about a conflict: a review note, or an investigation / GIS check assigned
 * as a task. There is no action that resolves or dismisses a conflict: that takes a registrar's
 * acknowledgement, or corrected data that no longer triggers the rule.
 */
supervisionReviewRouter.post('/conflicts/:findingId/actions', async (req, res) => {
  const body = conflictActionBody.parse(req.body);
  const c = await loadConflict(req, parseId(req.params.findingId));
  const result = await tx(async (client) => {
    enforce(req, 'conflict.review', { countyId: c.county_id }, { entityType: 'finding', entityId: c.id, caseId: c.case_id });
    let task: { id: string; task_no: string } | null = null;
    if (body.action !== 'note') {
      if (!['new', 'investigating', 'awaiting_correction', 'escalated'].includes(c.review_status)) throw conflict('This conflict is already resolved or closed');
      if (!body.assigneeId) throw conflict('Choose who should carry out the work');
      const taskType = body.action === 'gis_check_requested' ? 'gis_validation_correction' : 'conflict_investigation';
      await assertEligibleAssignee(client, body.assigneeId, taskType, c.county_id);
      const cs = await getCase(client, c.case_id);
      ({ rows: [task] } = await client.query<{ id: string; task_no: string }>(
        `INSERT INTO lais.task (task_type, title, description, county_id, case_id, batch_id, finding_id, assignee_id, status, priority, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned', $9, $10, $11) RETURNING id, task_no`,
        [taskType, `${body.action === 'gis_check_requested' ? 'GIS check' : 'Investigate'}: ${c.category_label} on ${c.case_no}`, body.note,
          c.county_id, c.case_id, c.batch_id, c.id, body.assigneeId, cs.priority, body.dueDate ?? null, req.auth!.user.id],
      ));
      await client.query(
        `INSERT INTO lais.task_event (task_id, actor_id, action, to_value, note) VALUES ($1, $2, 'created', $3, 'Created from a conflict review')`,
        [task!.id, req.auth!.user.id, body.assigneeId],
      );
      await notifyUsers(client, [body.assigneeId], { category: 'task', title: `New task ${task!.task_no}: ${c.category_label} on ${c.case_no}`, body: body.note.slice(0, 200), link: '/work/tasks' });
    }
    const { rows: [event] } = await client.query(
      `INSERT INTO lais.conflict_review_event (finding_id, case_id, action, note, task_id, actor_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.id, c.case_id, body.action, body.note, task?.id ?? null, req.auth!.user.id],
    );
    await writeAudit(req, {
      action: `conflict.${body.action}`, outcome: 'success', entityType: 'finding', entityId: c.id, caseId: c.case_id, countyId: c.county_id,
      detail: { code: c.code, eventId: event.id, taskId: task?.id ?? null },
    }, client);
    return { eventId: event.id, task };
  });
  res.status(201).json(result);
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /supervision/gis-reviews', gisQueueQuery);
documentQuery('GET /supervision/conflicts', conflictQuery);
documentBody('POST /supervision/conflicts/{findingId}/actions', conflictActionBody);
