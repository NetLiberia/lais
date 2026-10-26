import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../http.js';
import { writeAudit } from '../audit.js';
import { authorize } from '../authz/policy.js';

/**
 * Supervisors and auditors see the full trail (read-only). System administrators see only
 * technical events (authentication and account administration), not land-record activity.
 */
export const auditRouter = Router();

const TECHNICAL_PREFIXES = ['auth.', 'admin.'];

function auditScope(req: Request): 'all' | 'technical' {
  const p = req.auth!.principal;
  if (authorize(p, 'audit.view_all').allowed) return 'all';
  if (authorize(p, 'audit.view_technical').allowed) return 'technical';
  throw new HttpError(403, 'This action requires the supervisor, auditor or system administrator role');
}

const listQuery = z.object({
  action: z.string().max(60).optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  caseId: z.string().uuid().optional(),
  actor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

auditRouter.get('/', async (req, res) => {
  const scope = auditScope(req);
  const q = listQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT chain_seq, at, actor_username, action, outcome, entity_type, entity_id, county_id, case_id, ip, detail,
            encode(hash, 'hex') AS hash
       FROM audit.event
      WHERE ($1::text IS NULL OR action LIKE $1 || '%')
        AND ($2::text IS NULL OR outcome = $2)
        AND ($3::uuid IS NULL OR case_id = $3)
        AND ($4::text IS NULL OR actor_username = $4)
        AND ($5::boolean OR split_part(action, '.', 1) || '.' = ANY($6))
      ORDER BY chain_seq DESC LIMIT $7`,
    [q.action ?? null, q.outcome ?? null, q.caseId ?? null, q.actor ?? null, scope === 'all', TECHNICAL_PREFIXES, q.limit],
  );
  res.json({ scope, events: rows });
});

auditRouter.get('/verify', async (req, res) => {
  if (auditScope(req) !== 'all') throw new HttpError(403, 'Only supervisors and auditors can verify the audit chain');
  const { rows: [result] } = await pool.query('SELECT * FROM audit.verify_chain()');
  const intact = result.first_bad_seq === null;
  await writeAudit(req, { action: 'audit.verify_chain', outcome: intact ? 'success' : 'failure', detail: { checked: Number(result.checked), firstBadSeq: result.first_bad_seq } });
  res.json({ intact, checked: Number(result.checked), firstBadSeq: result.first_bad_seq });
});
