import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../http.js';
import { writeAudit } from '../audit.js';
import { authorize, scopeFor } from '../authz/policy.js';
import { documentQuery } from '../openapi.js';

/**
 * Supervisors and auditors see the full trail (read-only). System administrators see security and
 * system events (sign-ins, access denials, account and role changes, GIS imports, configuration,
 * backups, reports) and the status changes of cases, but not land-record content such as rights,
 * parties, document access or registrar notes: for case events they get the action and case only.
 */
export const auditRouter = Router();

const TECHNICAL_PREFIXES = ['auth.', 'admin.', 'authz.', 'staging.', 'county.', 'settings.', 'document_category.', 'backup.', 'report.', 'system.', 'audit.'];
const CASE_STATUS_ACTIONS = ['case.create', 'case.submit', 'case.approve', 'case.reject', 'case.return', 'case.publish', 'case.withdraw'];

/** 'all', 'technical' (administrators), or the counties a county-assigned supervisor may see. */
function auditScope(req: Request): 'all' | 'technical' | number[] {
  const p = req.auth!.principal;
  if (authorize(p, 'audit.view_all').allowed) return 'all';
  if (authorize(p, 'audit.view_technical').allowed) return 'technical';
  const counties = scopeFor(p, 'audit.view_county');
  if (counties !== 'all' && counties.length > 0) return counties;
  throw new HttpError(403, 'This action requires the supervisor, auditor or system administrator role');
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  action: z.string().max(60).optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  caseId: z.string().uuid().optional(),
  actor: z.string().max(64).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(100).optional(),
  countyId: z.coerce.number().int().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Cursor: return events older than this chain sequence number. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

auditRouter.get('/', async (req, res) => {
  const scope = auditScope(req);
  const q = listQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT e.chain_seq, e.at, e.actor_username, e.action, e.outcome, e.entity_type, e.entity_id, e.county_id, co.code AS county_code,
            e.case_id, e.ip, encode(e.hash, 'hex') AS hash,
            CASE WHEN $10::boolean OR e.action NOT LIKE 'case.%' THEN e.detail ELSE '{}'::jsonb END AS detail
       FROM audit.event e LEFT JOIN lais.county co ON co.id = e.county_id
      WHERE ($1::text IS NULL OR e.action LIKE $1 || '%')
        AND ($2::text IS NULL OR e.outcome = $2)
        AND ($3::uuid IS NULL OR e.case_id = $3)
        AND ($4::text IS NULL OR e.actor_username = $4)
        AND ($5::text IS NULL OR e.entity_type = $5)
        AND ($6::text IS NULL OR e.entity_id = $6)
        AND ($7::smallint IS NULL OR e.county_id = $7)
        AND ($8::date IS NULL OR e.at >= $8::date)
        AND ($9::date IS NULL OR e.at < $9::date + 1)
        AND ($10::boolean OR split_part(e.action, '.', 1) || '.' = ANY($11) OR e.action = ANY($12))
        AND ($13::bigint IS NULL OR e.chain_seq < $13)
        AND ($15::smallint[] IS NULL OR e.county_id = ANY($15))
      ORDER BY e.chain_seq DESC LIMIT $14`,
    [q.action ?? null, q.outcome ?? null, q.caseId ?? null, q.actor ?? null, q.entityType ?? null, q.entityId ?? null,
      q.countyId ?? null, q.from ?? null, q.to ?? null, scope !== 'technical', TECHNICAL_PREFIXES, CASE_STATUS_ACTIONS, q.before ?? null, q.limit,
      Array.isArray(scope) ? scope : null],
  );
  res.json({ scope: Array.isArray(scope) ? 'county' : scope, events: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].chain_seq : null });
});

auditRouter.get('/verify', async (req, res) => {
  if (auditScope(req) !== 'all') throw new HttpError(403, 'Only supervisors and auditors can verify the audit chain');
  const { rows: [result] } = await pool.query('SELECT * FROM audit.verify_chain()');
  const intact = result.first_bad_seq === null;
  await writeAudit(req, { action: 'audit.verify_chain', outcome: intact ? 'success' : 'failure', detail: { checked: Number(result.checked), firstBadSeq: result.first_bad_seq } });
  res.json({ intact, checked: Number(result.checked), firstBadSeq: result.first_bad_seq });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /audit', listQuery);
