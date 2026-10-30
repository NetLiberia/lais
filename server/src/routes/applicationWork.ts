import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { caseContext, getCase, inCaseTx, recordEvent } from '../services/cases.js';
import { REVIEW_STATUSES, reviewDocument, storeDocument } from '../services/applications.js';
import { resolveScope } from '../services/supervision.js';
import { notifyUsers } from '../services/notify.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Document management and additional-information requests for applications.
 *
 * Documents: uploaded files are identified from their content (PDF, PNG, JPEG, TIFF), stored privately
 * under random names, never overwritten (a replacement is a new version linked to the previous one), and
 * reviewed administratively with a history. Downloads go through the authenticated, audited file route.
 *
 * Information requests: recorded with their channel. No e-mail or SMS provider is configured, so the
 * system never claims to have sent anything: such requests are marked "not sent", and deliveries made by
 * staff (in person, by letter, by phone) are recorded by them.
 */
export const documentCenterRouter = Router();
export const applicationDocsRouter = Router();
export const infoRequestsRouter = Router();

const countyParam = z.coerce.number().int().positive().optional();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 } });

// ---------------------------------------------------------------------------
// Application documents: upload (and new versions), review
// ---------------------------------------------------------------------------

const uploadFields = z.object({
  docType: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  classification: z.enum(['public', 'restricted', 'highly_sensitive']),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  referenceNo: z.string().trim().max(100).optional(),
  issuer: z.string().trim().max(200).optional(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  supersedesId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  replacementReason: z.string().trim().max(1000).optional(),
});

applicationDocsRouter.post('/:id/documents', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  const fields = uploadFields.parse(req.body ?? {});
  const created = await inCaseTx(req, 'case.upload_document', (client, cs) => storeDocument(req, client, cs, req.file!, fields));
  res.status(201).json(created);
});

const reviewBody = z.object({
  status: z.enum(REVIEW_STATUSES).refine((s) => s !== 'not_reviewed', 'Choose a review outcome'),
  note: z.string().trim().max(2000).optional(),
  checks: z.object({
    readable: z.boolean().optional(), pagesPresent: z.boolean().optional(), requiredInformation: z.boolean().optional(), matchesApplication: z.boolean().optional(),
  }).optional(),
  refer: z.boolean().optional(),
});

documentCenterRouter.post('/:id/review', async (req, res) => {
  const body = reviewBody.parse(req.body);
  const docId = parseId(req.params.id);
  const result = await tx(async (client) => {
    const { rows: [doc] } = await client.query('SELECT case_id FROM lais.document WHERE id = $1', [docId]);
    if (!doc) throw notFound('Document not found');
    const cs = await getCase(client, doc.case_id, true);
    enforce(req, 'application.review_document', await caseContext(client, cs), { entityType: 'document', entityId: docId, caseId: cs.id });
    const r = await reviewDocument(req, client, cs, docId, body);
    if (body.refer || ['inconsistent', 'requires_clarification'].includes(body.status)) {
      await notifyUsers(client, [cs.assigned_processor_id !== req.auth!.user.id ? cs.assigned_processor_id : null], {
        category: 'application', title: `${r.documentNo} on ${cs.case_no}: ${body.status.replace(/_/g, ' ')}`, body: body.note?.slice(0, 200), link: `/processor/applications/${cs.id}`,
      });
    }
    return r;
  });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Document repository
// ---------------------------------------------------------------------------

const repoQuery = z.object({
  countyId: countyParam,
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(41).optional(),
  reviewStatus: z.enum([...REVIEW_STATUSES, 'superseded', 'pending_review']).optional(),
  caseId: z.string().uuid().optional(),
  applicantId: z.string().uuid().optional(),
  currentOnly: z.enum(['true', 'false']).default('true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Metadata of documents in scope. Titles and file names of highly sensitive documents are hidden without that permission. */
documentCenterRouter.get('/', async (req, res) => {
  const q = repoQuery.parse(req.query);
  const counties = resolveScope(req, 'case.view', q.countyId);
  const { rows } = await pool.query(
    `SELECT d.id, d.document_no, d.doc_type, dc.label AS doc_label, d.title, d.original_name, d.mime_type, d.size_bytes, d.classification, d.version_no,
            d.review_status, d.uploaded_at, uu.username AS uploaded_by, c.id AS case_id, c.case_no, c.county_id, co.code AS county_code,
            a.applicant_no, count(*) OVER () AS total
       FROM lais.document d JOIN lais.land_case c ON c.id = d.case_id JOIN lais.county co ON co.id = c.county_id
       JOIN lais.app_user uu ON uu.id = d.uploaded_by LEFT JOIN lais.document_category dc ON dc.code = d.doc_type
       LEFT JOIN lais.applicant a ON a.id = c.applicant_id
      WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
        AND ($2::text IS NULL OR d.document_no ILIKE '%' || $2 || '%' OR c.case_no ILIKE '%' || $2 || '%' OR a.applicant_no ILIKE '%' || $2 || '%'
             OR (d.classification <> 'highly_sensitive' AND d.title ILIKE '%' || $2 || '%'))
        AND ($3::text IS NULL OR d.doc_type = $3)
        AND ($4::text IS NULL OR d.review_status = $4 OR ($4 = 'pending_review' AND d.review_status IN ('not_reviewed', 'under_review')))
        AND ($5::uuid IS NULL OR c.id = $5) AND ($6::uuid IS NULL OR c.applicant_id = $6)
        AND ($7::boolean IS NOT TRUE OR d.review_status <> 'superseded')
      ORDER BY d.uploaded_at DESC LIMIT $8 OFFSET $9`,
    [counties, q.q || null, q.category || null, q.reviewStatus ?? null, q.caseId ?? null, q.applicantId ?? null, q.currentOnly === 'true', q.pageSize, (q.page - 1) * q.pageSize],
  );
  const p = req.auth!.principal;
  const items = rows.map(({ total: _t, ...d }) => (d.classification === 'highly_sensitive' && !authorize(p, 'document.view_highly_sensitive', { countyId: d.county_id }).allowed
    ? { ...d, title: null, original_name: null, restricted: true } : d));
  res.json({ items, total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize });
});

/** A document's metadata, its versions and its review history. */
documentCenterRouter.get('/:id', async (req, res) => {
  const { rows: [doc] } = await pool.query(
    `SELECT d.*, dc.label AS doc_label, uu.username AS uploaded_by_username FROM lais.document d
       JOIN lais.app_user uu ON uu.id = d.uploaded_by LEFT JOIN lais.document_category dc ON dc.code = d.doc_type WHERE d.id = $1`, [parseId(req.params.id)]);
  if (!doc) throw notFound('Document not found');
  const cs = await getCase(pool, doc.case_id);
  const ctx = await caseContext(pool, cs);
  enforce(req, 'case.view', ctx, { entityType: 'document', entityId: doc.id, caseId: cs.id });
  const p = req.auth!.principal;
  const canSee = doc.classification !== 'highly_sensitive' || authorize(p, 'document.view_highly_sensitive', ctx).allowed;
  const canDownload = doc.classification === 'public' ? true
    : authorize(p, doc.classification === 'restricted' ? 'document.view_restricted' : 'document.view_highly_sensitive', ctx).allowed;
  // The whole version chain: walk back to the first version, then forward.
  const { rows: versions } = await pool.query(
    `WITH RECURSIVE back AS (SELECT id, supersedes_id FROM lais.document WHERE id = $1
                             UNION ALL SELECT d.id, d.supersedes_id FROM lais.document d JOIN back b ON d.id = b.supersedes_id),
          root AS (SELECT id FROM back WHERE supersedes_id IS NULL),
          fwd AS (SELECT d.id FROM lais.document d WHERE d.id = (SELECT id FROM root)
                  UNION ALL SELECT d.id FROM lais.document d JOIN fwd f ON d.supersedes_id = f.id)
     SELECT d.id, d.document_no, d.version_no, d.review_status, d.uploaded_at, d.replacement_reason, u.username AS uploaded_by
       FROM lais.document d JOIN fwd ON fwd.id = d.id JOIN lais.app_user u ON u.id = d.uploaded_by ORDER BY d.version_no`, [doc.id]);
  const { rows: history } = await pool.query(
    `SELECT e.from_status, e.to_status, e.checks, e.note, e.referred, e.at, u.username AS reviewer
       FROM lais.document_review_event e JOIN lais.app_user u ON u.id = e.actor_id
      WHERE e.document_id = ANY($1) ORDER BY e.at`, [versions.map((v) => v.id)]);
  res.json({
    document: {
      id: doc.id, document_no: doc.document_no, doc_type: doc.doc_type, doc_label: doc.doc_label, title: canSee ? doc.title : null, description: canSee ? doc.description : null,
      reference_no: canSee ? doc.reference_no : null, issuer: canSee ? doc.issuer : null, issued_on: doc.issued_on, classification: doc.classification,
      mime_type: doc.mime_type, size_bytes: doc.size_bytes, original_name: canSee ? doc.original_name : null, sha256: doc.sha256, version_no: doc.version_no,
      review_status: doc.review_status, uploaded_at: doc.uploaded_at, uploaded_by: doc.uploaded_by_username, uploaded_by_id: doc.uploaded_by, case_id: cs.id, case_no: cs.case_no,
      previewable: ['application/pdf', 'image/png', 'image/jpeg'].includes(doc.mime_type), restricted: !canSee,
    },
    versions, history,
    can: { download: canDownload, review: authorize(p, 'application.review_document', ctx).allowed, replace: authorize(p, 'case.upload_document', ctx).allowed && doc.review_status !== 'superseded' },
    notice: 'Review statuses describe administrative processing only; they do not establish legal validity.',
  });
});

// ---------------------------------------------------------------------------
// Additional information requests
// ---------------------------------------------------------------------------

const OPEN = ['pending', 'response_received', 'partially_satisfied'];

const requestBody = z.object({
  category: z.enum(['missing_document', 'missing_information', 'clarification', 'replacement_document', 'other']),
  items: z.string().trim().min(3).max(1000),
  docCategories: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,40}$/)).max(20).default([]),
  explanation: z.string().trim().min(10).max(4000),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  channel: z.enum(['in_person', 'phone', 'letter', 'email', 'sms']),
  internalNote: z.string().trim().max(2000).optional(),
});

applicationDocsRouter.post('/:id/info-requests', async (req, res) => {
  const body = requestBody.parse(req.body);
  const result = await tx(async (client) => {
    const cs = await getCase(client, parseId(req.params.id), true);
    enforce(req, 'info_request.manage', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
    if (['published', 'rejected', 'withdrawn'].includes(cs.status)) throw conflict(`${cs.case_no} is ${cs.status}`);
    if (body.dueDate && body.dueDate < new Date().toISOString().slice(0, 10)) throw badRequest('The due date is in the past');
    if (body.docCategories.length) {
      const { rows } = await client.query('SELECT code FROM lais.document_category WHERE code = ANY($1)', [body.docCategories]);
      if (rows.length !== new Set(body.docCategories).size) throw badRequest('Unknown document category');
    }
    // No provider is configured: e-mail and SMS requests are recorded but not sent, and say so.
    const delivery = ['email', 'sms'].includes(body.channel) ? 'not_sent_no_provider' : 'awaiting_manual_delivery';
    const { rows: [r] } = await client.query(
      `INSERT INTO lais.info_request (case_id, applicant_id, county_id, category, items, doc_categories, explanation, due_date, channel, delivery_status, internal_note, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, request_no`,
      [cs.id, cs.applicant_id, cs.county_id, body.category, body.items, body.docCategories, body.explanation, body.dueDate ?? null, body.channel, delivery,
        body.internalNote ?? null, req.auth!.user.id]);
    await client.query(`INSERT INTO lais.info_request_event (request_id, action, to_status, note, actor_id) VALUES ($1, 'created', 'pending', $2, $3)`,
      [r.id, body.items, req.auth!.user.id]);
    await recordEvent(client, cs.id, req.auth!.user.id, 'request_information', `${r.request_no}: ${body.items}`);
    await writeAudit(req, { action: 'info_request.create', outcome: 'success', entityType: 'info_request', entityId: r.id, caseId: cs.id, countyId: cs.county_id, detail: { requestNo: r.request_no, channel: body.channel, delivery } }, client);
    return { id: r.id, requestNo: r.request_no, deliveryStatus: delivery };
  });
  res.status(201).json(result);
});

const requestListQuery = z.object({
  countyId: countyParam,
  status: z.enum(['pending', 'response_received', 'partially_satisfied', 'satisfied', 'closed', 'open', 'overdue']).optional(),
  caseId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

infoRequestsRouter.get('/', async (req, res) => {
  const q = requestListQuery.parse(req.query);
  const counties = resolveScope(req, 'info_request.view', q.countyId);
  const { rows } = await pool.query(
    `SELECT i.id, i.request_no, i.case_id, c.case_no, a.applicant_no, a.name AS applicant_name, i.category, i.items, i.status, i.channel, i.delivery_status,
            i.due_date, i.created_at, i.updated_at, u.username AS requested_by, co.code AS county_code,
            (i.due_date < current_date AND i.status = ANY($5)) AS overdue,
            (SELECT max(e.at) FROM lais.info_request_event e WHERE e.request_id = i.id AND e.action = 'response_recorded') AS last_response_at
       FROM lais.info_request i JOIN lais.land_case c ON c.id = i.case_id JOIN lais.county co ON co.id = i.county_id
       JOIN lais.app_user u ON u.id = i.requested_by LEFT JOIN lais.applicant a ON a.id = i.applicant_id
      WHERE ($1::smallint[] IS NULL OR i.county_id = ANY($1)) AND ($3::uuid IS NULL OR i.case_id = $3) AND ($4::uuid IS NULL OR i.requested_by = $4)
        AND ($2::text IS NULL OR i.status = $2 OR ($2 = 'open' AND i.status = ANY($5)) OR ($2 = 'overdue' AND i.status = ANY($5) AND i.due_date < current_date))
      ORDER BY (i.status = ANY($5)) DESC, i.due_date NULLS LAST, i.created_at DESC LIMIT 300`,
    [counties, q.status ?? null, q.caseId ?? null, q.mine === 'true' ? req.auth!.user.id : null, OPEN],
  );
  res.json(rows);
});

async function loadRequest(req: Request, id: string, lock = false, db: { query: typeof pool.query } = pool) {
  const { rows: [r] } = await db.query(`SELECT * FROM lais.info_request WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!r) throw notFound('Information request not found');
  enforce(req, 'info_request.view', { countyId: r.county_id }, { entityType: 'info_request', entityId: r.id, caseId: r.case_id });
  return r;
}

infoRequestsRouter.get('/:id', async (req, res) => {
  const r = await loadRequest(req, parseId(req.params.id));
  const { rows: events } = await pool.query(
    `SELECT e.action, e.from_status, e.to_status, e.note, e.response_channel, e.document_ids, e.at, u.username AS actor,
            (SELECT array_agg(d.document_no ORDER BY d.document_no) FROM lais.document d WHERE d.id = ANY(e.document_ids)) AS document_nos
       FROM lais.info_request_event e JOIN lais.app_user u ON u.id = e.actor_id WHERE e.request_id = $1 ORDER BY e.id`, [r.id]);
  const { rows: [c] } = await pool.query('SELECT case_no FROM lais.land_case WHERE id = $1', [r.case_id]);
  res.json({ ...r, case_no: c.case_no, events, overdue: !!(r.due_date && OPEN.includes(r.status) && new Date(r.due_date) < new Date(new Date().toISOString().slice(0, 10))) });
});

const deliveredBody = z.object({ note: z.string().trim().min(5).max(1000) });

/** Records that staff delivered the request themselves (in person, by letter, by phone, or from an official mailbox). */
infoRequestsRouter.post('/:id/delivered', async (req, res) => {
  const { note } = deliveredBody.parse(req.body);
  await tx(async (client) => {
    const r = await loadRequest(req, parseId(req.params.id), true, client);
    enforce(req, 'info_request.manage', { countyId: r.county_id }, { entityType: 'info_request', entityId: r.id, caseId: r.case_id });
    if (r.delivery_status === 'delivered_manually') throw conflict('Delivery was already recorded');
    await client.query(`UPDATE lais.info_request SET delivery_status = 'delivered_manually', delivered_note = $2, updated_at = now() WHERE id = $1`, [r.id, note]);
    await client.query(`INSERT INTO lais.info_request_event (request_id, action, note, actor_id) VALUES ($1, 'delivered', $2, $3)`, [r.id, note, req.auth!.user.id]);
    await writeAudit(req, { action: 'info_request.delivered', outcome: 'success', entityType: 'info_request', entityId: r.id, caseId: r.case_id, countyId: r.county_id }, client);
  });
  res.json({ ok: true });
});

const responseBody = z.object({
  note: z.string().trim().min(5).max(4000),
  channel: z.enum(['in_person', 'phone', 'letter', 'email', 'sms', 'other']),
  documentIds: z.array(z.string().uuid()).max(30).default([]),
});

/** Records the applicant's response, linking documents already uploaded to the application. */
infoRequestsRouter.post('/:id/responses', async (req, res) => {
  const body = responseBody.parse(req.body);
  await tx(async (client) => {
    const r = await loadRequest(req, parseId(req.params.id), true, client);
    enforce(req, 'info_request.manage', { countyId: r.county_id }, { entityType: 'info_request', entityId: r.id, caseId: r.case_id });
    if (!OPEN.includes(r.status)) throw conflict(`${r.request_no} is ${r.status}; reopen it first`);
    if (body.documentIds.length) {
      const { rows } = await client.query('SELECT id FROM lais.document WHERE case_id = $1 AND id = ANY($2)', [r.case_id, body.documentIds]);
      if (rows.length !== new Set(body.documentIds).size) throw badRequest('Link only documents of this application');
    }
    await client.query(`UPDATE lais.info_request SET status = 'response_received', updated_at = now() WHERE id = $1`, [r.id]);
    await client.query(
      `INSERT INTO lais.info_request_event (request_id, action, from_status, to_status, note, response_channel, document_ids, actor_id)
       VALUES ($1, 'response_recorded', $2, 'response_received', $3, $4, $5, $6)`, [r.id, r.status, body.note, body.channel, body.documentIds, req.auth!.user.id]);
    await recordEvent(client, r.case_id, req.auth!.user.id, 'information_received', `${r.request_no}: ${body.note.slice(0, 300)}`);
    await notifyUsers(client, [r.requested_by !== req.auth!.user.id ? r.requested_by : null], { category: 'application', title: `Response recorded for ${r.request_no}`, link: `/processor/info-requests?open=${r.id}` });
    await writeAudit(req, { action: 'info_request.response', outcome: 'success', entityType: 'info_request', entityId: r.id, caseId: r.case_id, countyId: r.county_id, detail: { documents: body.documentIds.length } }, client);
  });
  res.status(201).json({ ok: true });
});

const transitionBody = z.object({
  to: z.enum(['partially_satisfied', 'satisfied', 'closed', 'reopened']),
  note: z.string().trim().max(2000).optional(),
});
const MOVES: Record<string, string[]> = {
  partially_satisfied: ['response_received'],
  satisfied: ['response_received', 'partially_satisfied'],
  closed: ['pending', 'response_received', 'partially_satisfied'],
  reopened: ['satisfied', 'closed', 'partially_satisfied', 'response_received'],
};

infoRequestsRouter.post('/:id/status', async (req, res) => {
  const body = transitionBody.parse(req.body);
  await tx(async (client) => {
    const r = await loadRequest(req, parseId(req.params.id), true, client);
    enforce(req, 'info_request.manage', { countyId: r.county_id }, { entityType: 'info_request', entityId: r.id, caseId: r.case_id });
    if (!MOVES[body.to].includes(r.status)) throw conflict(`${r.request_no} cannot move from ${r.status.replace(/_/g, ' ')} to ${body.to.replace(/_/g, ' ')}`);
    if (['closed', 'reopened', 'partially_satisfied'].includes(body.to) && (body.note ?? '').length < 5) throw badRequest('Give the reason (5+ characters)');
    const to = body.to === 'reopened' ? 'pending' : body.to;
    await client.query(
      `UPDATE lais.info_request SET status = $2, updated_at = now(), closed_at = CASE WHEN $2 IN ('satisfied', 'closed') THEN now() ELSE NULL END WHERE id = $1`, [r.id, to]);
    await client.query(`INSERT INTO lais.info_request_event (request_id, action, from_status, to_status, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.id, body.to, r.status, to, body.note ?? null, req.auth!.user.id]);
    await recordEvent(client, r.case_id, req.auth!.user.id, `information_${body.to}`, `${r.request_no}${body.note ? `: ${body.note}` : ''}`);
    await writeAudit(req, { action: `info_request.${body.to}`, outcome: 'success', entityType: 'info_request', entityId: r.id, caseId: r.case_id, countyId: r.county_id, detail: { from: r.status, to } }, client);
  });
  res.json({ ok: true });
});

documentBody('POST /applications/{id}/documents', uploadFields);
documentBody('POST /documents/{id}/review', reviewBody);
documentQuery('GET /documents', repoQuery);
documentBody('POST /applications/{id}/info-requests', requestBody);
documentQuery('GET /info-requests', requestListQuery);
documentBody('POST /info-requests/{id}/delivered', deliveredBody);
documentBody('POST /info-requests/{id}/responses', responseBody);
documentBody('POST /info-requests/{id}/status', transitionBody);
