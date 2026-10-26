import type { Request } from 'express';
import { pool, type Db } from './db.js';

export interface AuditEntry {
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  entityType?: string;
  entityId?: string | null;
  countyId?: number | null;
  caseId?: string | null;
  /** Never put passwords, tokens, document contents or identity numbers here. */
  detail?: Record<string, unknown>;
  actor?: { id: string | null; username: string | null };
}

/**
 * Appends an event to the hash-chained audit log.
 * Pass the transaction client to make the event commit or roll back with the change it describes;
 * pass the pool (the default) for events that must survive a rollback, such as denials and failures.
 */
export async function writeAudit(req: Request | null, entry: AuditEntry, db: Db = pool): Promise<void> {
  const actor = entry.actor ?? { id: req?.auth?.user.id ?? null, username: req?.auth?.user.username ?? null };
  await db.query(
    `INSERT INTO audit.event (actor_id, actor_username, action, outcome, entity_type, entity_id, county_id, case_id, ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.id,
      actor.username,
      entry.action,
      entry.outcome,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.countyId ?? null,
      entry.caseId ?? null,
      req?.ip ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
