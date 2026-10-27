import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize, scopeFor, type Role } from '../authz/policy.js';
import { notifyRoles, notifyUsers } from '../services/notify.js';
import { assertEligibleAssignee } from '../services/supervision.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Escalations: problems routed to a role that can act on them. Closing an escalation records an
 * operational disposition only; it never changes a land record and cannot settle an ownership dispute.
 * Escalations are never deleted and their facts never edited: every step is an escalation event.
 */
export const escalationsRouter = Router();

const CATEGORIES = ['repeated_quality_failure', 'spatial_conflict', 'suspected_unauthorized_change', 'document_discrepancy',
  'processing_delay', 'sync_failure', 'access_control_incident', 'workflow_exception'] as const;
type Category = (typeof CATEGORIES)[number];
type Target = { role: 'supervisor' | 'registrar' | 'system_admin'; level: 'county' | 'national' };

/** Where a new escalation goes unless the person raising it chooses another permitted target. */
const DEFAULT_TARGET: Record<Category, Target> = {
  repeated_quality_failure: { role: 'supervisor', level: 'county' },
  processing_delay: { role: 'supervisor', level: 'county' },
  workflow_exception: { role: 'supervisor', level: 'county' },
  spatial_conflict: { role: 'registrar', level: 'county' },
  document_discrepancy: { role: 'registrar', level: 'county' },
  suspected_unauthorized_change: { role: 'system_admin', level: 'national' },
  sync_failure: { role: 'system_admin', level: 'national' },
  access_control_incident: { role: 'system_admin', level: 'national' },
};
const TARGETS: Target[] = [
  { role: 'supervisor', level: 'county' }, { role: 'supervisor', level: 'national' },
  { role: 'registrar', level: 'county' }, { role: 'system_admin', level: 'national' },
];
const sameTarget = (a: Target, b: Target) => a.role === b.role && a.level === b.level;

interface EscalationRow {
  id: string; escalation_no: string; category: Category; status: string; responsible_role: Target['role']; responsible_level: Target['level'];
  county_id: number; case_id: string | null; finding_id: string | null; task_id: string | null; assignee_id: string | null; created_by: string;
}

async function load(db: pg.PoolClient | typeof pool, id: string, lock = false): Promise<EscalationRow> {
  const { rows: [e] } = await db.query<EscalationRow>(`SELECT * FROM lais.escalation WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!e) throw notFound('Escalation not found');
  return e;
}

/** Whether the caller currently holds the responsibility the escalation is routed to. */
function isResponsible(req: Request, e: EscalationRow): boolean {
  return req.auth!.principal.grants.some((g) => g.role === e.responsible_role
    && (e.responsible_level === 'national' ? g.countyId === null : g.countyId === null || g.countyId === e.county_id));
}

function assertCanSee(req: Request, e: EscalationRow) {
  if (e.responsible_role === 'system_admin' && authorize(req.auth!.principal, 'escalation.view_system').allowed) return;
  enforce(req, 'escalation.view', { countyId: e.county_id }, { entityType: 'escalation', entityId: e.id, caseId: e.case_id });
}

function assertResponsible(req: Request, e: EscalationRow) {
  if (isResponsible(req, e)) return;
  const reason = `Only a ${e.responsible_level === 'national' ? 'national ' : ''}${e.responsible_role.replace('_', ' ')} responsible for this escalation can do this`;
  throw new HttpError(403, reason).withAudit({
    action: 'authz.denied', outcome: 'denied', entityType: 'escalation', entityId: e.id, caseId: e.case_id, countyId: e.county_id,
    detail: { requestedAction: 'escalation.manage', reason },
  });
}

async function event(db: pg.PoolClient, e: EscalationRow, actorId: string, action: string, toStatus: string | null, note?: string | null) {
  await db.query(
    `INSERT INTO lais.escalation_event (escalation_id, actor_id, action, from_status, to_status, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.id, actorId, action, e.status, toStatus, note ?? null],
  );
}

const notifyTarget = (db: pg.PoolClient, t: Target, countyId: number, title: string, body?: string) =>
  notifyRoles(db, [t.role as Role], { category: 'escalation', title, body, link: '/supervisor/escalations' }, t.level === 'national' ? null : countyId);

const audit = (req: Request, e: { id: string; county_id: number; case_id: string | null }, action: string, detail: Record<string, unknown>, db: pg.PoolClient) =>
  writeAudit(req, { action: `escalation.${action}`, outcome: 'success', entityType: 'escalation', entityId: e.id, caseId: e.case_id, countyId: e.county_id, detail }, db);

// ---------------------------------------------------------------------------

const listQuery = z.object({
  countyId: z.coerce.number().int().positive().optional(),
  status: z.union([z.enum(['open', 'acknowledged', 'investigating', 'closed']), z.literal('active')]).default('active'),
  category: z.enum(CATEGORIES).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  responsible: z.enum(['me', 'any']).default('any'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n)).default(25),
});

escalationsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const p = req.auth!.principal;
  const county = scopeFor(p, 'escalation.view');
  const system = authorize(p, 'escalation.view_system').allowed;
  if (county !== 'all' && county.length === 0 && !system) enforce(req, 'escalation.view', { countyId: null }, { entityType: 'escalation' });
  if (q.countyId !== undefined && county !== 'all' && !county.includes(q.countyId) && !system) {
    enforce(req, 'escalation.view', { countyId: q.countyId }, { entityType: 'county', entityId: String(q.countyId) });
  }
  const counties = county === 'all' ? null : county;
  const statuses = q.status === 'active' ? ['open', 'acknowledged', 'investigating'] : [q.status];
  const { rows } = await pool.query(
    `SELECT x.id, x.escalation_no, x.category, x.severity, x.status, x.responsible_role, x.responsible_level, x.title,
            x.county_id, co.code AS county_code, x.case_id, c.case_no, p.upi, x.created_at, x.updated_at,
            cu.username AS created_by, au.username AS assignee, count(*) OVER () AS total
       FROM lais.escalation x JOIN lais.county co ON co.id = x.county_id JOIN lais.app_user cu ON cu.id = x.created_by
       LEFT JOIN lais.app_user au ON au.id = x.assignee_id LEFT JOIN lais.land_case c ON c.id = x.case_id LEFT JOIN lais.parcel p ON p.id = x.parcel_id
      WHERE ( (($1::smallint[] IS NULL AND $2::boolean) OR x.county_id = ANY(coalesce($1, '{}'::smallint[])))
              OR ($3::boolean AND x.responsible_role = 'system_admin') )
        AND ($4::smallint IS NULL OR x.county_id = $4) AND x.status = ANY($5)
        AND ($6::text IS NULL OR x.category = $6) AND ($7::text IS NULL OR x.severity = $7)
      ORDER BY array_position(ARRAY['critical', 'high', 'medium', 'low'], x.severity), x.created_at DESC
      LIMIT $8 OFFSET $9`,
    [counties, county === 'all', system, q.countyId ?? null, statuses, q.category ?? null, q.severity ?? null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const all = rows.map(({ total: _t, ...r }) => ({ ...r, responsible: isResponsible(req, r as unknown as EscalationRow) }));
  // "Mine" narrows the current page to escalations the caller must act on.
  const items = q.responsible === 'me' ? all.filter((r) => r.responsible) : all;
  res.json({ items, total: q.responsible === 'me' ? items.length : Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize });
});

escalationsRouter.get('/:id', async (req, res) => {
  const e = await load(pool, parseId(req.params.id));
  assertCanSee(req, e);
  const [{ rows: [detail] }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT x.*, co.code AS county_code, co.name AS county_name, c.case_no, p.upi, t.task_no, t.status AS task_status,
              f.code AS finding_code, cu.username AS created_by_username, au.username AS assignee, clu.username AS closed_by_username
         FROM lais.escalation x JOIN lais.county co ON co.id = x.county_id JOIN lais.app_user cu ON cu.id = x.created_by
         LEFT JOIN lais.app_user au ON au.id = x.assignee_id LEFT JOIN lais.app_user clu ON clu.id = x.closed_by
         LEFT JOIN lais.land_case c ON c.id = x.case_id LEFT JOIN lais.parcel p ON p.id = x.parcel_id
         LEFT JOIN lais.task t ON t.id = x.task_id LEFT JOIN staging.finding f ON f.id = x.finding_id
        WHERE x.id = $1`,
      [e.id],
    ),
    pool.query(
      `SELECT ev.id, ev.action, ev.from_status, ev.to_status, ev.note, ev.at, u.username AS actor
         FROM lais.escalation_event ev JOIN lais.app_user u ON u.id = ev.actor_id WHERE ev.escalation_id = $1 ORDER BY ev.id`,
      [e.id],
    ),
  ]);
  const responsible = isResponsible(req, e) && e.status !== 'closed';
  const canManage = authorize(req.auth!.principal, 'escalation.manage', { countyId: e.county_id }).allowed
    || authorize(req.auth!.principal, 'escalation.manage_system').allowed;
  res.json({
    escalation: detail,
    events,
    permitted: {
      acknowledge: responsible && e.status === 'open',
      assign: responsible,
      investigate: responsible && e.status !== 'open',
      escalate: responsible,
      comment: e.status !== 'closed' && (responsible || canManage),
      close: responsible && ['acknowledged', 'investigating'].includes(e.status),
      targets: TARGETS.filter((t) => !sameTarget(t, { role: e.responsible_role, level: e.responsible_level })),
    },
  });
});

const evidenceItem = z.object({ type: z.enum(['finding', 'case', 'parcel', 'task', 'audit_event', 'document', 'other']), reference: z.string().trim().min(1).max(200), note: z.string().trim().max(500).optional() });
const createBody = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(4000),
  countyId: z.number().int().positive(),
  caseId: z.string().uuid().optional(),
  parcelUpi: z.string().max(40).optional(),
  findingId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  evidence: z.array(evidenceItem).max(20).default([]),
  target: z.object({ role: z.enum(['supervisor', 'registrar', 'system_admin']), level: z.enum(['county', 'national']) }).optional(),
});

escalationsRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const created = await tx(async (client) => {
    enforce(req, 'escalation.create', { countyId: body.countyId }, { entityType: 'escalation' });
    const target = body.target ?? DEFAULT_TARGET[body.category];
    if (!TARGETS.some((t) => sameTarget(t, target))) throw badRequest('That role cannot receive escalations');
    // Linked records must exist in the same county; evidence ids from the client are verified.
    let parcelId: string | null = null;
    const evidence = [...body.evidence];
    if (body.caseId) {
      const { rows: [c] } = await client.query('SELECT county_id, case_no FROM lais.land_case WHERE id = $1', [body.caseId]);
      if (!c || c.county_id !== body.countyId) throw badRequest('The related application is not in this county');
      evidence.unshift({ type: 'case', reference: c.case_no });
    }
    if (body.parcelUpi) {
      const { rows: [p] } = await client.query('SELECT id, county_id FROM lais.parcel WHERE upi = $1', [body.parcelUpi]);
      if (!p || p.county_id !== body.countyId) throw badRequest('The parcel is not in this county');
      parcelId = p.id;
      evidence.unshift({ type: 'parcel', reference: body.parcelUpi });
    }
    if (body.findingId) {
      const { rows: [f] } = await client.query(
        'SELECT f.code, f.message, r.case_id FROM staging.finding f JOIN staging.validation_run r ON r.id = f.run_id WHERE f.id = $1', [body.findingId]);
      if (!f || f.case_id !== body.caseId) throw badRequest('The finding does not belong to the related application');
      evidence.unshift({ type: 'finding', reference: f.code, note: String(f.message).slice(0, 500) });
    }
    if (body.taskId) {
      const { rows: [t] } = await client.query('SELECT county_id, task_no FROM lais.task WHERE id = $1', [body.taskId]);
      if (!t || t.county_id !== body.countyId) throw badRequest('The task is not in this county');
      evidence.unshift({ type: 'task', reference: t.task_no });
    }
    const { rows: [x] } = await client.query(
      `INSERT INTO lais.escalation (category, severity, responsible_role, responsible_level, county_id, case_id, parcel_id, finding_id, task_id,
                                   title, description, evidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [body.category, body.severity, target.role, target.level, body.countyId, body.caseId ?? null, parcelId, body.findingId ?? null,
        body.taskId ?? null, body.title, body.description, JSON.stringify(evidence), req.auth!.user.id],
    );
    await event(client, { ...x, status: null }, req.auth!.user.id, 'opened', 'open', body.description);
    if (body.findingId) {
      await client.query(
        `INSERT INTO lais.conflict_review_event (finding_id, case_id, action, note, escalation_id, actor_id) VALUES ($1, $2, 'escalated', $3, $4, $5)`,
        [body.findingId, body.caseId, body.description, x.id, req.auth!.user.id],
      );
    }
    await notifyTarget(client, target, body.countyId, `Escalation ${x.escalation_no} (${body.severity}): ${body.title}`, body.description.slice(0, 200));
    await audit(req, x, 'create', { escalationNo: x.escalation_no, category: body.category, severity: body.severity, target }, client);
    return x;
  });
  res.status(201).json({ id: created.id, escalationNo: created.escalation_no, responsibleRole: created.responsible_role, responsibleLevel: created.responsible_level });
});

const noteBody = z.object({ note: z.string().trim().min(5).max(2000) });

escalationsRouter.post('/:id/acknowledge', async (req, res) => {
  const { note } = noteBody.partial().parse(req.body ?? {});
  await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    assertResponsible(req, e);
    if (e.status !== 'open') throw conflict(`Only an open escalation can be acknowledged (it is ${e.status})`);
    await client.query(`UPDATE lais.escalation SET status = 'acknowledged' WHERE id = $1`, [e.id]);
    await event(client, e, req.auth!.user.id, 'acknowledged', 'acknowledged', note);
    await notifyUsers(client, [e.created_by], { category: 'escalation', title: `Escalation ${e.escalation_no} was acknowledged`, link: '/supervisor/escalations' });
    await audit(req, e, 'acknowledge', {}, client);
  });
  res.json({ ok: true });
});

/** Active holders of the responsible role who could be assigned the escalation. */
escalationsRouter.get('/:id/assignees', async (req, res) => {
  const e = await load(pool, parseId(req.params.id));
  assertCanSee(req, e);
  assertResponsible(req, e);
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.username, u.display_name FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE u.status = 'active' AND r.role = $1 AND (r.county_id IS NULL OR ($2 = 'county' AND r.county_id = $3)) ORDER BY u.username`,
    [e.responsible_role, e.responsible_level, e.county_id],
  );
  res.json(rows);
});

const assignBody = z.object({ assigneeId: z.string().uuid(), note: z.string().trim().max(1000).optional() });

/** Assigns the escalation to a named holder of the responsible role. */
escalationsRouter.post('/:id/assign', async (req, res) => {
  const body = assignBody.parse(req.body);
  await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    assertResponsible(req, e);
    if (e.status === 'closed') throw conflict('The escalation is closed');
    const { rows: [u] } = await client.query(
      `SELECT u.id, u.username FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
        WHERE u.id = $1 AND u.status = 'active' AND r.role = $2 AND (r.county_id IS NULL OR ($3 = 'county' AND r.county_id = $4)) LIMIT 1`,
      [body.assigneeId, e.responsible_role, e.responsible_level, e.county_id],
    );
    if (!u) throw conflict(`The assignee must be an active ${e.responsible_role.replace('_', ' ')} able to act on this escalation`);
    await client.query('UPDATE lais.escalation SET assignee_id = $2 WHERE id = $1', [e.id, u.id]);
    await event(client, e, req.auth!.user.id, 'assigned', e.status, `${u.username}${body.note ? `: ${body.note}` : ''}`);
    await notifyUsers(client, [u.id], { category: 'escalation', title: `Escalation ${e.escalation_no} assigned to you`, link: '/supervisor/escalations' });
    await audit(req, e, 'assign', { assigneeId: u.id }, client);
  });
  res.json({ ok: true });
});

const investigateBody = z.object({
  note: z.string().trim().min(5).max(2000),
  assigneeId: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Requests further investigation, optionally as a task for an eligible officer. */
escalationsRouter.post('/:id/investigate', async (req, res) => {
  const body = investigateBody.parse(req.body);
  const result = await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    assertResponsible(req, e);
    if (e.status === 'open') throw conflict('Acknowledge the escalation first');
    if (e.status === 'closed') throw conflict('The escalation is closed');
    let task: { id: string; task_no: string } | null = null;
    if (body.assigneeId) {
      const type = e.finding_id ? 'conflict_investigation' : 'application_follow_up';
      await assertEligibleAssignee(client, body.assigneeId, type, e.county_id);
      ({ rows: [task] } = await client.query<{ id: string; task_no: string }>(
        `INSERT INTO lais.task (task_type, title, description, county_id, case_id, finding_id, escalation_id, assignee_id, status, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned', $9, $10) RETURNING id, task_no`,
        [type, `Investigate escalation ${e.escalation_no}`, body.note, e.county_id, e.case_id, e.finding_id, e.id, body.assigneeId, body.dueDate ?? null, req.auth!.user.id],
      ));
      await client.query(`INSERT INTO lais.task_event (task_id, actor_id, action, to_value, note) VALUES ($1, $2, 'created', $3, $4)`,
        [task!.id, req.auth!.user.id, body.assigneeId, `Created from escalation ${e.escalation_no}`]);
      await notifyUsers(client, [body.assigneeId], { category: 'task', title: `New task ${task!.task_no}: investigate escalation ${e.escalation_no}`, body: body.note.slice(0, 200), link: '/work/tasks' });
    }
    await client.query(`UPDATE lais.escalation SET status = 'investigating' WHERE id = $1`, [e.id]);
    await event(client, e, req.auth!.user.id, 'investigation_requested', 'investigating', task ? `${body.note} (task ${task.task_no})` : body.note);
    await audit(req, e, 'investigate', { taskId: task?.id ?? null }, client);
    return { task };
  });
  res.json(result);
});

const escalateBody = z.object({
  target: z.object({ role: z.enum(['supervisor', 'registrar', 'system_admin']), level: z.enum(['county', 'national']) }),
  reason: z.string().trim().min(10).max(2000),
});

/** Routes the escalation to another authorized role. It must be acknowledged again by its new owner. */
escalationsRouter.post('/:id/escalate', async (req, res) => {
  const body = escalateBody.parse(req.body);
  await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    assertResponsible(req, e);
    if (e.status === 'closed') throw conflict('The escalation is closed');
    if (!TARGETS.some((t) => sameTarget(t, body.target))) throw badRequest('That role cannot receive escalations');
    if (sameTarget(body.target, { role: e.responsible_role, level: e.responsible_level })) throw conflict('The escalation is already with that role');
    await client.query(
      `UPDATE lais.escalation SET responsible_role = $2, responsible_level = $3, status = 'open', assignee_id = NULL WHERE id = $1`,
      [e.id, body.target.role, body.target.level],
    );
    await event(client, e, req.auth!.user.id, 'escalated', 'open', `To ${body.target.level} ${body.target.role.replace('_', ' ')}: ${body.reason}`);
    await notifyTarget(client, body.target, e.county_id, `Escalation ${e.escalation_no} was escalated to you`, body.reason.slice(0, 200));
    await audit(req, e, 'escalate', { from: { role: e.responsible_role, level: e.responsible_level }, to: body.target, reason: body.reason }, client);
  });
  res.json({ ok: true });
});

escalationsRouter.post('/:id/comments', async (req, res) => {
  const { note } = noteBody.parse(req.body);
  await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    if (e.status === 'closed') throw conflict('The escalation is closed');
    if (!isResponsible(req, e)) {
      if (!authorize(req.auth!.principal, 'escalation.manage_system').allowed) {
        enforce(req, 'escalation.manage', { countyId: e.county_id }, { entityType: 'escalation', entityId: e.id, caseId: e.case_id });
      }
    }
    await event(client, e, req.auth!.user.id, 'comment', e.status, note);
    await audit(req, e, 'comment', {}, client);
  });
  res.status(201).json({ ok: true });
});

const closeBody = z.object({ reason: z.string().trim().min(10).max(2000) });

/**
 * Closure policy: the escalation was acknowledged, the closer holds the responsible role, any linked task
 * is finished, and the reason is recorded. Closing changes no land record.
 */
escalationsRouter.post('/:id/close', async (req, res) => {
  const { reason } = closeBody.parse(req.body);
  await tx(async (client) => {
    const e = await load(client, parseId(req.params.id), true);
    assertCanSee(req, e);
    assertResponsible(req, e);
    if (!['acknowledged', 'investigating'].includes(e.status)) {
      throw conflict(e.status === 'closed' ? 'Already closed' : 'Acknowledge the escalation before closing it');
    }
    const { rows: open } = await client.query(
      `SELECT task_no FROM lais.task WHERE status NOT IN ('completed', 'cancelled') AND (id = $1 OR escalation_id = $2)`,
      [e.task_id, e.id],
    );
    if (open.length > 0) throw conflict(`Finish or cancel the linked task(s) first: ${open.map((t) => t.task_no).join(', ')}`);
    await client.query(`UPDATE lais.escalation SET status = 'closed', closed_at = now(), closed_by = $2, closure_reason = $3 WHERE id = $1`, [e.id, req.auth!.user.id, reason]);
    await event(client, e, req.auth!.user.id, 'closed', 'closed', reason);
    await notifyUsers(client, [e.created_by, e.assignee_id], { category: 'escalation', title: `Escalation ${e.escalation_no} was closed`, body: reason.slice(0, 200), link: '/supervisor/escalations' });
    await audit(req, e, 'close', { reason }, client);
  });
  res.json({ ok: true });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /escalations', listQuery);
documentBody('POST /escalations', createBody);
documentBody('POST /escalations/{id}/acknowledge', noteBody.partial());
documentBody('POST /escalations/{id}/assign', assignBody);
documentBody('POST /escalations/{id}/investigate', investigateBody);
documentBody('POST /escalations/{id}/escalate', escalateBody);
documentBody('POST /escalations/{id}/comments', noteBody);
documentBody('POST /escalations/{id}/close', closeBody);
