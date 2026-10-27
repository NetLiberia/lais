import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

export type TokenPurpose = 'activation' | 'password_reset';

const LIFETIME_HOURS: Record<TokenPurpose, number> = { activation: 72, password_reset: 24 };

/**
 * Issues a single-use link for account activation or an administrator-initiated password reset.
 * Earlier unused tokens of the same purpose are revoked. Only the token's hash is stored; the token
 * is returned once so the administrator can hand it over through an official channel (no e-mail
 * delivery exists in the prototype).
 */
export async function issueAccountToken(db: Db, userId: string, purpose: TokenPurpose, createdBy: string) {
  await db.query(
    `UPDATE lais.account_token SET revoked_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, purpose],
  );
  const token = randomBytes(32).toString('base64url');
  const { rows: [row] } = await db.query(
    `INSERT INTO lais.account_token (user_id, purpose, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
    [userId, purpose, createHash('sha256').update(token).digest(), createdBy, LIFETIME_HOURS[purpose]],
  );
  return { path: `/account/complete?token=${token}`, expiresAt: row.expires_at as Date };
}
