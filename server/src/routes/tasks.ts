import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { notifyUsers } from '../services/notify.js';
import { TASK_TYPES, TASK_TYPE_KEYS, assertEligibleAssignee, type TaskType } from '../services/supervision.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Operational tasks. Supervisors create, assign, reassign, reprioritise, return and cancel them;
 * the assignee starts, blocks, comments on and completes them. A task is a work item only: it never
 * grants its assignee any permission. Tasks are never deleted, and every change is a task event.
 */
export const tasksRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ['unassigned', 'assigned', 'in_progress', 'blocked', 'returned', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];
const OPEN = ['unassigned', 'assigned', 'in_progress', 'blocked', 'returned'];

/** Moves an assignee may make on their own task. */
const ASSIGNEE_MOVES: Partial<Record<Status, Status[]>> = {
  assigned: ['in_progress', 'completed'],
  returned: ['in_progress', 'completed'],
  in_progress: ['blocked', 'completed'],
  blocked: ['in_progress'],
};
/** Moves only a supervisor may make. */
const SUPERVISOR_MOVES: Partial<Record<Status, Status[]>> = {
  completed: ['returned'],
  unassigned: ['cancelled'],
  assigned: ['cancelled'],
  in_progress: ['cancelled'],
  blocked: ['cancelled'],
  returned: ['cancelled'],
};
/** Moves that need a note: why it is blocked, what was done, why it is returned or cancelled. */
const NOTE_REQUIRED: Status[] = ['blocked', 'completed', 'returned', 'cancelled'];

interface TaskRow {
  id: string; task_no: string; task_type: TaskType; title: string; county_id: number; case_id: string | null;
  assignee_id: string | null; status: Status; priority: string; due_date: Date | null; notify_assignee: boolean; created_by: string;
}

async function loadTask(db: pg.PoolClient | typeof pool, id: string, lock = false): Promise<TaskRow> {
  const { rows: [t] } = await db.query<TaskRow>(`SELECT * FROM lais.task WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!t) throw notFound('Task not found');
  return t;
}

const isSupervisorFor = (req: Request, t: TaskRow) => authorize(req.auth!.principal, 'task.manage', { countyId: t.county_id }).allowed;
const isAssignee = (req: Request, t: TaskRow) => t.assignee_id === req.auth!.user.id;
/** The officer who created a task (for example a processor's GIS handoff) follows it and can comment on it. */
const isCreator = (req: Request, t: TaskRow) => t.created_by === req.auth!.user.id;

/** Who may see a task: supervisors, registrars and auditors of its county, and its assignee. */
function assertCanSee(req: Request, t: TaskRow) {
  const p = req.auth!.principal;
  const overseer = p.grants.some((g) => ['supervisor', 'registrar', 'auditor'].includes(g.role) && (g.countyId === null || g.countyId === t.county_id));
  if (overseer || isAssignee(req, t) || isCreator(req, t)) return;
  enforce(req, 'task.manage', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
}

async function event(db: pg.PoolClient, taskId: string, actorId: string, action: string, from: string | null, to: string | null, note?: string | null, reference?: string | null) {
  await db.query(
    `INSERT INTO lais.task_event (task_id, actor_id, action, from_value, to_value, note, reference) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, actorId, action, from, to, note ?? null, reference ?? null],
  );
}

const audit = (req: Request, t: { id: string; county_id: number; case_id: string | null }, action: string, detail: Record<string, unknown>, db: pg.PoolClient) =>
  writeAudit(req, { action: `task.${action}`, outcome: 'success', entityType: 'task', entityId: t.id, caseId: t.case_id, countyId: t.county_id, detail }, db);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const listQuery = z.object({
  view: z.enum(['mine', 'scope']).default('mine'),
  countyId: z.coerce.number().int().positive().optional(),
  status: z.union([z.enum(STATUSES), z.literal('open')]).optional(),
  assigneeId: z.string().uuid().optional(),
  type: z.enum(TASK_TYPE_KEYS).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  caseId: z.string().uuid().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(60).optional(),
  sort: z.enum(['due', 'priority', 'created', 'updated']).default('updated'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100, 200].includes(n)).default(25),
});
const SORT_SQL: Record<string, string> = {
  due: 't.due_date', priority: "array_position(ARRAY['urgent', 'high', 'normal', 'low'], t.priority)", created: 't.created_at', updated: 't.updated_at',
};

tasksRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const p = req.auth!.principal;
  let counties: number[] | null = null;
  let assigneeOnly: string | null = null;
  if (q.view === 'mine') {
    assigneeOnly = req.auth!.user.id;
  } else {
    // County-wide lists are for supervisors, registrars and auditors; preparers see their own tasks.
    const overseers = p.grants.filter((g) => ['supervisor', 'registrar', 'auditor'].includes(g.role));
    if (overseers.length === 0) throw new HttpError(403, 'Only supervisors, registrars and auditors can list all tasks of a county');
    counties = overseers.some((g) => g.countyId === null) ? null : [...new Set(overseers.map((g) => g.countyId as number))];
    if (q.countyId !== undefined) {
      if (counties !== null && !counties.includes(q.countyId)) enforce(req, 'task.manage', { countyId: q.countyId }, { entityType: 'county', entityId: String(q.countyId) });
      counties = [q.countyId];
    }
  }
  const statuses = q.status === 'open' ? OPEN : q.status ? [q.status] : null;
  const { rows } = await pool.query(
    `SELECT t.id, t.task_no, t.task_type, t.title, t.status, t.priority, t.due_date, t.created_at, t.updated_at, t.completed_at,
            t.county_id, co.code AS county_code, t.case_id, c.case_no, t.assignee_id, u.username AS assignee, cu.username AS created_by,
            (t.status = ANY($11) AND t.due_date < current_date) AS overdue,
            CASE WHEN t.status = ANY($11) AND t.due_date < current_date THEN current_date - t.due_date END AS days_overdue,
            count(*) OVER () AS total
       FROM lais.task t
       JOIN lais.county co ON co.id = t.county_id
       JOIN lais.app_user cu ON cu.id = t.created_by
       LEFT JOIN lais.app_user u ON u.id = t.assignee_id
       LEFT JOIN lais.land_case c ON c.id = t.case_id
      WHERE ($1::smallint[] IS NULL OR t.county_id = ANY($1)) AND ($2::uuid IS NULL OR t.assignee_id = $2)
        AND ($3::text[] IS NULL OR t.status = ANY($3)) AND ($4::uuid IS NULL OR t.assignee_id = $4)
        AND ($5::text IS NULL OR t.task_type = $5) AND ($6::text IS NULL OR t.priority = $6) AND ($7::uuid IS NULL OR t.case_id = $7)
        AND (NOT $8::boolean OR (t.status = ANY($11) AND t.due_date < current_date))
        AND ($9::text IS NULL OR t.task_no ILIKE '%' || $9 || '%' OR t.title ILIKE '%' || $9 || '%' OR c.case_no ILIKE '%' || $9 || '%')
      ORDER BY ${SORT_SQL[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, t.task_no
      LIMIT $10 OFFSET $12`,
    [counties, assigneeOnly, statuses, q.assigneeId ?? null, q.type ?? null, q.priority ?? null, q.caseId ?? null,
      q.overdue === 'true', q.q || null, q.pageSize, OPEN, (q.page - 1) * q.pageSize],
  );
  res.json({ items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize });
});

tasksRouter.get('/:id', async (req, res) => {
  const t = await loadTask(pool, parseId(req.params.id));
  assertCanSee(req, t);
  const [{ rows: [detail] }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT t.*, co.code AS county_code, co.name AS county_name, c.case_no, u.username AS assignee, cu.username AS created_by_username,
              b.source_filename, f.code AS finding_code, f.message AS finding_message
         FROM lais.task t JOIN lais.county co ON co.id = t.county_id JOIN lais.app_user cu ON cu.id = t.created_by
         LEFT JOIN lais.app_user u ON u.id = t.assignee_id LEFT JOIN lais.land_case c ON c.id = t.case_id
         LEFT JOIN staging.batch b ON b.id = t.batch_id LEFT JOIN staging.finding f ON f.id = t.finding_id
        WHERE t.id = $1`,
      [t.id],
    ),
    pool.query(
      `SELECT e.id, e.action, e.from_value, e.to_value, e.note, e.reference, e.at, u.username AS actor
         FROM lais.task_event e JOIN lais.app_user u ON u.id = e.actor_id WHERE e.task_id = $1 ORDER BY e.id`,
      [t.id],
    ),
  ]);
  const supervisor = isSupervisorFor(req, t);
  const mine = isAssignee(req, t) && authorize(req.auth!.principal, 'task.work', { countyId: t.county_id }).allowed;
  const moves = [...new Set([...(mine ? ASSIGNEE_MOVES[t.status] ?? [] : []), ...(supervisor ? SUPERVISOR_MOVES[t.status] ?? [] : [])])];
  res.json({
    task: { ...detail, type_label: TASK_TYPES[t.task_type].label },
    events,
    permitted: { moves, assign: supervisor && OPEN.includes(t.status), edit: supervisor && OPEN.includes(t.status), comment: supervisor || mine, followUp: supervisor && Boolean(t.assignee_id) && OPEN.includes(t.status) },
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const createBody = z.object({
  taskType: z.enum(TASK_TYPE_KEYS),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  instructions: z.string().trim().max(4000).optional(),
  reference: z.string().trim().max(200).optional(),
  countyId: z.number().int().positive(),
  caseId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  findingId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueDate: isoDate.optional(),
  notifyAssignee: z.boolean().default(true),
});

tasksRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const task = await tx(async (client) => {
    enforce(req, 'task.manage', { countyId: body.countyId }, { entityType: 'task' });
    // Linked records must exist and belong to the task's county; ids from the client are not trusted.
    if (body.caseId) {
      const { rows: [c] } = await client.query('SELECT county_id FROM lais.land_case WHERE id = $1', [body.caseId]);
      if (!c || c.county_id !== body.countyId) throw badRequest('The related application is not in this county');
    }
    if (body.batchId) {
      const { rows: [b] } = await client.query('SELECT case_id FROM staging.batch WHERE id = $1', [body.batchId]);
      if (!b || b.case_id !== body.caseId) throw badRequest('The GIS submission does not belong to the related application');
    }
    if (body.findingId) {
      const { rows: [f] } = await client.query('SELECT r.case_id FROM staging.finding f JOIN staging.validation_run r ON r.id = f.run_id WHERE f.id = $1', [body.findingId]);
      if (!f || f.case_id !== body.caseId) throw badRequest('The conflict does not belong to the related application');
    }
    if (body.dueDate && body.dueDate < new Date().toISOString().slice(0, 10)) throw badRequest('The due date is in the past');
    if (body.assigneeId) await assertEligibleAssignee(client, body.assigneeId, body.taskType, body.countyId);
    const { rows: [t] } = await client.query(
      `INSERT INTO lais.task (task_type, title, description, instructions, reference, county_id, case_id, batch_id, finding_id,
                              assignee_id, status, priority, due_date, notify_assignee, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, task_no, county_id, case_id`,
      [body.taskType, body.title, body.description ?? null, body.instructions ?? null, body.reference ?? null, body.countyId,
        body.caseId ?? null, body.batchId ?? null, body.findingId ?? null, body.assigneeId ?? null,
        body.assigneeId ? 'assigned' : 'unassigned', body.priority, body.dueDate ?? null, body.notifyAssignee, req.auth!.user.id],
    );
    await event(client, t.id, req.auth!.user.id, 'created', null, body.assigneeId ?? 'unassigned');
    if (body.assigneeId && body.notifyAssignee) {
      await notifyUsers(client, [body.assigneeId], { category: 'task', title: `New task ${t.task_no}: ${body.title}`, link: '/work/tasks' });
    }
    await audit(req, t, 'create', { taskNo: t.task_no, type: body.taskType, assigneeId: body.assigneeId ?? null, priority: body.priority }, client);
    return t;
  });
  res.status(201).json({ id: task.id, taskNo: task.task_no });
});

// ---------------------------------------------------------------------------
// Assignment, status, priority and due date, comments, follow-up
// ---------------------------------------------------------------------------

const assignBody = z.object({ assigneeId: z.string().uuid(), reason: z.string().trim().max(1000).optional() });

/** Assigns an unassigned task, or reassigns one (a reason is then required and kept in the history). */
tasksRouter.post('/:id/assign', async (req, res) => {
  const body = assignBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    enforce(req, 'task.manage', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} task cannot be assigned`);
    if (t.assignee_id === body.assigneeId) throw conflict('The task is already assigned to this person');
    const reassign = t.assignee_id !== null;
    if (reassign && (body.reason?.length ?? 0) < 5) throw badRequest('Give a reason for reassigning (at least 5 characters)');
    await assertEligibleAssignee(client, body.assigneeId, t.task_type, t.county_id);
    await client.query(`UPDATE lais.task SET assignee_id = $2, status = 'assigned' WHERE id = $1`, [t.id, body.assigneeId]);
    await event(client, t.id, req.auth!.user.id, reassign ? 'reassigned' : 'assigned', t.assignee_id, body.assigneeId, body.reason);
    await notifyUsers(client, [body.assigneeId], { category: 'task', title: `Task ${t.task_no} assigned to you: ${t.title}`, link: '/work/tasks' });
    if (reassign) await notifyUsers(client, [t.assignee_id], { category: 'task', title: `Task ${t.task_no} was reassigned`, body: body.reason, link: '/work/tasks' });
    await audit(req, t, reassign ? 'reassign' : 'assign', { from: t.assignee_id, to: body.assigneeId, reason: body.reason ?? null }, client);
  });
  res.json({ ok: true });
});

const statusBody = z.object({ to: z.enum(STATUSES), note: z.string().trim().max(2000).optional() });

/** Status changes, checked here (who may make which move) and by the database trigger (which moves exist). */
tasksRouter.post('/:id/status', async (req, res) => {
  const body = statusBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    assertCanSee(req, t);
    const mine = isAssignee(req, t) && authorize(req.auth!.principal, 'task.work', { countyId: t.county_id }).allowed;
    const supervisor = isSupervisorFor(req, t);
    const allowed = (mine && ASSIGNEE_MOVES[t.status]?.includes(body.to)) || (supervisor && SUPERVISOR_MOVES[t.status]?.includes(body.to));
    if (!allowed) {
      const byAssignee = ASSIGNEE_MOVES[t.status]?.includes(body.to);
      if (!byAssignee && !SUPERVISOR_MOVES[t.status]?.includes(body.to)) throw conflict(`A task cannot move from ${t.status} to ${body.to}`);
      const reason = byAssignee ? 'Only the assignee can make this change' : 'Only a supervisor of this county can make this change';
      throw new HttpError(403, reason).withAudit({
        action: 'authz.denied', outcome: 'denied', entityType: 'task', entityId: t.id, caseId: t.case_id, countyId: t.county_id,
        detail: { requestedAction: `task.status:${t.status}->${body.to}`, reason },
      });
    }
    if (NOTE_REQUIRED.includes(body.to) && (body.note?.length ?? 0) < 5) throw badRequest('Add a note (at least 5 characters)');
    if (body.to === 'completed' && mine) await assertWorkDone(client, t);
    const sets: string[] = ['status = $2'];
    if (body.to === 'in_progress') sets.push('started_at = coalesce(started_at, now())');
    if (body.to === 'completed') sets.push('completed_at = now()', 'completion_note = $3');
    if (body.to === 'returned') sets.push('completed_at = NULL', 'completion_note = NULL');
    if (body.to === 'cancelled') sets.push('cancel_reason = $3');
    const params: unknown[] = [t.id, body.to];
    if (sets.some((s) => s.includes('$3'))) params.push(body.note);
    await client.query(`UPDATE lais.task SET ${sets.join(', ')} WHERE id = $1`, params);
    const action = body.to === 'completed' ? 'completed' : body.to === 'returned' ? 'returned' : body.to === 'cancelled' ? 'cancelled' : 'status_changed';
    await event(client, t.id, req.auth!.user.id, action, t.status, body.to, body.note);
    // Tell the other side: the supervisor who created it hears about progress, the assignee about returns and cancellations.
    if (mine) await notifyUsers(client, [t.created_by], { category: 'task', title: `Task ${t.task_no} is now ${body.to.replace('_', ' ')}`, body: body.note, link: `/supervisor/tasks?task=${t.id}` });
    else await notifyUsers(client, [t.assignee_id], { category: 'task', title: `Task ${t.task_no} was ${body.to}`, body: body.note, link: '/work/tasks' });
    await audit(req, t, body.to === 'completed' ? 'complete' : body.to === 'returned' ? 'return' : body.to === 'cancelled' ? 'cancel' : 'status', { from: t.status, to: body.to }, client);
  });
  res.json({ ok: true });
});

/** Task types whose work is preparing a case's geometry: done only once the case has been (re)submitted. */
const CASE_SUBMISSION_TASKS: TaskType[] = ['gis_preparation', 'gis_validation_correction', 'correction_resubmission'];

/** A task cannot be marked complete while the workflow step it stands for is still open. */
async function assertWorkDone(client: pg.PoolClient, t: TaskRow) {
  if (!t.case_id) return;
  if (CASE_SUBMISSION_TASKS.includes(t.task_type)) {
    const { rows: [c] } = await client.query(
      `SELECT c.status, c.case_no, (SELECT max(created_at) FROM staging.submission s WHERE s.case_id = c.id) AS last_submitted
         FROM lais.land_case c WHERE c.id = $1`, [t.case_id]);
    if (c && (['draft', 'returned', 'validating'].includes(c.status) || !c.last_submitted)) {
      throw conflict(`${c.case_no} has not been submitted since the task was assigned: submit the case before completing the task`);
    }
  }
  if (t.task_type === 'conflict_investigation') {
    const { rows: [f] } = await client.query(
      `SELECT 1 FROM lais.conflict_review_event e WHERE e.case_id = $1 AND e.action = 'findings_submitted' AND e.actor_id = $2 LIMIT 1`,
      [t.case_id, t.assignee_id]);
    if (!f) throw conflict('Submit your investigation findings on the conflict before completing the task');
  }
}

/** An eligible officer of the county takes an unassigned task (recorded as a claim, visible to the supervisor). */
tasksRouter.post('/:id/claim', async (req, res) => {
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    enforce(req, 'task.work', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
    if (t.status !== 'unassigned' || t.assignee_id) throw conflict('Only an unassigned task can be claimed');
    await assertEligibleAssignee(client, req.auth!.user.id, t.task_type, t.county_id);
    await client.query(`UPDATE lais.task SET assignee_id = $2, status = 'assigned' WHERE id = $1`, [t.id, req.auth!.user.id]);
    await event(client, t.id, req.auth!.user.id, 'claimed', null, req.auth!.user.id, null);
    await notifyUsers(client, [t.created_by], { category: 'task', title: `Task ${t.task_no} was claimed by ${req.auth!.user.displayName}`, link: `/supervisor/tasks?task=${t.id}` });
    await audit(req, t, 'claim', {}, client);
  });
  res.json({ ok: true });
});

/** The assignee confirms they have seen the task (it stays assigned until they start it). */
tasksRouter.post('/:id/acknowledge', async (req, res) => {
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    if (!isAssignee(req, t)) throw new HttpError(403, 'Only the assignee can acknowledge a task');
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} task cannot be acknowledged`);
    await event(client, t.id, req.auth!.user.id, 'acknowledged', null, null, null);
    await notifyUsers(client, [t.created_by], { category: 'task', title: `Task ${t.task_no} was acknowledged`, link: `/supervisor/tasks?task=${t.id}` });
    await audit(req, t, 'acknowledge', {}, client);
  });
  res.json({ ok: true });
});

const clarificationBody = z.object({ question: z.string().trim().min(5).max(2000) });

/** The assignee asks the supervisor who created the task for clarification. */
tasksRouter.post('/:id/clarification', async (req, res) => {
  const { question } = clarificationBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    if (!isAssignee(req, t)) throw new HttpError(403, 'Only the assignee can request clarification');
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} task is closed`);
    await event(client, t.id, req.auth!.user.id, 'clarification_requested', null, null, question);
    await notifyUsers(client, [t.created_by], { category: 'task', title: `Clarification requested on task ${t.task_no}`, body: question.slice(0, 200), link: `/supervisor/tasks?task=${t.id}` });
    await audit(req, t, 'clarification_requested', {}, client);
  });
  res.status(201).json({ ok: true });
});

const updateBody = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueDate: isoDate.nullable().optional(),
  reason: z.string().trim().min(5).max(500),
}).refine((b) => b.priority !== undefined || b.dueDate !== undefined, 'Change the priority or the due date');

tasksRouter.patch('/:id', async (req, res) => {
  const body = updateBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    enforce(req, 'task.manage', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
    if (!OPEN.includes(t.status)) throw conflict(`A ${t.status} task cannot be changed`);
    if (body.priority !== undefined && body.priority !== t.priority) {
      await client.query('UPDATE lais.task SET priority = $2 WHERE id = $1', [t.id, body.priority]);
      await event(client, t.id, req.auth!.user.id, 'priority_changed', t.priority, body.priority, body.reason);
    }
    const oldDue = t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : null;
    if (body.dueDate !== undefined && body.dueDate !== oldDue) {
      await client.query('UPDATE lais.task SET due_date = $2 WHERE id = $1', [t.id, body.dueDate]);
      await event(client, t.id, req.auth!.user.id, 'due_date_changed', oldDue, body.dueDate, body.reason);
    }
    await notifyUsers(client, [t.assignee_id], { category: 'task', title: `Task ${t.task_no} was rescheduled or reprioritised`, body: body.reason, link: '/work/tasks' });
    await audit(req, t, 'update', { priority: body.priority ?? null, dueDate: body.dueDate ?? null, reason: body.reason }, client);
  });
  res.json({ ok: true });
});

const commentBody = z.object({ note: z.string().trim().min(2).max(2000), reference: z.string().trim().max(200).optional() });

tasksRouter.post('/:id/comments', async (req, res) => {
  const body = commentBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    if (!isAssignee(req, t) && !isCreator(req, t)) enforce(req, 'task.manage', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
    await event(client, t.id, req.auth!.user.id, 'comment', null, null, body.note, body.reference);
    const other = isAssignee(req, t) ? t.created_by : t.assignee_id;
    await notifyUsers(client, [other], { category: 'task', title: `New comment on task ${t.task_no}`, body: body.note.slice(0, 200), link: isAssignee(req, t) ? `/supervisor/tasks?task=${t.id}` : '/work/tasks' });
    await audit(req, t, 'comment', { reference: body.reference ?? null }, client);
  });
  res.status(201).json({ ok: true });
});

const followUpBody = z.object({ message: z.string().trim().min(5).max(1000) });

tasksRouter.post('/:id/follow-up', async (req, res) => {
  const { message } = followUpBody.parse(req.body);
  await tx(async (client) => {
    const t = await loadTask(client, parseId(req.params.id), true);
    enforce(req, 'task.manage', { countyId: t.county_id }, { entityType: 'task', entityId: t.id, caseId: t.case_id });
    if (!t.assignee_id || !OPEN.includes(t.status)) throw conflict('Only an open, assigned task can be followed up');
    await event(client, t.id, req.auth!.user.id, 'follow_up', null, null, message);
    await notifyUsers(client, [t.assignee_id], { category: 'task', title: `Follow-up on task ${t.task_no}`, body: message, link: '/work/tasks' });
    await audit(req, t, 'follow_up', {}, client);
  });
  res.json({ ok: true });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /tasks', listQuery);
documentBody('POST /tasks', createBody);
documentBody('POST /tasks/{id}/assign', assignBody);
documentBody('POST /tasks/{id}/status', statusBody);
documentBody('PATCH /tasks/{id}', updateBody);
documentBody('POST /tasks/{id}/comments', commentBody);
documentBody('POST /tasks/{id}/follow-up', followUpBody);
documentBody('POST /tasks/{id}/clarification', clarificationBody);
