import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError, badRequest } from '../http.js';
import { writeAudit } from '../audit.js';
import { PRIVILEGED_ROLES, type Role } from '../authz/policy.js';
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

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const mfaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const GENERIC_LOGIN_FAILURE = 'Invalid username or password, or the account is temporarily locked';
const MAX_FAILURES_BEFORE_LOCK = 5;

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

authRouter.post('/login', loginLimiter, async (req, res) => {
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
    return fail('bad_password', user.id);
  }
  if (user.status !== 'active') return fail(`account_${user.status}`, user.id);

  await pool.query('UPDATE lais.app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const privileged = (user.roles as Role[]).some((r) => PRIVILEGED_ROLES.includes(r));
  const state: SessionState = user.mfa_secret_enc
    ? 'mfa_pending'
    : config.mfaEnforced && privileged ? 'enrollment_required' : 'active';
  await createSession(req, res, user.id, state);
  await writeAudit(req, { action: 'auth.login', outcome: 'success', entityType: 'user', entityId: user.id, actor: { id: user.id, username }, detail: { state } });
  res.json({ state });
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
