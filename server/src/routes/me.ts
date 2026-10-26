import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { eligibleParty, REQUESTABLE_DOCUMENT_TYPES } from '../services/documentRequests.js';
import { sendStoredDocument } from '../services/storedDocuments.js';

/** Landowner portal: only the registered interests of the parties linked to this account. */
export const meRouter = Router();

meRouter.get('/parcels', async (req, res) => {
  enforce(req, 'landowner.view_own', {}, { entityType: 'parcel' });
  const { rows } = await pool.query(
    `SELECT p.upi, c.name AS county, p.status, v.land_category, v.land_use, v.area_m2_calculated,
            ST_AsGeoJSON(v.geom, 7)::json AS geometry,
            json_agg(json_build_object('rrrType', r.rrr_type, 'share', CASE WHEN r.share_den IS NULL THEN NULL ELSE r.share_num || '/' || r.share_den END,
                                       'interestStatus', r.interest_status, 'since', r.valid_from, 'holder', pa.name)) AS my_interests
       FROM lais.user_party_link l
       JOIN lais.party pa ON pa.id = l.party_id
       JOIN lais.rrr r ON r.party_id = pa.id AND r.valid_to IS NULL AND r.interest_status = 'registered'
       JOIN lais.parcel p ON p.id = r.parcel_id
       JOIN lais.parcel_version v ON v.id = p.current_version_id
       JOIN lais.county c ON c.id = p.county_id
      WHERE l.user_id = $1 AND l.revoked_at IS NULL
      GROUP BY p.id, c.name, v.id
      ORDER BY p.upi`,
    [req.auth!.user.id],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Document requests
// ---------------------------------------------------------------------------

const requestBody = z.object({
  parcelUpi: z.string().min(1).max(40),
  documentTypes: z.array(z.enum(REQUESTABLE_DOCUMENT_TYPES)).min(1).max(REQUESTABLE_DOCUMENT_TYPES.length),
  purpose: z.string().trim().min(10).max(1000),
});

meRouter.post('/document-requests', async (req, res) => {
  enforce(req, 'landowner.request_documents', {}, { entityType: 'document_request' });
  const body = requestBody.parse(req.body);
  const created = await tx(async (client) => {
    const { rows: [parcel] } = await client.query('SELECT id, county_id FROM lais.parcel WHERE upi = $1', [body.parcelUpi]);
    // The same answer whether the parcel is unknown or not theirs, so the endpoint cannot be used to probe the register.
    const party = parcel ? await eligibleParty(client, req.auth!.user.id, parcel.id) : null;
    if (!party) {
      throw new HttpError(403, 'You can request documents only for parcels in which your verified account holds a registered interest').withAudit({
        action: 'authz.denied', outcome: 'denied', entityType: 'parcel', entityId: parcel?.id ?? null, countyId: parcel?.county_id ?? null,
        detail: { requestedAction: 'landowner.request_documents', parcelUpi: body.parcelUpi },
      });
    }
    const { rows: [request] } = await client.query(
      `INSERT INTO lais.document_request (requested_by, party_id, parcel_id, county_id, document_types, purpose)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, request_no, status`,
      [req.auth!.user.id, party.id, parcel.id, parcel.county_id, [...new Set(body.documentTypes)], body.purpose],
    );
    await writeAudit(req, {
      action: 'docrequest.create', outcome: 'success', entityType: 'document_request', entityId: request.id, countyId: parcel.county_id,
      detail: { requestNo: request.request_no, parcelUpi: body.parcelUpi, documentTypes: body.documentTypes },
    }, client);
    return request;
  });
  res.status(201).json(created);
});

meRouter.get('/document-requests', async (req, res) => {
  enforce(req, 'landowner.request_documents', {}, { entityType: 'document_request' });
  const { rows } = await pool.query(
    `SELECT r.id, r.request_no, p.upi AS parcel_upi, r.document_types, r.purpose, r.status, r.created_at, r.decided_at,
            -- Refusal reasons are shown to the requester; internal preparation notes are not.
            CASE WHEN r.status IN ('approved', 'refused') THEN r.decision_reason END AS decision_reason,
            r.release_expires_at,
            (r.status = 'approved' AND r.release_expires_at > now()) AS release_active,
            CASE WHEN r.status = 'approved' THEN coalesce((
              SELECT json_agg(json_build_object('id', d.id, 'docType', d.doc_type, 'referenceNo', d.reference_no,
                                                'issuedOn', d.issued_on, 'fileName', d.original_name) ORDER BY d.doc_type)
                FROM lais.document_request_item i JOIN lais.document d ON d.id = i.document_id
               WHERE i.request_id = r.id), '[]'::json) END AS released_documents
       FROM lais.document_request r JOIN lais.parcel p ON p.id = r.parcel_id
      WHERE r.requested_by = $1
      ORDER BY r.created_at DESC`,
    [req.auth!.user.id],
  );
  res.json(rows);
});

meRouter.post('/document-requests/:id/withdraw', async (req, res) => {
  enforce(req, 'landowner.request_documents', {}, { entityType: 'document_request' });
  const id = parseId(req.params.id);
  await tx(async (client) => {
    const { rows: [request] } = await client.query(
      'SELECT * FROM lais.document_request WHERE id = $1 AND requested_by = $2 FOR UPDATE',
      [id, req.auth!.user.id],
    );
    if (!request) throw notFound('Request not found');
    if (!['submitted', 'prepared'].includes(request.status)) throw conflict('This request has already been decided');
    await client.query(`UPDATE lais.document_request SET status = 'withdrawn' WHERE id = $1`, [id]);
    await writeAudit(req, { action: 'docrequest.withdraw', outcome: 'success', entityType: 'document_request', entityId: id, countyId: request.county_id }, client);
  });
  res.json({ ok: true });
});

/**
 * Downloads a released document. Every condition is re-checked on each download: the request is
 * the caller's, approved and unexpired, the document is in its release set, and the caller still
 * holds a registered interest in the parcel.
 */
meRouter.get('/document-requests/:id/documents/:docId/file', async (req, res) => {
  enforce(req, 'landowner.request_documents', {}, { entityType: 'document_request' });
  const id = parseId(req.params.id);
  const docId = parseId(req.params.docId);
  const { rows: [row] } = await pool.query(
    `SELECT r.status, r.release_expires_at > now() AS active, r.parcel_id, r.county_id, r.request_no, d.*
       FROM lais.document_request r
       JOIN lais.document_request_item i ON i.request_id = r.id AND i.document_id = $2
       JOIN lais.document d ON d.id = i.document_id
      WHERE r.id = $1 AND r.requested_by = $3`,
    [id, docId, req.auth!.user.id],
  );
  const deny = (message: string, reason: string) =>
    new HttpError(403, message).withAudit({
      action: 'authz.denied', outcome: 'denied', entityType: 'document', entityId: docId, countyId: row?.county_id ?? null,
      detail: { requestedAction: 'docrequest.download', requestId: id, reason },
    });
  if (!row) throw deny('This document has not been released to you', 'not_in_release');
  if (row.status !== 'approved') throw deny('This request has not been approved', 'not_approved');
  if (!row.active) throw deny('The release period for this request has ended; submit a new request if you still need the document', 'expired');
  if (row.classification === 'highly_sensitive') throw deny('This document cannot be released online', 'highly_sensitive');
  if (!(await eligibleParty(pool, req.auth!.user.id, row.parcel_id))) {
    throw deny('You no longer hold a registered interest in this parcel', 'interest_ended');
  }
  await sendStoredDocument(req, res, row, {
    action: 'document.release_download', countyId: row.county_id, caseId: row.case_id,
    detail: { requestId: id, requestNo: row.request_no },
  });
});
