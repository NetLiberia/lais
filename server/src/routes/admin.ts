import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { COUNTY_SCOPED_ROLES, ROLES, roleCombinationProblem, type Role } from '../authz/policy.js';
import { hashPassword, passwordPolicyProblem } from '../auth/password.js';
import { revokeAllSessions } from '../auth/session.js';

/**
 * Account and role administration. Administrators manage accounts but hold no decision
 * authority, cannot change their own account, and every change is audited with a reason.
 */
export const adminRouter = Router();

adminRouter.use(async (req, _res, next) => {
  enforce(req, 'user.manage', {}, { entityType: 'user' });
  next();
});

function notSelf(req: Request, userId: string) {
  if (req.auth!.user.id === userId) throw new HttpError(403, 'Administrators cannot change their own account or roles');
}

adminRouter.get('/users', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.status, (u.mfa_secret_enc IS NOT NULL) AS mfa_enrolled, u.created_at,
            coalesce(json_agg(json_build_object('id', r.id, 'role', r.role, 'countyId', r.county_id, 'countyCode', c.code, 'grantedAt', r.granted_at))
                     FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM lais.app_user u
       LEFT JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
       LEFT JOIN lais.county c ON c.id = r.county_id
      GROUP BY u.id ORDER BY u.username`,
  );
  res.json(rows);
});

const createUserBody = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, 'Use 3-64 lowercase letters, digits, dots, dashes or underscores'),
  displayName: z.string().trim().min(2).max(120),
  temporaryPassword: z.string().max(256),
});

adminRouter.post('/users', async (req, res) => {
  const body = createUserBody.parse(req.body);
  const problem = passwordPolicyProblem(body.temporaryPassword);
  if (problem) throw badRequest(problem);
  const user = await tx(async (client) => {
    const exists = await client.query('SELECT 1 FROM lais.app_user WHERE username = $1', [body.username]);
    if (exists.rows[0]) throw conflict('That username is taken');
    const { rows: [u] } = await client.query(
      `INSERT INTO lais.app_user (username, display_name, password_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id, username`,
      [body.username, body.displayName, await hashPassword(body.temporaryPassword), req.auth!.user.id],
    );
    await writeAudit(req, { action: 'admin.user_create', outcome: 'success', entityType: 'user', entityId: u.id, detail: { username: u.username } }, client);
    return u;
  });
  res.status(201).json(user);
});

const grantBody = z.object({
  role: z.enum(ROLES),
  countyId: z.number().int().nullable().optional(),
  reason: z.string().trim().min(5).max(500),
});

adminRouter.post('/users/:id/roles', async (req, res) => {
  const userId = parseId(req.params.id);
  notSelf(req, userId);
  const body = grantBody.parse(req.body);
  const countyId = body.countyId ?? null;
  if (COUNTY_SCOPED_ROLES.includes(body.role) && countyId === null) throw badRequest(`${body.role} must be assigned to a county`);
  if (['system_admin', 'auditor', 'landowner'].includes(body.role) && countyId !== null) throw badRequest(`${body.role} is not county-scoped`);

  const grant = await tx(async (client) => {
    const { rows: [u] } = await client.query('SELECT id FROM lais.app_user WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw notFound('User not found');
    if (countyId !== null) {
      const c = await client.query('SELECT 1 FROM lais.county WHERE id = $1', [countyId]);
      if (!c.rows[0]) throw badRequest('Unknown county');
    }
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
    return g;
  });
  res.status(201).json(grant);
});

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

adminRouter.post('/users/:id/roles/:grantId/revoke', async (req, res) => {
  const userId = parseId(req.params.id);
  const grantId = parseId(req.params.grantId);
  notSelf(req, userId);
  const { reason } = reasonBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [g] } = await client.query(
      `UPDATE lais.role_assignment SET revoked_at = now(), revoked_by = $3, revoke_reason = $4
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING role, county_id`,
      [grantId, userId, req.auth!.user.id, reason],
    );
    if (!g) throw notFound('Active role assignment not found');
    await writeAudit(req, { action: 'admin.role_revoke', outcome: 'success', entityType: 'user', entityId: userId, countyId: g.county_id, detail: { role: g.role, reason, grantId } }, client);
  });
  res.json({ ok: true });
});

const statusBody = z.object({ status: z.enum(['active', 'suspended', 'deactivated']), reason: z.string().trim().min(5).max(500) });

adminRouter.post('/users/:id/status', async (req, res) => {
  const userId = parseId(req.params.id);
  notSelf(req, userId);
  const body = statusBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [u] } = await client.query('UPDATE lais.app_user SET status = $2 WHERE id = $1 RETURNING id', [userId, body.status]);
    if (!u) throw notFound('User not found');
    // Suspension takes effect immediately: existing sessions stop working.
    if (body.status !== 'active') await revokeAllSessions(client, userId);
    await writeAudit(req, { action: 'admin.user_status', outcome: 'success', entityType: 'user', entityId: userId, detail: body }, client);
  });
  res.json({ ok: true });
});
