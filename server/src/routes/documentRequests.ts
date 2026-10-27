import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db.js';
import { badRequest, conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize, scopeFor, type ResourceContext } from '../authz/policy.js';
import { candidateDocuments } from '../services/documentRequests.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Staff side of landowner document requests: a processor prepares the release set,
 * a different registrar approves or refuses it. Both act only within their county.
 */
export const documentRequestsRouter = Router();

const listQuery = z.object({ status: z.enum(['submitted', 'prepared', 'approved', 'refused', 'withdrawn']).optional() });

documentRequestsRouter.get('/', async (req, res) => {
  const { status } = listQuery.parse(req.query);
  const scope = scopeFor(req.auth!.principal, 'docrequest.view');
  if (scope !== 'all' && scope.length === 0) enforce(req, 'docrequest.view', { countyId: null }, { entityType: 'document_request' });
  const { rows } = await pool.query(
    `SELECT r.id, r.request_no, r.status, r.created_at, r.updated_at, p.upi AS parcel_upi, c.code AS county_code,
            u.display_name AS requested_by_name, cardinality(r.document_types) AS type_count
       FROM lais.document_request r
       JOIN lais.parcel p ON p.id = r.parcel_id
       JOIN lais.county c ON c.id = r.county_id
       JOIN lais.app_user u ON u.id = r.requested_by
      WHERE ($1::smallint[] IS NULL OR r.county_id = ANY($1))
        AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.updated_at DESC LIMIT 500`,
    [scope === 'all' ? null : scope, status ?? null],
  );
  res.json(rows);
});

/** A row of lais.document_request. */
interface DocumentRequestRecord {
  id: string; request_no: string; requested_by: string; party_id: string; parcel_id: string; county_id: number;
  document_types: string[]; purpose: string; status: string; prepared_by: string | null; prepared_at: Date | null;
  preparation_note: string | null; decided_by: string | null; decided_at: Date | null; decision_reason: string | null;
  release_expires_at: Date | null; created_at: Date; updated_at: Date;
}

async function loadRequest(db: Db, id: string, lock = false): Promise<DocumentRequestRecord> {
  const { rows: [request] } = await db.query<DocumentRequestRecord>(
    `SELECT * FROM lais.document_request WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!request) throw notFound('Document request not found');
  return request;
}

const contextFor = (request: { county_id: number; prepared_by: string | null }): ResourceContext => ({
  countyId: request.county_id,
  contributorIds: request.prepared_by ? [request.prepared_by] : [],
});

documentRequestsRouter.get('/:id', async (req, res) => {
  const request = await loadRequest(pool, parseId(req.params.id));
  const ctx = contextFor(request);
  enforce(req, 'docrequest.view', ctx, { entityType: 'document_request', entityId: request.id });

  const [details, items, candidates] = await Promise.all([
    pool.query(
      `SELECT p.upi AS parcel_upi, c.name AS county_name, u.username AS requested_by_username, u.display_name AS requested_by_name,
              pa.name AS party_name, pu.username AS prepared_by_username, du.username AS decided_by_username,
              -- Whether the requester still holds the interest that made them eligible.
              EXISTS (SELECT 1 FROM lais.rrr r WHERE r.party_id = dr.party_id AND r.parcel_id = dr.parcel_id
                         AND r.valid_to IS NULL AND r.interest_status = 'registered') AS interest_current
         FROM lais.document_request dr
         JOIN lais.parcel p ON p.id = dr.parcel_id
         JOIN lais.county c ON c.id = dr.county_id
         JOIN lais.app_user u ON u.id = dr.requested_by
         JOIN lais.party pa ON pa.id = dr.party_id
         LEFT JOIN lais.app_user pu ON pu.id = dr.prepared_by
         LEFT JOIN lais.app_user du ON du.id = dr.decided_by
        WHERE dr.id = $1`,
      [request.id],
    ),
    pool.query('SELECT document_id FROM lais.document_request_item WHERE request_id = $1', [request.id]),
    candidateDocuments(pool, request.parcel_id),
  ]);

  const principal = req.auth!.principal;
  const allowedActions: string[] = [];
  if (request.status === 'submitted' && authorize(principal, 'docrequest.prepare', ctx).allowed) allowedActions.push('prepare');
  if (request.status === 'prepared' && authorize(principal, 'docrequest.decide', ctx).allowed) allowedActions.push('decide');
  const selected = new Set(items.rows.map((i) => i.document_id));

  res.json({
    request: { ...request, ...details.rows[0] },
    candidates: candidates.map((d) => ({ ...d, selected: selected.has(d.id) })),
    allowedActions,
    separationNotice: request.status === 'prepared' && request.prepared_by === principal.userId
      ? 'You prepared this release, so another registrar must decide it.'
      : null,
  });
});

const prepareBody = z.object({
  documentIds: z.array(z.string().uuid()).max(50),
  note: z.string().trim().min(5).max(1000),
});

/** Runs fn with the request locked, after checking the caller may act on it in its current state. */
async function inRequestTx<T>(req: Request, action: 'docrequest.prepare' | 'docrequest.decide', status: string, fn: (client: pg.PoolClient, request: DocumentRequestRecord) => Promise<T>) {
  const id = parseId(req.params.id);
  return tx(async (client) => {
    const request = await loadRequest(client, id, true);
    enforce(req, action, contextFor(request), { entityType: 'document_request', entityId: id });
    if (request.status !== status) throw conflict(`Not permitted while the request is ${request.status}`);
    return fn(client, request);
  });
}

documentRequestsRouter.post('/:id/prepare', async (req, res) => {
  const body = prepareBody.parse(req.body);
  await inRequestTx(req, 'docrequest.prepare', 'submitted', async (client, request) => {
    const candidates = await candidateDocuments(client, request.parcel_id);
    for (const docId of new Set(body.documentIds)) {
      const candidate = candidates.find((c) => c.id === docId);
      if (!candidate) throw badRequest('Only verified documents from published cases on this parcel can be released');
      if (!candidate.releasable) throw badRequest('Highly sensitive documents cannot be released through a document request');
      await client.query('INSERT INTO lais.document_request_item (request_id, document_id) VALUES ($1, $2)', [request.id, docId]);
    }
    await client.query(
      `UPDATE lais.document_request SET status = 'prepared', prepared_by = $2, prepared_at = now(), preparation_note = $3 WHERE id = $1`,
      [request.id, req.auth!.user.id, body.note],
    );
    await writeAudit(req, {
      action: 'docrequest.prepare', outcome: 'success', entityType: 'document_request', entityId: request.id, countyId: request.county_id,
      detail: { documentIds: [...new Set(body.documentIds)] },
    }, client);
  });
  res.json({ ok: true });
});

const decideBody = z.object({
  decision: z.enum(['approved', 'refused']),
  reason: z.string().trim().min(5).max(1000),
});

documentRequestsRouter.post('/:id/decide', async (req, res) => {
  const body = decideBody.parse(req.body);
  const status = await inRequestTx(req, 'docrequest.decide', 'prepared', async (client, request) => {
    if (body.decision === 'approved') {
      const { rows: [count] } = await client.query('SELECT count(*)::int AS n FROM lais.document_request_item WHERE request_id = $1', [request.id]);
      if (count.n === 0) throw conflict('No documents were prepared for release; refuse the request instead, with a reason');
      const stillEligible = await client.query(
        `SELECT 1 FROM lais.rrr WHERE party_id = $1 AND parcel_id = $2 AND valid_to IS NULL AND interest_status = 'registered'`,
        [request.party_id, request.parcel_id],
      );
      if (!stillEligible.rows[0]) throw conflict('The requester no longer holds a registered interest in this parcel; refuse the request');
    }
    await client.query(
      `UPDATE lais.document_request
          SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4,
              release_expires_at = CASE WHEN $2 = 'approved' THEN now() + make_interval(days => $5) END
        WHERE id = $1`,
      [request.id, body.decision, req.auth!.user.id, body.reason, config.documentReleaseDays],
    );
    await writeAudit(req, {
      action: body.decision === 'approved' ? 'docrequest.approve' : 'docrequest.refuse', outcome: 'success',
      entityType: 'document_request', entityId: request.id, countyId: request.county_id,
      detail: { reason: body.reason, releaseDays: body.decision === 'approved' ? config.documentReleaseDays : null },
    }, client);
    return body.decision;
  });
  res.json({ status });
});

// API description (/api/openapi.json): the schemas above, as validated by the handlers.
documentQuery('GET /document-requests', listQuery);
documentBody('POST /document-requests/{id}/prepare', prepareBody);
documentBody('POST /document-requests/{id}/decide', decideBody);
