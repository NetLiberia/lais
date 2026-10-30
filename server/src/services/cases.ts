import type { Request } from 'express';
import type pg from 'pg';
import { tx, type Db } from '../db.js';
import { notFound, parseId } from '../http.js';
import { enforce } from '../authz/enforce.js';
import type { Action, ResourceContext } from '../authz/policy.js';
import { assertTransition, type CaseStatus, type CaseType } from '../authz/workflow.js';

export interface CaseRow {
  id: string;
  case_no: string;
  case_type: CaseType;
  county_id: number;
  parcel_id: string | null;
  status: CaseStatus;
  proposed_upi: string | null;
  land_category: string | null;
  land_use: string | null;
  source_reference: string | null;
  correction_reason: string | null;
  area_m2_surveyed: string | null;
  /** Operational fields set by supervisors; outside the decision snapshot. */
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_date: Date | null;
  /** Application intake (migration 013): set for applications registered by processors. */
  applicant_id: string | null;
  category_code: string | null;
  intake_status: 'draft' | 'registered';
  assigned_processor_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** Event actions that make the actor a contributor for separation-of-duties checks. */
export const CONTRIBUTING_ACTIONS = [
  'create',
  'update_attributes',
  'import_geometry',
  'propose_right',
  'remove_right',
  'upload_document',
  'verify_document',
  'submit',
] as const;

export async function getCase(db: Db, id: string, lock = false): Promise<CaseRow> {
  const { rows } = await db.query<CaseRow>(
    `SELECT * FROM lais.land_case WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('Case not found');
  return rows[0];
}

export async function getContributors(db: Db, caseId: string): Promise<string[]> {
  const { rows } = await db.query<{ actor_id: string }>(
    `SELECT DISTINCT actor_id FROM lais.case_event WHERE case_id = $1 AND actor_id IS NOT NULL AND action = ANY($2)`,
    [caseId, CONTRIBUTING_ACTIONS],
  );
  return rows.map((r) => r.actor_id);
}

export async function caseContext(db: Db, cs: CaseRow): Promise<ResourceContext> {
  return {
    countyId: cs.county_id,
    caseStatus: cs.status,
    caseType: cs.case_type,
    createdBy: cs.created_by,
    contributorIds: await getContributors(db, cs.id),
  };
}

export async function recordEvent(
  db: Db,
  caseId: string,
  actorId: string | null,
  action: string,
  note?: string | null,
  fromStatus?: CaseStatus | null,
  toStatus?: CaseStatus | null,
): Promise<void> {
  await db.query(
    `INSERT INTO lais.case_event (case_id, actor_id, action, from_status, to_status, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [caseId, actorId, action, fromStatus ?? null, toStatus ?? null, note ?? null],
  );
}

/** Moves a case to a new status (checked here and again by the database trigger) and records the event. */
export async function setStatus(
  db: Db,
  cs: CaseRow,
  to: CaseStatus,
  actorId: string | null,
  action: string,
  note?: string | null,
  parcelId?: string,
): Promise<CaseRow> {
  assertTransition(cs.status, to);
  await db.query('UPDATE lais.land_case SET status = $2, parcel_id = coalesce($3, parcel_id) WHERE id = $1', [cs.id, to, parcelId ?? null]);
  await recordEvent(db, cs.id, actorId, action, note, cs.status, to);
  return { ...cs, status: to, parcel_id: parcelId ?? cs.parcel_id };
}

/**
 * Runs fn in a transaction with the case row locked, after checking that the caller may perform
 * the action on this case in its current state. Jurisdiction comes from the stored case, never the request.
 */
export async function inCaseTx<T>(
  req: Request,
  action: Action,
  fn: (client: pg.PoolClient, cs: CaseRow) => Promise<T>,
): Promise<T> {
  const id = parseId(req.params.id);
  return tx(async (client) => {
    const cs = await getCase(client, id, true);
    enforce(req, action, await caseContext(client, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
    return fn(client, cs);
  });
}
