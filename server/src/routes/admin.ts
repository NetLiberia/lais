import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { COUNTY_SCOPED_ROLES, permissionMatrix, ROLES, roleCombinationProblem, type Role } from '../authz/policy.js';
import { revokeAllSessions } from '../auth/session.js';
import { issueAccountToken } from '../services/accountTokens.js';
import { notifyUsers } from '../services/notify.js';

/**
 * Staff account and role administration. Administrators manage accounts but hold no legal decision
 * authority, cannot change their own status or roles, and every privileged change is audited with a reason.
 * There is no "surveyor" role: surveyors are external and never receive LAIS accounts.
 */
export const adminRouter = Router();

function notSelf(req: Request, userId: string) {
  if (req.auth!.user.id === userId) throw new HttpError(403, 'You cannot change your own account status or roles; ask another administrator');
}

const NATIONAL_ONLY: readonly Role[] = ['system_admin', 'auditor', 'landowner'];

/** Refuses a change that would leave no active administrator. */
async function assertNotLastAdmin(db: pg.PoolClient, userId: string) {
  const { rows: [target] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM lais.role_assignment WHERE user_id = $1 AND role = 'system_admin' AND revoked_at IS NULL) AS is_admin`,
    [userId],
  );
  if (!target.is_admin) return;
  const { rows: [others] } = await db.query(
    `SELECT count(*)::int AS n FROM lais.app_user u
       JOIN lais.role_assignment r ON r.user_id = u.id AND r.role = 'system_admin' AND r.revoked_at IS NULL
      WHERE u.status = 'active' AND u.id <> $1`,
    [userId],
  );
  if (others.n === 0) throw conflict('This is the last active administrator account; another administrator must exist first');
}

/** Validates a role assignment and returns the normalised county id. */
async function checkAssignment(db: pg.PoolClient, role: Role, countyId: number | null | undefined): Promise<number | null> {
  const county = countyId ?? null;
  if (COUNTY_SCOPED_ROLES.includes(role) && county === null) throw badRequest(`The ${role.replace('_', ' ')} role must be assigned to a county`);
  if (NATIONAL_ONLY.includes(role) && county !== null) throw badRequest(`The ${role.replace('_', ' ')} role is not county-scoped`);
  if (county !== null) {
    const { rows: [c] } = await db.query('SELECT id FROM lais.county WHERE id = $1', [county]);
    if (!c) throw badRequest('Unknown county');
  }
  return county;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const SORTS: Record<string, string> = {
  name: 'display_name', username: 'username', staffId: 'staff_id', status: 'status',
  lastLogin: 'last_login_at', created: 'created_at',
};

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  countyId: z.coerce.number().int().optional(),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated']).optional(),
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), 'Page size must be 10, 25, 50 or 100').default(25),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

adminRouter.get('/users', async (req, res) => {
  enforce(req, 'users.read', {}, { entityType: 'user' });
  const q = listQuery.parse(req.query);
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT u.id, u.username, u.display_name, u.email, u.staff_id, u.department, u.status, u.last_login_at,
              u.created_at, u.updated_at, (u.mfa_secret_enc IS NOT NULL) AS mfa_enrolled,
              coalesce(json_agg(json_build_object('id', r.id, 'role', r.role, 'countyId', r.county_id, 'countyCode', c.code,
                                                  'countyName', c.name, 'grantedAt', r.granted_at) ORDER BY r.granted_at)
                       FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM lais.app_user u
         LEFT JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
         LEFT JOIN lais.county c ON c.id = r.county_id
        WHERE ($1::text IS NULL OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%' OR u.staff_id ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR u.status = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM lais.role_assignment x WHERE x.user_id = u.id AND x.revoked_at IS NULL AND x.role = $3))
          AND ($4::smallint IS NULL OR EXISTS (SELECT 1 FROM lais.role_assignment x WHERE x.user_id = u.id AND x.revoked_at IS NULL AND x.county_id = $4))
          AND ($5::date IS NULL OR u.created_at >= $5::date)
          AND ($6::date IS NULL OR u.created_at < $6::date + 1)
        GROUP BY u.id
     )
     SELECT *, count(*) OVER ()::int AS total FROM base
      ORDER BY ${SORTS[q.sort]} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, username
      LIMIT $7 OFFSET $8`,
    [q.q ? escapeLike(q.q) : null, q.status ?? null, q.role ?? null, q.countyId ?? null, q.createdFrom ?? null, q.createdTo ?? null,
      q.pageSize, (q.page - 1) * q.pageSize],
  );
  const total = rows[0]?.total ?? 0;
  res.json({ items: rows.map(({ total: _t, ...r }) => r), total, page: q.page, pageSize: q.pageSize });
});

adminRouter.get('/users/:id', async (req, res) => {
  enforce(req, 'users.read', {}, { entityType: 'user' });
  const id = parseId(req.params.id);
  const { rows: [user] } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.staff_id, u.department, u.status, u.last_login_at,
            u.created_at, u.updated_at, u.password_changed_at, (u.mfa_secret_enc IS NOT NULL) AS mfa_enrolled,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked, cu.username AS created_by_username,
            EXISTS (SELECT 1 FROM lais.account_token t WHERE t.user_id = u.id AND t.purpose = 'activation'
                       AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()) AS activation_pending
       FROM lais.app_user u LEFT JOIN lais.app_user cu ON cu.id = u.created_by
      WHERE u.id = $1`,
    [id],
  );
  if (!user) throw notFound('User not found');
  const [roles, activity] = await Promise.all([
    pool.query(
      `SELECT r.id, r.role, r.county_id, c.code AS county_code, c.name AS county_name, r.grant_reason, r.granted_at, g.username AS granted_by,
              r.revoked_at, r.revoke_reason, v.username AS revoked_by
         FROM lais.role_assignment r
         LEFT JOIN lais.county c ON c.id = r.county_id
         LEFT JOIN lais.app_user g ON g.id = r.granted_by
         LEFT JOIN lais.app_user v ON v.id = r.revoked_by
        WHERE r.user_id = $1 ORDER BY r.granted_at DESC`,
      [id],
    ),
    // Account-related events only: what the account did when signing in and what was done to it.
    pool.query(
      `SELECT chain_seq, at, actor_username, action, outcome, detail - 'requestId' AS detail
         FROM audit.event
        WHERE (entity_type = 'user' AND entity_id = $2)
           OR (actor_id = $1 AND (action LIKE 'auth.%' OR action LIKE 'admin.%'))
        ORDER BY chain_seq DESC LIMIT 30`,
      [id, id],
    ),
  ]);
  res.json({
    user,
    roles: roles.rows.filter((r) => !r.revoked_at),
    roleHistory: roles.rows.filter((r) => r.revoked_at),
    activity: activity.rows,
    isSelf: id === req.auth!.user.id,
  });
});

const createBody = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, 'Use 3-64 lowercase letters, digits, dots, dashes or underscores'),
  displayName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  staffId: z.string().trim().regex(/^[A-Za-z0-9-]{2,32}$/, 'Staff identifier: 2-32 letters, digits or dashes').optional().or(z.literal('').transform(() => undefined)),
  department: z.string().trim().max(120).optional(),
  roles: z.array(z.object({ role: z.enum(ROLES), countyId: z.number().int().nullable().optional() })).min(1).max(10),
  reason: z.string().trim().min(5).max(500),
});

/** Creates an invited account. The person sets their own password through a single-use activation link. */
adminRouter.post('/users', async (req, res) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  enforce(req, 'roles.assign', {}, { entityType: 'user' });
  const body = createBody.parse(req.body);
  const combo = roleCombinationProblem(body.roles.map((r) => r.role));
  if (combo) throw badRequest(combo);

  const result = await tx(async (client) => {
    const { rows: dup } = await client.query(
      `SELECT username, email, staff_id FROM lais.app_user
        WHERE username = $1 OR ($2::text IS NOT NULL AND lower(email) = $2) OR ($3::text IS NOT NULL AND upper(staff_id) = upper($3))`,
      [body.username, body.email ?? null, body.staffId ?? null],
    );
    if (dup.some((d) => d.username === body.username)) throw conflict('That username is already in use');
    if (dup.length && body.email && dup.some((d) => d.email?.toLowerCase() === body.email)) throw conflict('That email address is already in use');
    if (dup.length) throw conflict('That staff identifier is already in use');

    const { rows: [user] } = await client.query(
      `INSERT INTO lais.app_user (username, display_name, email, staff_id, department, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'invited', $6) RETURNING id, username`,
      [body.username, body.displayName, body.email ?? null, body.staffId ?? null, body.department || null, req.auth!.user.id],
    );
    for (const r of body.roles) {
      const countyId = await checkAssignment(client, r.role, r.countyId);
      const ins = await client.query(
        `INSERT INTO lais.role_assignment (user_id, role, county_id, grant_reason, granted_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [user.id, r.role, countyId, body.reason, req.auth!.user.id],
      );
      if (!ins.rowCount) throw badRequest(`The ${r.role} role is listed twice for the same scope`);
    }
    const link = await issueAccountToken(client, user.id, 'activation', req.auth!.user.id);
    await writeAudit(req, {
      action: 'admin.user_create', outcome: 'success', entityType: 'user', entityId: user.id,
      detail: { username: user.username, roles: body.roles, reason: body.reason },
    }, client);
    return { user, activation: link };
  });
  res.status(201).json(result);
});

const profileBody = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  staffId: z.string().trim().regex(/^[A-Za-z0-9-]{2,32}$/).nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
});

adminRouter.patch('/users/:id', async (req, res) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  const id = parseId(req.params.id);
  const body = profileBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT * FROM lais.app_user WHERE id = $1 FOR UPDATE', [id]);
    if (!u) throw notFound('User not found');
    const next = {
      display_name: body.displayName ?? u.display_name,
      email: body.email !== undefined ? body.email : u.email,
      staff_id: body.staffId !== undefined ? body.staffId : u.staff_id,
      department: body.department !== undefined ? body.department : u.department,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (u[k] ?? null));
    if (changed.length === 0) return;
    await client.query(
      'UPDATE lais.app_user SET display_name = $2, email = $3, staff_id = $4, department = $5, updated_at = now() WHERE id = $1',
      [id, next.display_name, next.email, next.staff_id, next.department],
    );
    await writeAudit(req, { action: 'admin.user_update', outcome: 'success', entityType: 'user', entityId: id, detail: { fields: changed } }, client);
  });
  res.json({ ok: true });
});

const statusBody = z.object({ status: z.enum(['active', 'suspended', 'deactivated']), reason: z.string().trim().min(5).max(500) });

adminRouter.post('/users/:id/status', async (req, res) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  const userId = parseId(req.params.id);
  notSelf(req, userId);
  const body = statusBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT id, status FROM lais.app_user WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw notFound('User not found');
    if (u.status === 'invited' && body.status === 'active') throw conflict('An invited account becomes active when the person completes activation');
    if (u.status === body.status) throw conflict(`The account is already ${body.status}`);
    if (body.status !== 'active') await assertNotLastAdmin(client, userId);
    await client.query('UPDATE lais.app_user SET status = $2, updated_at = now() WHERE id = $1', [userId, body.status]);
    // Suspension takes effect immediately: existing sessions and outstanding links stop working.
    if (body.status !== 'active') {
      await revokeAllSessions(client, userId);
      await client.query('UPDATE lais.account_token SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId]);
    }
    await writeAudit(req, { action: 'admin.user_status', outcome: 'success', entityType: 'user', entityId: userId, detail: { from: u.status, to: body.status, reason: body.reason } }, client);
    await notifyUsers(client, [userId], { category: 'account', title: `Your account was set to ${body.status}`, body: body.reason });
  });
  res.json({ ok: true });
});

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

/** Starts a password reset: the current password stops working at once and a single-use link is issued. */
adminRouter.post('/users/:id/password-reset', async (req, res) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  const userId = parseId(req.params.id);
  notSelf(req, userId);
  const { reason } = reasonBody.parse(req.body);
  const link = await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT status FROM lais.app_user WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw notFound('User not found');
    if (u.status !== 'active') throw conflict('Only active accounts can be reset; an invited account needs a new activation link instead');
    await revokeAllSessions(client, userId);
    const issued = await issueAccountToken(client, userId, 'password_reset', req.auth!.user.id);
    await writeAudit(req, { action: 'admin.password_reset_initiated', outcome: 'success', entityType: 'user', entityId: userId, detail: { reason } }, client);
    await notifyUsers(client, [userId], { category: 'security', title: 'An administrator started a password reset for your account', body: reason });
    return issued;
  });
  res.json(link);
});

adminRouter.post('/users/:id/activation-link', async (req, res) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  const userId = parseId(req.params.id);
  const { reason } = reasonBody.parse(req.body);
  const link = await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT status FROM lais.app_user WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw notFound('User not found');
    if (u.status !== 'invited') throw conflict('This account is already activated');
    const issued = await issueAccountToken(client, userId, 'activation', req.auth!.user.id);
    await writeAudit(req, { action: 'admin.activation_link_reissued', outcome: 'success', entityType: 'user', entityId: userId, detail: { reason } }, client);
    return issued;
  });
  res.json(link);
});

// ---------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------

const grantBody = z.object({
  role: z.enum(ROLES),
  countyId: z.number().int().nullable().optional(),
  reason: z.string().trim().min(5).max(500),
});

adminRouter.post('/users/:id/roles', async (req, res) => {
  enforce(req, 'roles.assign', {}, { entityType: 'user' });
  const userId = parseId(req.params.id);
  notSelf(req, userId);
  const body = grantBody.parse(req.body);
  const grant = await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT id, status FROM lais.app_user WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw notFound('User not found');
    if (u.status === 'deactivated') throw conflict('Roles cannot be granted to a deactivated account');
    const countyId = await checkAssignment(client, body.role, body.countyId);
    const { rows: current } = await client.query<{ role: Role }>(
      'SELECT role FROM lais.role_assignment WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    const combo = roleCombinationProblem([...current.map((r) => r.role), body.role]);
    if (combo) throw conflict(combo);
    const { rows: [g] } = await client.query(
      `INSERT INTO lais.role_assignment (user_id, role, county_id, grant_reason, granted_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, body.role, countyId, body.reason, req.auth!.user.id],
    );
    if (!g) throw conflict('The user already holds that role in that scope');
    await writeAudit(req, { action: 'admin.role_grant', outcome: 'success', entityType: 'user', entityId: userId, countyId, detail: { role: body.role, reason: body.reason, grantId: g.id } }, client);
    await notifyUsers(client, [userId], { category: 'account', title: `You were given the ${body.role.replace('_', ' ')} role`, body: body.reason });
    return g;
  });
  res.status(201).json(grant);
});

adminRouter.post('/users/:id/roles/:grantId/revoke', async (req, res) => {
  enforce(req, 'roles.assign', {}, { entityType: 'user' });
  const userId = parseId(req.params.id);
  const grantId = parseId(req.params.grantId);
  notSelf(req, userId);
  const { reason } = reasonBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [current] } = await client.query(
      'SELECT role FROM lais.role_assignment WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE',
      [grantId, userId],
    );
    if (!current) throw notFound('Active role assignment not found');
    if (current.role === 'system_admin') await assertNotLastAdmin(client, userId);
    const { rows: [g] } = await client.query(
      `UPDATE lais.role_assignment SET revoked_at = now(), revoked_by = $3, revoke_reason = $4
        WHERE id = $1 AND user_id = $2 RETURNING role, county_id`,
      [grantId, userId, req.auth!.user.id, reason],
    );
    await writeAudit(req, { action: 'admin.role_revoke', outcome: 'success', entityType: 'user', entityId: userId, countyId: g.county_id, detail: { role: g.role, reason, grantId } }, client);
    await notifyUsers(client, [userId], { category: 'account', title: `Your ${g.role.replace('_', ' ')} role was removed`, body: reason });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Permission matrix (read-only: permissions change only through reviewed code)
// ---------------------------------------------------------------------------

adminRouter.get('/permissions', async (req, res) => {
  enforce(req, 'users.read', {}, { entityType: 'permission' });
  const { rows: counts } = await pool.query(
    `SELECT r.role, count(DISTINCT r.user_id)::int AS users
       FROM lais.role_assignment r JOIN lais.app_user u ON u.id = r.user_id
      WHERE r.revoked_at IS NULL AND u.status = 'active' GROUP BY r.role`,
  );
  res.json({ roles: ROLES.map((role) => ({ role, activeUsers: counts.find((c) => c.role === role)?.users ?? 0, countyScoped: COUNTY_SCOPED_ROLES.includes(role) })), permissions: permissionMatrix() });
});
