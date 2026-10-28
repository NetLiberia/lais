import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config, isProduction } from '../config.js';
import { pool, type Db } from '../db.js';
import { HttpError } from '../http.js';
import type { Principal, Role } from '../authz/policy.js';

export const SESSION_COOKIE = 'lais_sid';

export type SessionState = 'active' | 'mfa_pending' | 'enrollment_required';

export interface AuthContext {
  tokenHash: Buffer;
  state: SessionState;
  csrfToken: string;
  user: { id: string; username: string; displayName: string; mfaEnrolled: boolean };
  principal: Principal;
  /** How the request authenticated: a browser session (default) or an ArcMap sync token. */
  via?: 'session' | 'sync_token';
  syncTokenId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

/** Creates a new server-side session and sets the cookie. Only a hash of the token is stored. */
export async function createSession(req: Request, res: Response, userId: string, state: SessionState): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO lais.session (token_hash, user_id, state, csrf_token, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), now() + make_interval(hours => $6), $7, $8)`,
    [hashToken(token), userId, state, csrf, config.sessionIdleMinutes, config.sessionAbsoluteHours, req.ip ?? null,
      req.get('user-agent')?.slice(0, 300) ?? null],
  );
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: isProduction, path: '/' });
}

/** Replaces the current session (e.g. after MFA) so a pre-authentication token can never become a full session. */
export async function rotateSession(req: Request, res: Response, state: SessionState): Promise<void> {
  if (!req.auth) throw new HttpError(401, 'Authentication required');
  await revokeSession(req.auth.tokenHash);
  await createSession(req, res, req.auth.user.id, state);
}

export async function revokeSession(tokenHash: Buffer): Promise<void> {
  await pool.query('UPDATE lais.session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
}

export async function revokeAllSessions(db: Db, userId: string, exceptTokenHash?: Buffer): Promise<void> {
  await db.query(
    `UPDATE lais.session SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::bytea IS NULL OR token_hash <> $2)`,
    [userId, exceptTokenHash ?? null],
  );
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: isProduction, path: '/' });
}

export async function loadGrants(db: Db, userId: string): Promise<Principal['grants']> {
  const { rows } = await db.query<{ role: Role; county_id: number | null }>(
    'SELECT role, county_id FROM lais.role_assignment WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rows.map((r) => ({ role: r.role, countyId: r.county_id }));
}

/** Loads the session (if any) on every request and slides the idle timeout. */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length === 0 || token.length > 100) return next();

  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `UPDATE lais.session s
        SET expires_at = LEAST(now() + make_interval(mins => $2), s.absolute_expires_at)
       FROM lais.app_user u
      WHERE s.token_hash = $1 AND u.id = s.user_id
        AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
  RETURNING s.state, s.csrf_token, u.id, u.username, u.display_name, (u.mfa_secret_enc IS NOT NULL) AS mfa_enrolled`,
    [tokenHash, config.sessionIdleMinutes],
  );
  const row = rows[0];
  if (!row) return next();

  req.auth = {
    tokenHash,
    state: row.state,
    csrfToken: row.csrf_token,
    user: { id: row.id, username: row.username, displayName: row.display_name, mfaEnrolled: row.mfa_enrolled },
    principal: { userId: row.id, grants: await loadGrants(pool, row.id) },
  };
  next();
}

export function requireActiveSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.state !== 'active') throw new HttpError(401, 'Authentication required');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Synchroniser-token CSRF check for state-changing requests that carry a session cookie. */
export function csrfProtect(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.auth) return next(); // no session cookie => nothing for a forged request to ride on
  const header = req.get('x-csrf-token') ?? '';
  const expected = Buffer.from(req.auth.csrfToken);
  const given = Buffer.from(header);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'Missing or invalid CSRF token');
  }
  next();
}
