import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool, type Db } from '../db.js';
import { HttpError } from '../http.js';
import { loadGrants } from './session.js';

/**
 * Personal ArcMap synchronization tokens. A GIS officer creates one in the web application and gives it
 * to the ArcMap adapter through an environment variable or a file only they can read: the adapter never
 * holds a database password or the officer's own password. The token works only on the sync endpoints,
 * carries the officer's current roles and counties (so revoking a role takes effect at once), expires,
 * and can be revoked. Only a SHA-256 hash is stored; the token is shown once.
 */

export const SYNC_TOKEN_PREFIX = 'lais_sync_';
export const MAX_SYNC_TOKEN_DAYS = 90;
const hash = (token: string) => createHash('sha256').update(token).digest();

export async function createSyncToken(db: Db, userId: string, label: string, days: number) {
  const token = SYNC_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const { rows: [t] } = await db.query(
    `INSERT INTO lais.sync_token (user_id, label, token_hash, token_hint, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, label, token_hint, created_at, expires_at`,
    [userId, label, hash(token), token.slice(-4), Math.min(Math.max(1, days), MAX_SYNC_TOKEN_DAYS)],
  );
  return { ...t, token };
}

export async function listSyncTokens(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, label, token_hint, created_at, expires_at, last_used_at, revoked_at,
            CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS status
       FROM lais.sync_token WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeSyncToken(db: Db, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE lais.sync_token SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Authenticates a sync request from its bearer token. No cookie is involved, so CSRF does not apply.
 * The account must be active and still hold a GIS officer role; the route then checks the county.
 */
export async function requireSyncToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(SYNC_TOKEN_PREFIX) || token.length > 120) throw new HttpError(401, 'A valid ArcMap sync token is required (Authorization: Bearer lais_sync_...)');
  const { rows: [row] } = await pool.query(
    `UPDATE lais.sync_token t SET last_used_at = now()
       FROM lais.app_user u
      WHERE t.token_hash = $1 AND u.id = t.user_id AND t.revoked_at IS NULL AND t.expires_at > now() AND u.status = 'active'
  RETURNING t.id AS token_id, u.id, u.username, u.display_name, (u.mfa_secret_enc IS NOT NULL) AS mfa_enrolled`,
    [hash(token)],
  );
  if (!row) throw new HttpError(401, 'The sync token is invalid, expired or revoked');
  const grants = (await loadGrants(pool, row.id)).filter((g) => g.role === 'gis_officer');
  if (grants.length === 0) throw new HttpError(403, 'The token belongs to an account that no longer holds a GIS officer role');
  req.auth = {
    tokenHash: Buffer.alloc(0),
    state: 'active',
    csrfToken: '',
    user: { id: row.id, username: row.username, displayName: row.display_name, mfaEnrolled: row.mfa_enrolled },
    // Only the GIS officer grants: a token never carries any other role the account may hold.
    principal: { userId: row.id, grants },
    via: 'sync_token',
    syncTokenId: row.token_id,
  };
  next();
}
