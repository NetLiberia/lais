import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError, badRequest } from '../http.js';
import { writeAudit } from '../audit.js';
import { capabilities, PRIVILEGED_ROLES, type Role } from '../authz/policy.js';
import { notifyRoles } from '../services/notify.js';
import { createHash } from 'node:crypto';
import { DUMMY_HASH_PROMISE, hashPassword, passwordPolicyProblem, verifyPassword } from '../auth/password.js';
import { open, seal } from '../auth/secretBox.js';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import {
  clearSessionCookie,
  createSession,
  csrfProtect,
  requireActiveSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  type SessionState,
} from '../auth/session.js';
import { documentBody } from '../openapi.js';

export const authRouter = Router();

// Guessing is limited per account, not only per address: county offices often share one public IP,
// so a tight per-IP limit would lock a whole office out because of one person's mistakes.
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const limiterDefaults = { windowMs: FIFTEEN_MINUTES, standardHeaders: 'draft-7' as const, legacyHeaders: false };
const loginPerAccountLimiter = rateLimit({
  ...limiterDefaults,
  limit: 10,
  // Only failed attempts count: signing in on a second device or after an idle timeout is not guessing.
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${String(req.body?.username ?? '').trim().toLowerCase().slice(0, 64)}`,
  message: { error: 'Too many sign-in attempts for this account; try again in 15 minutes' },
});
// A generous ceiling per address still stops one machine trying passwords across many accounts.
const loginPerAddressLimiter = rateLimit({ ...limiterDefaults, limit: 300, message: { error: 'Too many sign-in attempts from this network; try again later' } });
const mfaLimiter = rateLimit({
  ...limiterDefaults,
  limit: 10,
  keyGenerator: (req) => `mfa:${req.auth?.user.id ?? 'no-session'}`,
  message: { error: 'Too many code attempts; try again in 15 minutes' },
});

const GENERIC_LOGIN_FAILURE = 'Invalid username or password, or the account is temporarily locked';
const MAX_FAILURES_BEFORE_LOCK = 5;

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

authRouter.post('/login', loginPerAddressLimiter, loginPerAccountLimiter, async (req, res) => {
  const body = loginBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { rows: [user] } = await pool.query(
    `SELECT u.*, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            array(SELECT role FROM lais.role_assignment r WHERE r.user_id = u.id AND r.revoked_at IS NULL) AS roles
       FROM lais.app_user u WHERE u.username = $1`,
    [username],
  );

  const fail = async (reason: string, actorId: string | null) => {
    await writeAudit(req, { action: 'auth.login', outcome: 'failure', entityType: 'user', entityId: actorId, actor: { id: actorId, username }, detail: { reason } });
    throw new HttpError(401, GENERIC_LOGIN_FAILURE);
  };

  if (!user) {
    await verifyPassword(await DUMMY_HASH_PROMISE, body.password);
    return fail('unknown_user', null);
  }
  if (user.locked) return fail('locked', user.id);
  if (!user.password_hash) {
    // Invited but not yet activated: same timing and same answer as a wrong password.
    await verifyPassword(await DUMMY_HASH_PROMISE, body.password);
    return fail('account_invited', user.id);
  }

  const ok = await verifyPassword(user.password_hash, body.password);
  if (!ok) {
    // Progressive, time-limited lock: slows guessing without letting an attacker lock accounts out for long.
    await pool.query(
      `UPDATE lais.app_user
          SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2
                                  THEN now() + least(interval '15 minutes', interval '1 minute' * power(2, failed_logins + 1 - $2))
                                  ELSE locked_until END
        WHERE id = $1`,
      [user.id, MAX_FAILURES_BEFORE_LOCK],
    );
    // Tell administrators when repeated failures lock an account (possible password guessing).
    if (user.failed_logins + 1 === MAX_FAILURES_BEFORE_LOCK) {
      await notifyRoles(pool, ['system_admin'], { category: 'security', title: `Account ${username} locked after repeated failed sign-ins`, link: `/admin/audit?actor=${encodeURIComponent(username)}` });
    }
    return fail('bad_password', user.id);
  }
  if (user.status !== 'active') return fail(`account_${user.status}`, user.id);

  await pool.query('UPDATE lais.app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);

  const privileged = (user.roles as Role[]).some((r) => PRIVILEGED_ROLES.includes(r));
  const state: SessionState = user.mfa_secret_enc
    ? 'mfa_pending'
    : config.mfaEnforced && privileged ? 'enrollment_required' : 'active';
  await createSession(req, res, user.id, state);
  await writeAudit(req, { action: 'auth.login', outcome: 'success', entityType: 'user', entityId: user.id, actor: { id: user.id, username }, detail: { state } });
  res.json({ state });
});

// ---------------------------------------------------------------------------
// Account activation and administrator-initiated password reset (public, token-based)
// ---------------------------------------------------------------------------

const tokenBody = z.object({ token: z.string().min(20).max(100) });
const activateBody = tokenBody.extend({ newPassword: z.string().max(256) });
const tokenLimiter = rateLimit({ ...limiterDefaults, limit: 30, message: { error: 'Too many attempts; try again later' } });

async function findToken(token: string) {
  const { rows: [row] } = await pool.query(
    `SELECT t.id, t.purpose, t.user_id, u.username, u.display_name, u.status
       FROM lais.account_token t JOIN lais.app_user u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()`,
    [createHash('sha256').update(token).digest()],
  );
  // Suspended or deactivated accounts cannot be (re)activated with an old link.
  if (!row || (row.purpose === 'password_reset' && row.status !== 'active') || (row.purpose === 'activation' && row.status !== 'invited')) {
    throw new HttpError(400, 'This link is invalid, expired or has already been used. Ask an administrator for a new one.');
  }
  return row;
}

/** Shows whose account a link is for, so the person can confirm before setting a password. */
authRouter.post('/token/inspect', tokenLimiter, async (req, res) => {
  const { token } = tokenBody.parse(req.body);
  const row = await findToken(token);
  res.json({ purpose: row.purpose, username: row.username, displayName: row.display_name });
});

authRouter.post('/token/complete', tokenLimiter, async (req, res) => {
  const body = activateBody.parse(req.body);
  const problem = passwordPolicyProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(body.newPassword);
  const row = await findToken(body.token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Single use: the update succeeds only if nobody used the token in the meantime.
    const used = await client.query('UPDATE lais.account_token SET used_at = now() WHERE id = $1 AND used_at IS NULL', [row.id]);
    if (!used.rowCount) throw new HttpError(400, 'This link has already been used.');
    await client.query(
      `UPDATE lais.app_user SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
              status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, updated_at = now()
        WHERE id = $1`,
      [row.user_id, hash],
    );
    await revokeAllSessions(client, row.user_id);
    await writeAudit(req, {
      action: row.purpose === 'activation' ? 'auth.account_activated' : 'auth.password_reset_completed',
      outcome: 'success', entityType: 'user', entityId: row.user_id, actor: { id: row.user_id, username: row.username },
    }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, username: row.username });
});

// Everything below needs an existing session and a CSRF token.
authRouter.use(csrfProtect);

authRouter.get('/session', async (req, res) => {
  if (!req.auth) return res.json({ authenticated: false });
  const { rows: counties } = await pool.query('SELECT id, code, name FROM lais.county ORDER BY id');
  const byId = new Map(counties.map((c) => [c.id, c]));
  res.json({
    authenticated: true,
    state: req.auth.state,
    csrfToken: req.auth.csrfToken,
    user: req.auth.user,
    grants: req.auth.state === 'active'
      ? req.auth.principal.grants.map((g) => ({ role: g.role, countyId: g.countyId, county: g.countyId ? byId.get(g.countyId) : null }))
      : [],
    // What the interface may offer. Every endpoint still checks permission and county scope itself.
    capabilities: req.auth.state === 'active' ? capabilities(req.auth.principal) : [],
    banner: req.auth.state === 'active'
      ? (await pool.query(`SELECT value FROM lais.system_setting WHERE key = 'portal.banner_message'`)).rows[0]?.value || null
      : null,
  });
});

authRouter.post('/logout', async (req, res) => {
  if (req.auth) {
    await revokeSession(req.auth.tokenHash);
    await writeAudit(req, { action: 'auth.logout', outcome: 'success', entityType: 'user', entityId: req.auth.user.id });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

const codeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

authRouter.post('/mfa/verify', mfaLimiter, async (req, res) => {
  if (!req.auth || req.auth.state !== 'mfa_pending') throw new HttpError(401, 'No sign-in awaiting a second factor');
  const { code } = codeBody.parse(req.body);
  const { rows: [user] } = await pool.query('SELECT mfa_secret_enc FROM lais.app_user WHERE id = $1', [req.auth.user.id]);
  if (!user?.mfa_secret_enc || !verifyTotp(open(user.mfa_secret_enc, config.mfaEncryptionKey), code)) {
    await writeAudit(req, { action: 'auth.mfa_verify', outcome: 'failure', entityType: 'user', entityId: req.auth.user.id });
    throw new HttpError(401, 'Invalid code');
  }
  await rotateSession(req, res, 'active');
  await writeAudit(req, { action: 'auth.mfa_verify', outcome: 'success', entityType: 'user', entityId: req.auth.user.id });
  res.json({ state: 'active' });
});

/** Starts TOTP enrolment. Allowed for active sessions and for sessions that must enrol before continuing. */
authRouter.post('/mfa/enroll/start', mfaLimiter, async (req, res) => {
  if (!req.auth || (req.auth.state !== 'active' && req.auth.state !== 'enrollment_required')) {
    throw new HttpError(401, 'Authentication required');
  }
  const secret = generateSecret();
  await pool.query('UPDATE lais.app_user SET mfa_pending_secret_enc = $2 WHERE id = $1', [req.auth.user.id, seal(secret, config.mfaEncryptionKey)]);
  res.json({ secret, otpauthUri: otpauthUri(secret, req.auth.user.username) });
});

authRouter.post('/mfa/enroll/confirm', mfaLimiter, async (req, res) => {
  if (!req.auth || (req.auth.state !== 'active' && req.auth.state !== 'enrollment_required')) {
    throw new HttpError(401, 'Authentication required');
  }
  const { code } = codeBody.parse(req.body);
  const { rows: [user] } = await pool.query('SELECT mfa_pending_secret_enc FROM lais.app_user WHERE id = $1', [req.auth.user.id]);
  if (!user?.mfa_pending_secret_enc) throw badRequest('Start enrolment first');
  if (!verifyTotp(open(user.mfa_pending_secret_enc, config.mfaEncryptionKey), code)) {
    await writeAudit(req, { action: 'auth.mfa_enroll', outcome: 'failure', entityType: 'user', entityId: req.auth.user.id });
    throw new HttpError(400, 'Invalid code; check the time on your device and try again');
  }
  await pool.query(
    'UPDATE lais.app_user SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL WHERE id = $1',
    [req.auth.user.id],
  );
  await rotateSession(req, res, 'active');
  await writeAudit(req, { action: 'auth.mfa_enroll', outcome: 'success', entityType: 'user', entityId: req.auth.user.id });
  res.json({ state: 'active' });
});

const passwordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().max(256) });

authRouter.post('/password', requireActiveSession, async (req, res) => {
  const body = passwordBody.parse(req.body);
  const problem = passwordPolicyProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const { rows: [user] } = await pool.query('SELECT password_hash FROM lais.app_user WHERE id = $1', [req.auth!.user.id]);
  if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
    await writeAudit(req, { action: 'auth.password_change', outcome: 'failure', entityType: 'user', entityId: req.auth!.user.id });
    throw new HttpError(400, 'Current password is incorrect');
  }
  await pool.query('UPDATE lais.app_user SET password_hash = $2, password_changed_at = now() WHERE id = $1', [
    req.auth!.user.id,
    await hashPassword(body.newPassword),
  ]);
  await revokeAllSessions(pool, req.auth!.user.id, req.auth!.tokenHash);
  await writeAudit(req, { action: 'auth.password_change', outcome: 'success', entityType: 'user', entityId: req.auth!.user.id });
  res.json({ ok: true });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentBody('POST /auth/login', loginBody);
documentBody('POST /auth/token/inspect', tokenBody);
documentBody('POST /auth/token/complete', activateBody);
documentBody(['POST /auth/mfa/verify', 'POST /auth/mfa/enroll/confirm'], codeBody);
documentBody('POST /auth/password', passwordBody);
