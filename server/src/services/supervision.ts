import type { Request } from 'express';
import type { Db } from '../db.js';
import { badRequest, conflict } from '../http.js';
import { enforce } from '../authz/enforce.js';
import { scopeFor, type Action, type Role } from '../authz/policy.js';
import { SPATIAL_CASE_TYPES } from '../authz/workflow.js';

/**
 * The counties a request may cover for a county-scoped action: null for "every county" (national
 * grant), otherwise a list. A county the client asks for is checked against the caller's own grants,
 * never trusted: asking for an unassigned county is refused and audited.
 */
export function resolveScope(req: Request, action: Action, requestedCountyId?: number | null): number[] | null {
  const scope = scopeFor(req.auth!.principal, action);
  if (scope !== 'all' && scope.length === 0) enforce(req, action, { countyId: null }, { entityType: 'county' });
  if (requestedCountyId !== undefined && requestedCountyId !== null) {
    enforce(req, action, { countyId: requestedCountyId }, { entityType: 'county', entityId: String(requestedCountyId) });
    return [requestedCountyId];
  }
  return scope === 'all' ? null : scope;
}

// ---------------------------------------------------------------------------
// Workflow stages shown to supervisors. The case statuses are the source of truth; this is a
// presentation of them (documented in docs/workflow.md).
// ---------------------------------------------------------------------------

export const STAGES = [
  { key: 'preparation', label: 'Draft / in preparation', statuses: ['draft'] },
  { key: 'gis_validation', label: 'Automated validation', statuses: ['validating'] },
  { key: 'quality_review', label: 'Submitted: supervisory quality review open', statuses: ['under_review'] },
  { key: 'registrar_decision', label: 'Awaiting Registrar decision', statuses: ['under_review'] },
  { key: 'returned', label: 'Returned for correction', statuses: ['returned'] },
  { key: 'approved', label: 'Approved, awaiting publication', statuses: ['approved'] },
  { key: 'published', label: 'Published', statuses: ['published'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { key: 'withdrawn', label: 'Withdrawn (archived)', statuses: ['withdrawn'] },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

/**
 * Joins for a case alias `c`: its latest validation run (`lr`), latest supervisory review (`rv`) and
 * when it entered its current status (`st`). Use with stageSql().
 */
export const CASE_JOINS = `
  LEFT JOIN LATERAL (SELECT r.id, r.run_at, r.error_count, r.warning_count FROM staging.validation_run r
                      WHERE r.case_id = c.id ORDER BY r.run_at DESC LIMIT 1) lr ON true
  LEFT JOIN LATERAL (SELECT s.decision, s.validation_run_id, s.created_at, s.reviewer_id FROM lais.supervisory_review s
                      WHERE s.case_id = c.id ORDER BY s.created_at DESC LIMIT 1) rv ON true
  LEFT JOIN LATERAL (SELECT max(e.at) AS since FROM lais.case_event e WHERE e.case_id = c.id AND e.to_status = c.status) st ON true`;

/** A submitted spatial case is in quality review until a supervisor accepts its current validation run. */
export const ACCEPTED_SQL = `(rv.decision = 'accepted' AND rv.validation_run_id = lr.id)`;
export const stageSql = () => `CASE c.status
    WHEN 'draft' THEN 'preparation' WHEN 'validating' THEN 'gis_validation' WHEN 'returned' THEN 'returned'
    WHEN 'under_review' THEN CASE WHEN c.case_type = ANY('{${SPATIAL_CASE_TYPES.join(',')}}'::text[]) AND NOT coalesce(${ACCEPTED_SQL}, false)
                                  THEN 'quality_review' ELSE 'registrar_decision' END
    ELSE c.status END`;

/** When the case entered its current status (falls back to creation). */
export const STAGE_SINCE_SQL = `coalesce(st.since, c.created_at)`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function reviewMode(db: Db): Promise<'required' | 'optional'> {
  const { rows: [s] } = await db.query(`SELECT value FROM lais.system_setting WHERE key = 'workflow.supervisor_review'`);
  return s?.value === 'required' ? 'required' : 'optional';
}

/** Operational target days per case status, or null when the administrator has not configured any. */
export async function stageTargets(db: Db): Promise<Record<string, number> | null> {
  const { rows: [s] } = await db.query(`SELECT value FROM lais.system_setting WHERE key = 'workflow.stage_targets_days'`);
  const v = s?.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && n > 0) out[k] = n;
  return Object.keys(out).length ? out : null;
}

/** SQL: whether case `c` is overdue, from its due date or (when configured) the target for its status. */
export const caseOverdueSql = (targetsParam: string) => `(
  (c.due_date IS NOT NULL AND c.due_date < current_date)
  OR (${targetsParam}::jsonb IS NOT NULL AND (${targetsParam}::jsonb ->> c.status) IS NOT NULL
      AND now() - ${STAGE_SINCE_SQL} > make_interval(days => (${targetsParam}::jsonb ->> c.status)::int)))`;

// ---------------------------------------------------------------------------
// Tasks: who may be assigned what. A task never grants the assignee any permission.
// ---------------------------------------------------------------------------

export const TASK_TYPES = {
  document_review: { label: 'Document completeness review', roles: ['processor'] },
  gis_preparation: { label: 'GIS data preparation', roles: ['gis_officer'] },
  gis_validation_correction: { label: 'GIS validation correction', roles: ['gis_officer'] },
  attribute_verification: { label: 'Parcel attribute verification', roles: ['processor', 'gis_officer'] },
  conflict_investigation: { label: 'Spatial conflict investigation', roles: ['gis_officer', 'processor'] },
  application_follow_up: { label: 'Application follow-up', roles: ['processor', 'gis_officer'] },
  additional_information: { label: 'Additional information request', roles: ['processor', 'gis_officer'] },
  correction_resubmission: { label: 'Correction and resubmission', roles: ['gis_officer', 'processor'] },
  quality_review: { label: 'Operational quality review', roles: ['supervisor'] },
} as const satisfies Record<string, { label: string; roles: readonly Role[] }>;
export type TaskType = keyof typeof TASK_TYPES;
export const TASK_TYPE_KEYS = Object.keys(TASK_TYPES) as [TaskType, ...TaskType[]];

/** Throws unless the user is active and holds a role eligible for the task type in the county. */
export async function assertEligibleAssignee(db: Db, userId: string, taskType: TaskType, countyId: number): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE u.id = $1 AND u.status = 'active' AND r.role = ANY($2) AND (r.county_id = $3 OR r.county_id IS NULL)`,
    [userId, TASK_TYPES[taskType].roles, countyId],
  );
  if (!rows[0]) {
    throw conflict(`The assignee must be an active ${TASK_TYPES[taskType].roles.join(' or ')} assigned to this county`);
  }
}

/** Active staff eligible for a task type in a county (for assignment pickers). */
export async function eligibleStaff(db: Db, countyId: number, taskType?: TaskType) {
  const roles = taskType ? TASK_TYPES[taskType].roles : ['gis_officer', 'processor'];
  const { rows } = await db.query(
    `SELECT DISTINCT u.id, u.username, u.display_name, array_agg(DISTINCT r.role) AS roles
       FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE u.status = 'active' AND r.role = ANY($1) AND (r.county_id = $2 OR r.county_id IS NULL)
      GROUP BY u.id ORDER BY u.username`,
    [roles, countyId],
  );
  return rows as { id: string; username: string; display_name: string; roles: string[] }[];
}

/**
 * Who returned work goes to: the officer who imported the current geometry if still eligible,
 * otherwise the officer who opened the case.
 */
export async function responsibleOfficer(db: Db, caseId: string, countyId: number): Promise<{ id: string; username: string; role: string } | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.username, r.role, 1 AS rank FROM staging.batch b
       JOIN lais.app_user u ON u.id = b.uploaded_by AND u.status = 'active'
       JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL AND r.role = 'gis_officer' AND (r.county_id = $2 OR r.county_id IS NULL)
      WHERE b.case_id = $1 AND b.status = 'active'
     UNION ALL
     SELECT u.id, u.username, r.role, 2 FROM lais.land_case c
       JOIN lais.app_user u ON u.id = c.created_by AND u.status = 'active'
       JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL AND r.role IN ('gis_officer', 'processor') AND (r.county_id = $2 OR r.county_id IS NULL)
      WHERE c.id = $1
     ORDER BY rank LIMIT 1`,
    [caseId, countyId],
  );
  return rows[0] ?? null;
}

/** Resolves a date range (default: the last 30 days, inclusive), limited to 366 days. */
export function dateRange(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 29 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('Invalid date range');
  if ((to.getTime() - from.getTime()) / 86_400_000 > 366) throw badRequest('Date range cannot exceed 366 days');
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function requireReason(reason: string | undefined, what = 'reason'): string {
  const r = reason?.trim() ?? '';
  if (r.length < 5) throw badRequest(`Give a ${what} (at least 5 characters)`);
  return r;
}
