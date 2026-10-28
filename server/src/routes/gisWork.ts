import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { EDITABLE_STATUSES, SPATIAL_CASE_TYPES } from '../authz/workflow.js';
import { caseContext, getCase, inCaseTx, recordEvent } from '../services/cases.js';
import { evaluateCase, persistRun } from '../services/validation.js';
import { copyVersion, versionHash } from '../services/staging.js';
import { CONFLICTS_SQL, OPEN_CONFLICT_STATUSES, conflictDetail, conflictRow, findConflictOccurrence } from '../services/conflicts.js';
import { dateRange, resolveScope } from '../services/supervision.js';
import { submitCase } from './cases.js';
import { csvCell } from '../csv.js';
import { tablePdf } from '../services/pdf.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * GIS officer work on the data of a case: working versions and their comparison, attribute corrections
 * (always a new version), the submission checklist, submissions and returns, conflict investigation,
 * the validation center (with administrator-configured rule severities) and GIS reports.
 */
export const gisWorkRouter = Router();

const countyParam = z.coerce.number().int().positive().optional();

async function viewCase(req: Request, caseId: string) {
  const cs = await getCase(pool, caseId);
  enforce(req, 'gis.workspace', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
  return cs;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

gisWorkRouter.get('/cases/:id/versions', async (req, res) => {
  const cs = await viewCase(req, parseId(req.params.id));
  const { rows } = await pool.query(
    `SELECT b.id, b.version_no, b.status, b.source_kind, b.source_filename, b.declared_srid, b.feature_count, b.change_reason, b.created_at,
            u.username AS created_by, j.job_no, j.id AS job_id, pb.version_no AS parent_version,
            (SELECT count(*) FROM staging.feature f WHERE f.batch_id = b.id AND f.excluded)::int AS excluded_count,
            (SELECT count(*) FROM staging.feature f WHERE f.batch_id = b.id AND NOT f.structural_ok)::int AS invalid_count,
            (SELECT json_agg(json_build_object('submissionNo', s.submission_no, 'id', s.id, 'at', s.created_at, 'outcome', s.outcome) ORDER BY s.created_at)
               FROM staging.submission s WHERE s.batch_id = b.id) AS submissions
       FROM staging.batch b JOIN lais.app_user u ON u.id = b.uploaded_by
       LEFT JOIN staging.import_job j ON j.id = b.job_id LEFT JOIN staging.batch pb ON pb.id = b.parent_batch_id
      WHERE b.case_id = $1 ORDER BY b.version_no DESC`,
    [cs.id],
  );
  res.json({ caseNo: cs.case_no, caseStatus: cs.status, editable: (EDITABLE_STATUSES as readonly string[]).includes(cs.status), versions: rows });
});

async function versionOf(caseId: string, versionNo: number) {
  const { rows: [b] } = await pool.query('SELECT id, version_no, declared_srid FROM staging.batch WHERE case_id = $1 AND version_no = $2', [caseId, versionNo]);
  if (!b) throw notFound(`Version ${versionNo} does not exist for this case`);
  return b as { id: string; version_no: number; declared_srid: number };
}

async function versionFeatures(batchId: string) {
  const { rows } = await pool.query(
    `SELECT feature_index, properties, excluded, exclusion_reason, structural_ok, structural_message,
            ST_AsGeoJSON(coalesce(geom, ST_Transform(geom_input, 4326)), 7)::json AS geometry,
            encode(ST_AsEWKB(geom_input), 'hex') AS wkb,
            CASE WHEN geom IS NOT NULL THEN round(ST_Area(geom::geography)::numeric, 2) END AS area_m2
       FROM staging.feature WHERE batch_id = $1 ORDER BY feature_index`,
    [batchId],
  );
  return rows;
}

gisWorkRouter.get('/cases/:id/versions/:versionNo/features', async (req, res) => {
  const cs = await viewCase(req, parseId(req.params.id));
  const v = await versionOf(cs.id, Number(req.params.versionNo));
  const features = await versionFeatures(v.id);
  res.json({
    type: 'FeatureCollection', version: v.version_no, srid: v.declared_srid,
    features: features.map(({ geometry, wkb: _w, ...p }) => ({ type: 'Feature', geometry, properties: p })),
  });
});

const compareQuery = z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() });

/** Compares two versions feature by feature (matched by position): geometry, attributes and exclusion. */
gisWorkRouter.get('/cases/:id/versions/compare', async (req, res) => {
  const q = compareQuery.parse(req.query);
  const cs = await viewCase(req, parseId(req.params.id));
  const [va, vb] = await Promise.all([versionOf(cs.id, q.a), versionOf(cs.id, q.b)]);
  const [fa, fb] = await Promise.all([versionFeatures(va.id), versionFeatures(vb.id)]);
  const byIndex = new Map<number, { a?: (typeof fa)[number]; b?: (typeof fb)[number] }>();
  for (const f of fa) byIndex.set(f.feature_index, { a: f });
  for (const f of fb) byIndex.set(f.feature_index, { ...byIndex.get(f.feature_index), b: f });
  const { rows: moved } = await pool.query(
    `SELECT a.feature_index, round(ST_HausdorffDistance(ST_Transform(a.geom, 32629), ST_Transform(b.geom, 32629))::numeric, 2) AS max_shift_m
       FROM staging.feature a JOIN staging.feature b ON b.batch_id = $2 AND b.feature_index = a.feature_index
      WHERE a.batch_id = $1 AND a.geom IS NOT NULL AND b.geom IS NOT NULL AND NOT ST_Equals(a.geom, b.geom)`,
    [va.id, vb.id],
  );
  const shift = new Map(moved.map((m) => [m.feature_index, Number(m.max_shift_m)]));
  const changes = [...byIndex.entries()].sort(([x], [y]) => x - y).map(([index, { a, b }]) => {
    const keys = [...new Set([...Object.keys(a?.properties ?? {}), ...Object.keys(b?.properties ?? {})])];
    const attributes = keys.filter((k) => JSON.stringify(a?.properties?.[k]) !== JSON.stringify(b?.properties?.[k]))
      .map((k) => ({ field: k, from: a?.properties?.[k] ?? null, to: b?.properties?.[k] ?? null }));
    const geometryChanged = !!a && !!b && a.wkb !== b.wkb;
    return {
      featureIndex: index,
      change: !a ? 'added' : !b ? 'removed' : geometryChanged || attributes.length || a.excluded !== b.excluded ? 'modified' : 'unchanged',
      geometryChanged, maxShiftM: shift.get(index) ?? null,
      areaFrom: a?.area_m2 ?? null, areaTo: b?.area_m2 ?? null,
      excludedFrom: a?.excluded ?? null, excludedTo: b?.excluded ?? null, attributes,
    };
  });
  const fc = (rows: typeof fa) => ({ type: 'FeatureCollection', features: rows.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: { feature_index: f.feature_index, excluded: f.excluded } })) });
  res.json({
    a: q.a, b: q.b, changes,
    summary: Object.fromEntries(['added', 'removed', 'modified', 'unchanged'].map((k) => [k, changes.filter((c) => c.change === k).length])),
    geometry: { a: fc(fa), b: fc(fb) },
  });
});

const correctionBody = z.object({
  reason: z.string().trim().min(10).max(1000),
  changes: z.array(z.object({
    featureIndex: z.number().int().min(0),
    set: z.record(z.string().regex(/^[A-Za-z_]\w{0,59}$/), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
  })).min(1).max(500),
});

/**
 * Corrects feature attributes by creating a NEW working version from the current one. Geometry is copied
 * exactly; earlier versions, and any submitted snapshot, stay unchanged.
 */
gisWorkRouter.post('/cases/:id/corrections', async (req, res) => {
  const body = correctionBody.parse(req.body);
  const result = await inCaseTx(req, 'case.import_geometry', async (client, cs) => {
    const { rows: [active] } = await client.query(`SELECT id, version_no, declared_srid, source_filename, file_sha256 FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
    if (!active) throw conflict('The case has no working version to correct');
    const byIndex = new Map(body.changes.map((c) => [c.featureIndex, c.set]));
    const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM staging.feature WHERE batch_id = $1 AND feature_index = ANY($2)', [active.id, [...byIndex.keys()]]);
    if (n !== byIndex.size) throw badRequest('One or more feature numbers do not exist in the current version');
    const { rows: [job] } = await client.query(
      `INSERT INTO staging.import_job (kind, status, county_id, case_id, initiated_by, purpose, source_name, source_format, source_sha256,
                                       source_crs_detected, source_crs_declared, records_received, started_at)
       VALUES ('correction', 'running', $1, $2, $3, $4, $5, 'working_copy', $6, $7, $7, $8, now()) RETURNING id, job_no`,
      [cs.county_id, cs.id, req.auth!.user.id, body.reason, `Version ${active.version_no} (attribute correction)`, active.file_sha256, active.declared_srid, byIndex.size],
    );
    const copy = await copyVersion(client, cs, active.id, req.auth!.user.id, body.reason, (f) => {
      const set = byIndex.get(f.feature_index);
      return set ? { properties: { ...f.properties, ...set } } : null;
    }, job.id);
    await client.query(
      `UPDATE staging.import_job SET status = 'completed', batch_id = $2, records_accepted = $3, records_updated = $3, records_inserted = 0,
              records_unchanged = $4, records_rejected = 0, finished_at = now() WHERE id = $1`,
      [job.id, copy.batchId, copy.changed, (await client.query('SELECT feature_count FROM staging.batch WHERE id = $1', [copy.batchId])).rows[0].feature_count - copy.changed],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'import_geometry', `Attribute correction ${job.job_no}: version ${copy.versionNo} from version ${active.version_no} (${copy.changed} feature(s)): ${body.reason}`);
    await writeAudit(req, {
      action: 'gis.attributes_corrected', outcome: 'success', entityType: 'staging_batch', entityId: copy.batchId, caseId: cs.id, countyId: cs.county_id,
      detail: { jobNo: job.job_no, fromVersion: active.version_no, version: copy.versionNo, features: [...byIndex.keys()], fields: [...new Set(body.changes.flatMap((c) => Object.keys(c.set)))] },
    }, client);
    return { versionNo: copy.versionNo, jobNo: job.job_no, changed: copy.changed };
  });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Submission to the supervisor
// ---------------------------------------------------------------------------

async function checklist(db: typeof pool | import('pg').PoolClient, cs: Awaited<ReturnType<typeof getCase>>) {
  const evaluation = await evaluateCase(db, cs);
  const errors = evaluation.findings.filter((f) => f.severity === 'error');
  const warnings = evaluation.findings.filter((f) => f.severity === 'warning');
  const { rows: [batch] } = await db.query(
    `SELECT b.id, b.version_no, b.declared_srid, b.feature_count, j.source_crs_detected, j.crs_exception_reason, j.job_no
       FROM staging.batch b LEFT JOIN staging.import_job j ON j.id = b.job_id WHERE b.case_id = $1 AND b.status = 'active'`, [cs.id]);
  const { rows: [previous] } = await db.query(
    `SELECT s.id, s.submission_no, s.created_at, s.outcome, b.version_no FROM staging.submission s LEFT JOIN staging.batch b ON b.id = s.batch_id
      WHERE s.case_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [cs.id]);
  const { rows: [returned] } = await db.query(
    `SELECT r.notes, r.instructions, r.issue_categories, r.created_at FROM lais.supervisory_review r
      WHERE r.case_id = $1 AND r.decision IN ('returned', 'info_requested') ORDER BY r.created_at DESC LIMIT 1`, [cs.id]);
  const items = [
    { key: 'geometry', label: 'Geometry imported', ok: !!batch, detail: batch ? `Version ${batch.version_no}, ${batch.feature_count} feature(s)` : 'No working version' },
    { key: 'crs', label: 'Coordinate reference system recorded', ok: !!batch, detail: batch ? `EPSG:${batch.declared_srid}${batch.source_crs_detected ? ' from file metadata' : batch.crs_exception_reason ? ` declared: ${batch.crs_exception_reason}` : ''}` : '-' },
    { key: 'errors', label: 'No blocking validation errors', ok: errors.length === 0, detail: `${errors.length} error(s)` },
    { key: 'warnings', label: 'Warnings reviewed', ok: true, detail: `${warnings.length} warning(s) to acknowledge in the submission`, needsAcknowledgement: warnings.length > 0 },
    { key: 'status', label: 'Case is a draft or returned', ok: (EDITABLE_STATUSES as readonly string[]).includes(cs.status), detail: cs.status },
    { key: 'explanation', label: 'Changes since the previous submission explained', ok: true, detail: previous ? `Previous: ${previous.submission_no} (version ${previous.version_no ?? '-'})` : 'First submission', needsExplanation: !!previous },
  ];
  return { evaluation, errors, warnings, batch: batch ?? null, previous: previous ?? null, returnReason: returned ?? null, items, ready: items.every((i) => i.ok) };
}

gisWorkRouter.get('/cases/:id/submission-check', async (req, res) => {
  const cs = await viewCase(req, parseId(req.params.id));
  const c = await checklist(pool, cs);
  res.json({
    caseNo: cs.case_no, status: cs.status, ready: c.ready, items: c.items, previous: c.previous, returnReason: c.returnReason,
    errors: c.errors, warnings: c.warnings, ruleSetVersion: c.evaluation.ruleSetVersion, boundaryStatus: c.evaluation.boundaryStatus,
    canSubmit: authorize(req.auth!.principal, 'case.submit', await caseContext(pool, cs)).allowed,
  });
});

const submitBody = z.object({
  summary: z.string().trim().min(10).max(2000),
  changeExplanation: z.string().trim().max(2000).nullable().optional(),
  outstandingWarnings: z.string().trim().max(2000).nullable().optional(),
  warningsAcknowledged: z.boolean().default(false),
  confirmChecklist: z.literal(true, { message: 'Confirm the submission checklist' }),
});

/**
 * Submits the case to the supervisor. Blocking errors refuse the submission outright (409): there is no
 * exception route. Warnings must be acknowledged, and a resubmission must explain what changed.
 */
gisWorkRouter.post('/cases/:id/submit', async (req, res) => {
  const body = submitBody.parse(req.body);
  const result = await inCaseTx(req, 'case.submit', async (client, cs) => {
    if (!(SPATIAL_CASE_TYPES as readonly string[]).includes(cs.case_type)) throw badRequest('Use the case page to submit non-spatial cases');
    const c = await checklist(client, cs);
    if (c.errors.length) throw conflict(`${c.errors.length} blocking validation error(s) must be corrected before submission`, { findings: c.errors });
    if (c.warnings.length && !body.warningsAcknowledged) throw badRequest(`Acknowledge the ${c.warnings.length} outstanding warning(s) before submitting`);
    if (c.previous && (body.changeExplanation?.length ?? 0) < 10) throw badRequest('Explain what changed since the previous submission (10+ characters)');
    return submitCase(req, client, cs, {
      summary: body.summary, changeExplanation: body.changeExplanation ?? null,
      outstandingWarnings: body.outstandingWarnings ?? (c.warnings.length ? c.warnings.map((w) => w.code).join(', ') : null),
      warningsAcknowledged: body.warningsAcknowledged,
    });
  });
  res.json(result);
});

/** Where a submission stands, derived from the case and the supervisor's reviews (never stored by hand). */
const SUBMISSION_STATUS_SQL = `CASE
  WHEN s.outcome = 'returned_by_validation' THEN 'returned_by_validation'
  WHEN EXISTS (SELECT 1 FROM staging.submission n WHERE n.previous_submission_id = s.id) THEN 'superseded'
  WHEN c.status IN ('published', 'approved', 'rejected', 'withdrawn') THEN c.status
  WHEN c.status = 'returned' THEN 'returned'
  WHEN rv.decision = 'accepted' THEN 'accepted_by_supervisor'
  WHEN rv.decision = 'info_requested' THEN 'information_requested'
  ELSE 'awaiting_supervisor' END`;
const SUBMISSION_FROM = `FROM staging.submission s JOIN lais.land_case c ON c.id = s.case_id JOIN lais.county co ON co.id = c.county_id
  JOIN lais.app_user u ON u.id = s.submitted_by LEFT JOIN staging.batch b ON b.id = s.batch_id
  LEFT JOIN staging.submission ps ON ps.id = s.previous_submission_id
  LEFT JOIN staging.validation_run vr ON vr.id = s.validation_run_id
  LEFT JOIN LATERAL (SELECT r.decision, r.created_at, r.notes FROM lais.supervisory_review r WHERE r.case_id = s.case_id AND r.created_at >= s.created_at
                      ORDER BY r.created_at DESC LIMIT 1) rv ON true`;
const SUBMISSION_COLUMNS = `s.id, s.submission_no, s.case_id, c.case_no, c.case_type, c.county_id, co.code AS county_code, s.created_at, u.username AS submitted_by,
  s.outcome, s.summary, s.change_explanation, s.outstanding_warnings, s.warnings_acknowledged, s.snapshot_hash, s.feature_count,
  b.version_no, ps.submission_no AS previous_submission_no, vr.error_count, vr.warning_count, vr.rule_set_version,
  rv.decision AS review_decision, rv.created_at AS reviewed_at, ${SUBMISSION_STATUS_SQL} AS status`;

const submissionsQuery = z.object({
  countyId: countyParam,
  status: z.string().trim().max(40).optional(),
  caseId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

gisWorkRouter.get('/submissions', async (req, res) => {
  const q = submissionsQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `SELECT * FROM (SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}
      WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND ($2::uuid IS NULL OR s.case_id = $2) AND ($3::uuid IS NULL OR s.submitted_by = $3)) x
      WHERE ($4::text IS NULL OR x.status = $4) ORDER BY x.created_at DESC LIMIT 300`,
    [counties, q.caseId ?? null, q.mine === 'true' ? req.auth!.user.id : null, q.status || null],
  );
  res.json(rows);
});

gisWorkRouter.get('/submissions/:id', async (req, res) => {
  const { rows: [s] } = await pool.query(`SELECT ${SUBMISSION_COLUMNS}, s.batch_id, s.validation_run_id, s.previous_submission_id ${SUBMISSION_FROM} WHERE s.id = $1`, [parseId(req.params.id)]);
  if (!s) throw notFound('Submission not found');
  enforce(req, 'gis.workspace', { countyId: s.county_id }, { entityType: 'submission', entityId: s.id, caseId: s.case_id });
  // Re-hash the submitted version: the snapshot is intact when the hashes match.
  const current = s.batch_id ? await versionHash(pool, s.batch_id) : null;
  const { rows: findings } = await pool.query('SELECT code, severity, message, feature_index FROM staging.finding WHERE run_id = $1 ORDER BY severity, code', [s.validation_run_id]);
  const { rows: reviews } = await pool.query(
    `SELECT r.decision, r.notes, r.instructions, r.issue_categories, r.affected_features, r.created_at, u.username AS reviewer
       FROM lais.supervisory_review r JOIN lais.app_user u ON u.id = r.reviewer_id WHERE r.case_id = $1 AND r.created_at >= $2 ORDER BY r.created_at`,
    [s.case_id, s.created_at]);
  res.json({ ...s, snapshotIntact: s.snapshot_hash === null ? null : current === s.snapshot_hash, findings, reviews });
});

const returnedQuery = z.object({ countyId: countyParam });

/** Cases returned for correction, with the reason and instructions from the reviewer or validation. */
gisWorkRouter.get('/returned', async (req, res) => {
  const q = returnedQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `SELECT c.id, c.case_no, c.case_type, co.code AS county_code, c.priority, c.due_date,
            ev.at AS returned_at, ev.note AS return_note, ev.action AS return_action, eu.username AS returned_by,
            rv.notes AS review_notes, rv.instructions, rv.issue_categories, rv.affected_features, ru.username AS reviewer,
            lr.error_count, lr.warning_count, b.version_no,
            (SELECT t.task_no FROM lais.task t WHERE t.case_id = c.id AND t.status NOT IN ('completed', 'cancelled') ORDER BY t.created_at DESC LIMIT 1) AS open_task_no
       FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id
       LEFT JOIN LATERAL (SELECT e.at, e.note, e.action, e.actor_id FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = 'returned' ORDER BY e.id DESC LIMIT 1) ev ON true
       LEFT JOIN lais.app_user eu ON eu.id = ev.actor_id
       LEFT JOIN LATERAL (SELECT r.* FROM lais.supervisory_review r WHERE r.case_id = c.id AND r.decision IN ('returned', 'info_requested') ORDER BY r.created_at DESC LIMIT 1) rv ON true
       LEFT JOIN lais.app_user ru ON ru.id = rv.reviewer_id
       LEFT JOIN LATERAL (SELECT error_count, warning_count FROM staging.validation_run r WHERE r.case_id = c.id ORDER BY run_at DESC LIMIT 1) lr ON true
       LEFT JOIN staging.batch b ON b.case_id = c.id AND b.status = 'active'
      WHERE c.status = 'returned' AND c.case_type = ANY($2) AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
      ORDER BY ev.at DESC NULLS LAST`,
    [counties, [...SPATIAL_CASE_TYPES]],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Conflict investigation (GIS officers): notes, re-run checks, submit findings. Nothing resolves or deletes.
// ---------------------------------------------------------------------------

const conflictQuery = z.object({
  countyId: countyParam,
  status: z.enum(['unresolved', 'new', 'investigating', 'awaiting_correction', 'escalated', 'resolved', 'closed']).default('unresolved'),
  caseId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

gisWorkRouter.get('/conflicts', async (req, res) => {
  const q = conflictQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const statuses = q.status === 'unresolved' ? OPEN_CONFLICT_STATUSES : [q.status];
  const { rows } = await pool.query(
    `SELECT x.* FROM (${CONFLICTS_SQL}) x
      WHERE x.review_status = ANY($2) AND ($3::uuid IS NULL OR x.case_id = $3) AND ($4::text IS NULL OR x.investigator = $4)
      ORDER BY x.detected_at DESC LIMIT 300`,
    [counties, statuses, q.caseId ?? null, q.mine === 'true' ? req.auth!.user.username : null],
  );
  res.json(rows);
});

async function loadGisConflict(req: Request, findingId: string) {
  const f = await findConflictOccurrence(pool, findingId);
  enforce(req, 'gis.workspace', { countyId: f.county_id }, { entityType: 'finding', entityId: f.id, caseId: f.case_id });
  return conflictRow(pool, f);
}

gisWorkRouter.get('/conflicts/:findingId', async (req, res) => {
  const c = await loadGisConflict(req, parseId(req.params.findingId));
  res.json(await conflictDetail(pool, c));
});

const investigateBody = z.object({
  action: z.enum(['note', 'findings_submitted', 'revalidated']),
  note: z.string().trim().min(5).max(4000),
});

gisWorkRouter.post('/conflicts/:findingId/actions', async (req, res) => {
  const body = investigateBody.parse(req.body);
  const c = await loadGisConflict(req, parseId(req.params.findingId));
  if (body.action === 'findings_submitted' && body.note.length < 20) throw badRequest('Describe the findings (at least 20 characters)');
  const result = await tx(async (client) => {
    enforce(req, 'conflict.investigate', { countyId: c.county_id }, { entityType: 'finding', entityId: c.id, caseId: c.case_id });
    let rerun: { runId: string; stillDetected: boolean } | null = null;
    if (body.action === 'revalidated') {
      // Re-running checks writes a new validation run, so it is only allowed while the case is being prepared.
      const cs = await getCase(client, c.case_id, true);
      enforce(req, 'case.validate', await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
      const evaluation = await evaluateCase(client, cs);
      const runId = await persistRun(client, cs, evaluation, req.auth!.user.id, 'preview');
      const stillDetected = evaluation.findings.some((f) => f.code === c.code && (f.relatedParcelId ?? null) === c.related_parcel_id
        && (f.relatedCaseId ?? null) === c.related_case_id && (f.featureIndex ?? null) === c.feature_index);
      rerun = { runId, stillDetected };
    }
    const note = rerun ? `${body.note} [re-validation: ${rerun.stillDetected ? 'still detected' : 'no longer detected'}]` : body.note;
    const { rows: [event] } = await client.query(
      `INSERT INTO lais.conflict_review_event (finding_id, case_id, action, note, actor_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [c.id, c.case_id, body.action, note, req.auth!.user.id]);
    await writeAudit(req, {
      action: `conflict.${body.action}`, outcome: 'success', entityType: 'finding', entityId: c.id, caseId: c.case_id, countyId: c.county_id,
      detail: { code: c.code, eventId: event.id, rerun },
    }, client);
    return { eventId: event.id, rerun };
  });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Validation center
// ---------------------------------------------------------------------------

const validationQuery = z.object({
  countyId: countyParam,
  severity: z.enum(['error', 'warning']).optional(),
  code: z.string().trim().max(60).optional(),
  category: z.string().trim().max(30).optional(),
  caseId: z.string().uuid().optional(),
  openOnly: z.enum(['true', 'false']).default('true'),
});

async function validationFindings(req: Request) {
  const q = validationQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.workspace', q.countyId);
  const { rows } = await pool.query(
    `WITH lr AS (SELECT DISTINCT ON (case_id) * FROM staging.validation_run ORDER BY case_id, run_at DESC)
     SELECT f.id, f.code, f.severity, f.message, f.feature_index, f.acknowledged_at, vr.label AS rule_label, vr.category, vr.suggestion,
            c.id AS case_id, c.case_no, c.status AS case_status, co.code AS county_code, lr.run_at, lr.purpose, lr.rule_set_version, lr.id AS run_id,
            (SELECT ST_AsGeoJSON(ST_Envelope(coalesce(sf.geom, ST_Transform(sf.geom_input, 4326))), 7)::json
               FROM staging.feature sf WHERE sf.batch_id = lr.batch_id AND sf.feature_index = coalesce(f.feature_index, 0)) AS extent
       FROM lr JOIN staging.finding f ON f.run_id = lr.id
       JOIN lais.land_case c ON c.id = lr.case_id JOIN lais.county co ON co.id = c.county_id
       LEFT JOIN staging.validation_rule vr ON vr.code = f.code
      WHERE c.case_type = ANY($2) AND ($1::smallint[] IS NULL OR c.county_id = ANY($1))
        AND ($3::text IS NULL OR f.severity = $3) AND ($4::text IS NULL OR f.code = $4) AND ($5::text IS NULL OR vr.category = $5)
        AND ($6::uuid IS NULL OR c.id = $6) AND ($7::boolean IS FALSE OR c.status NOT IN ('published', 'rejected', 'withdrawn'))
      ORDER BY f.severity, lr.run_at DESC LIMIT 1000`,
    [counties, [...SPATIAL_CASE_TYPES], q.severity ?? null, q.code || null, q.category || null, q.caseId ?? null, q.openOnly === 'true'],
  );
  return rows;
}

gisWorkRouter.get('/validation', async (req, res) => {
  const rows = await validationFindings(req);
  const { rows: codes } = await pool.query('SELECT code, label, category, severity FROM staging.validation_rule ORDER BY category, code');
  res.json({ findings: rows, rules: codes });
});

gisWorkRouter.get('/validation.csv', async (req, res) => {
  const rows = await validationFindings(req);
  const cols = ['case_no', 'county_code', 'case_status', 'severity', 'code', 'rule_label', 'category', 'feature_index', 'message', 'suggestion', 'run_at', 'rule_set_version'];
  const lines = ['# Validation findings (latest run of each case). Research prototype: synthetic data.', cols.map(csvCell).join(','),
    ...rows.map((r) => cols.map((k) => csvCell(k === 'feature_index' && r[k] !== null ? Number(r[k]) + 1 : r[k])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lais-validation-findings.csv"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

gisWorkRouter.get('/validation/rules', async (req, res) => {
  enforce(req, 'validation.rules_view', {}, { entityType: 'validation_rule' });
  const [rules, history] = await Promise.all([
    pool.query(`SELECT r.*, u.username AS updated_by_username FROM staging.validation_rule r LEFT JOIN lais.app_user u ON u.id = r.updated_by ORDER BY r.category, r.code`),
    pool.query(`SELECT h.*, u.username AS changed_by_username FROM staging.rule_set_version h LEFT JOIN lais.app_user u ON u.id = h.changed_by ORDER BY h.version DESC LIMIT 200`),
  ]);
  res.json({ rules: rules.rows, history: history.rows, currentVersion: history.rows[0]?.version ?? null,
    canConfigure: authorize(req.auth!.principal, 'validation.configure').allowed });
});

const ruleBody = z.object({ severity: z.enum(['error', 'warning']), reason: z.string().trim().min(10).max(1000) });

/** Changes a configurable rule's severity. Every change is a new rule-set version; validation runs record the version they used. */
gisWorkRouter.patch('/validation/rules/:code', async (req, res) => {
  enforce(req, 'validation.configure', {}, { entityType: 'validation_rule', entityId: req.params.code });
  const body = ruleBody.parse(req.body);
  const code = String(req.params.code);
  const version = await tx(async (client) => {
    const { rows: [rule] } = await client.query('SELECT * FROM staging.validation_rule WHERE code = $1 FOR UPDATE', [code]);
    if (!rule) throw notFound('Unknown rule');
    if (!rule.configurable) throw conflict(`${code} is a safety rule; its severity is fixed`);
    if (rule.severity === body.severity) throw conflict(`${code} is already a${body.severity === 'error' ? 'n' : ''} ${body.severity}`);
    await client.query('UPDATE staging.validation_rule SET severity = $2, updated_by = $3, updated_at = now() WHERE code = $1', [code, body.severity, req.auth!.user.id]);
    const { rows: [v] } = await client.query(
      'INSERT INTO staging.rule_set_version (changed_by, rule_code, from_value, to_value, reason) VALUES ($1, $2, $3, $4, $5) RETURNING version',
      [req.auth!.user.id, code, rule.severity, body.severity, body.reason]);
    await writeAudit(req, { action: 'validation.rule_changed', outcome: 'success', entityType: 'validation_rule', entityId: code, detail: { from: rule.severity, to: body.severity, version: v.version, reason: body.reason } }, client);
    return v.version as number;
  });
  res.json({ ok: true, version });
});

// ---------------------------------------------------------------------------
// GIS reports (JSON, CSV, PDF)
// ---------------------------------------------------------------------------

interface Filters { counties: number[] | null; from: string; to: string }
type Col = { key: string; label: string };
const col = (key: string, label: string): Col => ({ key, label });

const GIS_REPORTS: Record<string, { title: string; description: string; columns: Col[]; rows: (f: Filters) => Promise<Record<string, unknown>[]> }> = {
  import_jobs: {
    title: 'GIS import and synchronization jobs',
    description: 'Every import, ArcMap sync and attribute correction job created in the period, with its outcome.',
    columns: [col('job_no', 'Job'), col('kind', 'Kind'), col('status', 'Status'), col('county', 'County'), col('case_no', 'Application'), col('source_name', 'Source'),
      col('crs', 'CRS'), col('received', 'Received'), col('accepted', 'Accepted'), col('rejected', 'Rejected'), col('officer', 'Officer'), col('created_at', 'Created')],
    rows: async (f) => (await pool.query(
      `SELECT j.job_no, j.kind, j.status, co.code AS county, c.case_no, j.source_name, 'EPSG:' || j.source_crs_declared AS crs,
              j.records_received AS received, j.records_accepted AS accepted, j.records_rejected AS rejected, u.username AS officer, j.created_at
         FROM staging.import_job j JOIN lais.land_case c ON c.id = j.case_id JOIN lais.county co ON co.id = j.county_id JOIN lais.app_user u ON u.id = j.initiated_by
        WHERE ($1::smallint[] IS NULL OR j.county_id = ANY($1)) AND j.created_at >= $2::date AND j.created_at < $3::date + 1 ORDER BY j.created_at`,
      [f.counties, f.from, f.to])).rows,
  },
  validation_findings: {
    title: 'Validation findings by rule',
    description: 'Findings of the latest validation run of each spatial case validated in the period, counted by rule.',
    columns: [col('code', 'Rule'), col('label', 'Description'), col('severity', 'Severity'), col('cases', 'Cases'), col('findings', 'Findings')],
    rows: async (f) => (await pool.query(
      `WITH lr AS (SELECT DISTINCT ON (case_id) * FROM staging.validation_run ORDER BY case_id, run_at DESC)
       SELECT x.code, coalesce(r.label, x.code) AS label, x.severity, count(DISTINCT lr.case_id)::int AS cases, count(*)::int AS findings
         FROM lr JOIN staging.finding x ON x.run_id = lr.id JOIN lais.land_case c ON c.id = lr.case_id LEFT JOIN staging.validation_rule r ON r.code = x.code
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND lr.run_at >= $2::date AND lr.run_at < $3::date + 1
        GROUP BY x.code, r.label, x.severity ORDER BY findings DESC`,
      [f.counties, f.from, f.to])).rows,
  },
  submissions: {
    title: 'GIS submissions',
    description: 'Submissions in the period with their snapshot, validation counts and current status.',
    columns: [col('submission_no', 'Submission'), col('case_no', 'Application'), col('county_code', 'County'), col('version_no', 'Version'),
      col('submitted_by', 'Officer'), col('created_at', 'Submitted'), col('error_count', 'Errors'), col('warning_count', 'Warnings'), col('status', 'Status')],
    rows: async (f) => (await pool.query(
      `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1)) AND s.created_at >= $2::date AND s.created_at < $3::date + 1 ORDER BY s.created_at`,
      [f.counties, f.from, f.to])).rows,
  },
  returns: {
    title: 'Returned GIS work',
    description: 'Supervisor returns and information requests in the period, with issue categories.',
    columns: [col('created_at', 'When'), col('case_no', 'Application'), col('county', 'County'), col('decision', 'Decision'), col('issues', 'Issue categories'),
      col('reviewer', 'Reviewer'), col('notes', 'Notes')],
    rows: async (f) => (await pool.query(
      `SELECT r.created_at, c.case_no, co.code AS county, r.decision, array_to_string(r.issue_categories, '; ') AS issues, u.username AS reviewer, r.notes
         FROM lais.supervisory_review r JOIN lais.land_case c ON c.id = r.case_id JOIN lais.county co ON co.id = r.county_id JOIN lais.app_user u ON u.id = r.reviewer_id
        WHERE r.decision IN ('returned', 'info_requested') AND ($1::smallint[] IS NULL OR r.county_id = ANY($1))
          AND r.created_at >= $2::date AND r.created_at < $3::date + 1 ORDER BY r.created_at`,
      [f.counties, f.from, f.to])).rows,
  },
  conflicts: {
    title: 'Spatial conflicts',
    description: 'Conflicts first detected in the period and their derived review status. A conflict is a technical signal, not a finding about ownership.',
    columns: [col('case_no', 'Application'), col('county_code', 'County'), col('category_label', 'Category'), col('severity', 'Severity'), col('related_upi', 'Related parcel'),
      col('review_status', 'Status'), col('investigator', 'Investigator'), col('detected_at', 'Detected')],
    rows: async (f) => (await pool.query(
      `SELECT x.* FROM (${CONFLICTS_SQL}) x WHERE x.detected_at >= $2::date AND x.detected_at < $3::date + 1 ORDER BY x.detected_at`,
      [f.counties, f.from, f.to])).rows,
  },
};

gisWorkRouter.get('/reports', (req, res) => {
  resolveScope(req, 'gis.reports');
  res.json(Object.entries(GIS_REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description })));
});

const reportQuery = z.object({ countyId: countyParam, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

async function generate(req: Request, key: string, format: 'json' | 'csv' | 'pdf') {
  const def = GIS_REPORTS[key];
  if (!def) throw notFound('Unknown report');
  const q = reportQuery.parse(req.query);
  const counties = resolveScope(req, 'gis.reports', q.countyId);
  const { from, to } = dateRange(q);
  const rows = await def.rows({ counties, from, to });
  const { rows: [scope] } = await pool.query(`SELECT string_agg(code, ', ' ORDER BY code) AS codes FROM lais.county WHERE $1::smallint[] IS NULL OR id = ANY($1)`, [counties]);
  const report = {
    reportId: randomUUID(), key, title: def.title, description: def.description, generatedAt: new Date().toISOString(), generatedBy: req.auth!.user.username,
    scope: counties === null ? 'All counties' : scope.codes, filters: { from, to },
    dataNotice: 'Research prototype: synthetic demonstration data, not real land records.', columns: def.columns, rows,
  };
  await writeAudit(req, { action: 'report.gis', outcome: 'success', entityType: 'report', entityId: key, countyId: q.countyId ?? null, detail: { reportId: report.reportId, format, rows: rows.length, from, to } });
  return report;
}

const meta = (r: Awaited<ReturnType<typeof generate>>) => [
  `Report ${r.reportId}, generated ${r.generatedAt} by ${r.generatedBy}`, `Scope: ${r.scope}; period ${r.filters.from} to ${r.filters.to}`, r.description, r.dataNotice,
];

gisWorkRouter.get('/reports/:key.csv', async (req, res) => {
  const r = await generate(req, req.params.key, 'csv');
  const lines = [`# ${r.title}`, ...meta(r).map((m) => `# ${m}`), r.columns.map((c) => csvCell(c.label)).join(','),
    ...r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lais-gis-${r.key}-${r.filters.from}-${r.filters.to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

gisWorkRouter.get('/reports/:key.pdf', async (req, res) => {
  const r = await generate(req, req.params.key, 'pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="lais-gis-${r.key}-${r.filters.from}-${r.filters.to}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(tablePdf({ title: r.title, meta: meta(r), columns: r.columns, rows: r.rows }));
});

gisWorkRouter.get('/reports/:key', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await generate(req, req.params.key, 'json'));
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /gis/cases/{id}/versions/compare', compareQuery);
documentBody('POST /gis/cases/{id}/corrections', correctionBody);
documentBody('POST /gis/cases/{id}/submit', submitBody);
documentQuery('GET /gis/submissions', submissionsQuery);
documentQuery('GET /gis/returned', returnedQuery);
documentQuery('GET /gis/conflicts', conflictQuery);
documentBody('POST /gis/conflicts/{findingId}/actions', investigateBody);
documentQuery(['GET /gis/validation', 'GET /gis/validation.csv'], validationQuery);
documentBody('PATCH /gis/validation/rules/{code}', ruleBody);
documentQuery(['GET /gis/reports/{key}', 'GET /gis/reports/{key}.csv', 'GET /gis/reports/{key}.pdf'], reportQuery);
