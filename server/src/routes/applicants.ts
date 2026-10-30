import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { maskEmail, maskPhone } from '../services/applications.js';
import { resolveScope } from '../services/supervision.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Applicants: the people or bodies who submit applications. Only what the process needs is collected.
 * Contact details and identification references are separate permissions: without them, lists show masked
 * values and search does not match on them (so they cannot be found by guessing). Corrections keep the
 * previous value, the new value, the reason and the officer, and identity details are never silently
 * overwritten. Applicant records are never deleted; they can be archived.
 */
export const applicantsRouter = Router();

const countyParam = z.coerce.number().int().positive().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listQuery = z.object({
  countyId: countyParam,
  q: z.string().trim().max(80).optional(),
  type: z.enum(['person', 'organization', 'community', 'government']).optional(),
  status: z.enum(['active', 'archived']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['created_at', 'updated_at', 'name', 'applicant_no']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const contactAllowed = (req: Request, countyId: number) => authorize(req.auth!.principal, 'applicant.view_contact', { countyId }).allowed;

applicantsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const counties = resolveScope(req, 'applicant.view', q.countyId);
  // Contact search only for officers who may see contact details; otherwise the term matches names and numbers only.
  const contactScope = counties === null ? null : counties.filter((c) => contactAllowed(req, c));
  const searchContact = !!q.q && (contactScope === null || contactScope.length > 0);
  const { rows } = await pool.query(
    `SELECT a.id, a.applicant_no, a.applicant_type, a.name, a.phone, a.email, a.county_id, co.code AS county_code, a.status, a.created_at, a.updated_at,
            (SELECT count(*) FROM lais.land_case c WHERE c.applicant_id = a.id)::int AS applications, count(*) OVER () AS total
       FROM lais.applicant a JOIN lais.county co ON co.id = a.county_id
      WHERE ($1::smallint[] IS NULL OR a.county_id = ANY($1))
        AND ($2::text IS NULL OR a.name ILIKE '%' || $2 || '%' OR a.applicant_no ILIKE '%' || $2 || '%'
             OR ($3 AND ($4::smallint[] IS NULL OR a.county_id = ANY($4)) AND (a.phone ILIKE '%' || $2 || '%' OR a.email ILIKE '%' || $2 || '%')))
        AND ($5::text IS NULL OR a.applicant_type = $5) AND ($6::text IS NULL OR a.status = $6)
        AND ($7::date IS NULL OR a.created_at >= $7) AND ($8::date IS NULL OR a.created_at < $8::date + 1)
      ORDER BY a.${q.sort} ${q.dir} LIMIT $9 OFFSET $10`,
    [counties, q.q || null, searchContact, contactScope, q.type ?? null, q.status ?? null, q.from ?? null, q.to ?? null, q.pageSize, (q.page - 1) * q.pageSize],
  );
  res.json({
    items: rows.map(({ total: _t, ...a }) => (contactAllowed(req, a.county_id) ? a : { ...a, phone: maskPhone(a.phone), email: maskEmail(a.email), contactMasked: true })),
    total: Number(rows[0]?.total ?? 0), page: q.page, pageSize: q.pageSize,
  });
});

const createBody = z.object({
  countyId: z.number().int().positive(),
  applicantType: z.enum(['person', 'organization', 'community', 'government']),
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  idDocumentType: z.enum(['national_id', 'passport', 'voter_card', 'drivers_licence', 'registration_certificate', 'other']).nullable().optional(),
  idReference: z.string().trim().max(60).nullable().optional(),
  representativeName: z.string().trim().max(200).nullable().optional(),
  representativeRole: z.string().trim().max(100).nullable().optional(),
  representativePhone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/).nullable().optional(),
});

applicantsRouter.post('/', async (req, res) => {
  const b = createBody.parse(req.body);
  const created = await tx(async (client) => {
    enforce(req, 'applicant.manage', { countyId: b.countyId }, { entityType: 'applicant' });
    const { rows: [row] } = await client.query(
      `INSERT INTO lais.applicant (applicant_type, name, phone, email, address, id_document_type, id_reference, representative_name, representative_role,
                                   representative_phone, county_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id, applicant_no`,
      [b.applicantType, b.name, b.phone || null, b.email || null, b.address || null, b.idDocumentType ?? null, b.idReference || null, b.representativeName || null,
        b.representativeRole || null, b.representativePhone || null, b.countyId, req.auth!.user.id]);
    await client.query(`INSERT INTO lais.applicant_change (applicant_id, field, new_value, reason, changed_by) VALUES ($1, 'record', 'created', 'Registered', $2)`, [row.id, req.auth!.user.id]);
    await writeAudit(req, { action: 'applicant.create', outcome: 'success', entityType: 'applicant', entityId: row.id, countyId: b.countyId, detail: { applicantNo: row.applicant_no } }, client);
    return row;
  });
  res.status(201).json({ id: created.id, applicantNo: created.applicant_no });
});

async function loadApplicant(req: Request, id: string, action: 'applicant.view' | 'applicant.manage' = 'applicant.view') {
  const { rows: [a] } = await pool.query('SELECT * FROM lais.applicant WHERE id = $1', [id]);
  if (!a) throw notFound('Applicant not found');
  enforce(req, action, { countyId: a.county_id }, { entityType: 'applicant', entityId: a.id });
  return a;
}

/** Fields whose history is identity information: shown only to officers who may reveal identity details. */
const IDENTITY_FIELDS = ['id_document_type', 'id_reference'];
const CONTACT_FIELDS = ['phone', 'email', 'address', 'representative_phone'];

applicantsRouter.get('/:id', async (req, res) => {
  const a = await loadApplicant(req, parseId(req.params.id));
  const p = req.auth!.principal;
  const canContact = contactAllowed(req, a.county_id);
  const canIdentity = authorize(p, 'applicant.view_identity', { countyId: a.county_id }).allowed;
  const [apps, docs, requests, changes] = await Promise.all([
    pool.query(
      `SELECT c.id, c.case_no, c.category_code, ac.label AS category_label, c.status, c.intake_status, c.created_at, c.declared_parcel_ref, co.code AS county_code,
              lais.application_completeness(c.id) AS completeness
         FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id LEFT JOIN lais.application_category ac ON ac.code = c.category_code
        WHERE c.applicant_id = $1 ORDER BY c.created_at DESC`, [a.id]),
    pool.query(
      `SELECT d.id, d.document_no, d.doc_type, d.classification, d.review_status, d.version_no, d.uploaded_at, c.case_no
         FROM lais.document d JOIN lais.land_case c ON c.id = d.case_id WHERE c.applicant_id = $1 AND d.review_status <> 'superseded' ORDER BY d.uploaded_at DESC`, [a.id]),
    pool.query(
      `SELECT i.id, i.request_no, i.items, i.status, i.channel, i.delivery_status, i.due_date, c.case_no
         FROM lais.info_request i JOIN lais.land_case c ON c.id = i.case_id
        WHERE c.applicant_id = $1 AND i.status IN ('pending', 'response_received', 'partially_satisfied') ORDER BY i.created_at DESC`, [a.id]),
    pool.query(
      `SELECT ch.field, ch.old_value, ch.new_value, ch.reason, ch.changed_at, u.username AS changed_by
         FROM lais.applicant_change ch JOIN lais.app_user u ON u.id = ch.changed_by WHERE ch.applicant_id = $1 ORDER BY ch.id DESC`, [a.id]),
  ]);
  const hide = (field: string, v: string | null) => (IDENTITY_FIELDS.includes(field) && !canIdentity) || (CONTACT_FIELDS.includes(field) && !canContact) ? (v ? '(hidden)' : null) : v;
  res.json({
    applicant: {
      id: a.id, applicant_no: a.applicant_no, applicant_type: a.applicant_type, name: a.name, status: a.status, county_id: a.county_id,
      phone: canContact ? a.phone : maskPhone(a.phone), email: canContact ? a.email : maskEmail(a.email), address: canContact ? a.address : null,
      id_document_type: canIdentity ? a.id_document_type : a.id_document_type ? '(hidden)' : null, has_id_reference: !!a.id_reference,
      representative_name: a.representative_name, representative_role: a.representative_role,
      representative_phone: canContact ? a.representative_phone : maskPhone(a.representative_phone),
      party_id: a.party_id, created_at: a.created_at, updated_at: a.updated_at, contactMasked: !canContact,
    },
    applications: apps.rows,
    documents: docs.rows,
    openRequests: requests.rows,
    history: changes.rows.map((c) => ({ ...c, old_value: hide(c.field, c.old_value), new_value: hide(c.field, c.new_value) })),
    can: { manage: authorize(p, 'applicant.manage', { countyId: a.county_id }).allowed, revealIdentity: canIdentity && !!a.id_reference },
  });
});

/** Reveals the identification reference. Every reveal is audited. */
applicantsRouter.get('/:id/identity', async (req, res) => {
  const a = await loadApplicant(req, parseId(req.params.id));
  enforce(req, 'applicant.view_identity', { countyId: a.county_id }, { entityType: 'applicant', entityId: a.id });
  await writeAudit(req, { action: 'applicant.identity_revealed', outcome: 'success', entityType: 'applicant', entityId: a.id, countyId: a.county_id, detail: { applicantNo: a.applicant_no } });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ idDocumentType: a.id_document_type, idReference: a.id_reference });
});

const updateBody = createBody.omit({ countyId: true }).partial().extend({
  status: z.enum(['active', 'archived']).optional(),
  reason: z.string().trim().max(1000).optional(),
});
const COLUMNS: Record<string, string> = {
  applicantType: 'applicant_type', name: 'name', phone: 'phone', email: 'email', address: 'address', idDocumentType: 'id_document_type',
  idReference: 'id_reference', representativeName: 'representative_name', representativeRole: 'representative_role', representativePhone: 'representative_phone', status: 'status',
};
/** Corrections of identity need a stated reason; contact updates may give one. */
const SIGNIFICANT = ['name', 'applicant_type', 'id_document_type', 'id_reference', 'status'];

applicantsRouter.patch('/:id', async (req, res) => {
  const body = updateBody.parse(req.body);
  const result = await tx(async (client) => {
    const { rows: [a] } = await client.query('SELECT * FROM lais.applicant WHERE id = $1 FOR UPDATE', [parseId(req.params.id)]);
    if (!a) throw notFound('Applicant not found');
    enforce(req, 'applicant.manage', { countyId: a.county_id }, { entityType: 'applicant', entityId: a.id });
    const changes = Object.entries(COLUMNS)
      .filter(([k]) => (body as Record<string, unknown>)[k] !== undefined)
      .map(([k, col]) => ({ col, from: a[col] as string | null, to: ((body as Record<string, unknown>)[k] as string | null) || null }))
      .filter((c) => (c.from ?? '') !== (c.to ?? ''));
    if (!changes.length) throw conflict('Nothing changed');
    const significant = changes.filter((c) => SIGNIFICANT.includes(c.col));
    if (significant.length && (body.reason ?? '').length < 10) {
      throw badRequest(`Changing ${significant.map((c) => c.col.replace(/_/g, ' ')).join(', ')} is a correction of the record: give the reason (10+ characters)`);
    }
    if (significant.some((c) => IDENTITY_FIELDS.includes(c.col))) {
      enforce(req, 'applicant.view_identity', { countyId: a.county_id }, { entityType: 'applicant', entityId: a.id });
    }
    await client.query(
      `UPDATE lais.applicant SET ${changes.map((c, i) => `${c.col} = $${i + 2}`).join(', ')}, updated_by = $${changes.length + 2}, updated_at = now() WHERE id = $1`,
      [a.id, ...changes.map((c) => c.to), req.auth!.user.id]);
    for (const c of changes) {
      await client.query(
        'INSERT INTO lais.applicant_change (applicant_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [a.id, c.col, c.from, c.to, body.reason || null, req.auth!.user.id]);
    }
    // The audit records which fields changed, never the identity or contact values themselves.
    await writeAudit(req, {
      action: 'applicant.update', outcome: 'success', entityType: 'applicant', entityId: a.id, countyId: a.county_id,
      detail: { applicantNo: a.applicant_no, fields: changes.map((c) => c.col), reason: body.reason ?? null },
    }, client);
    return { changed: changes.map((c) => c.col) };
  });
  res.json(result);
});

documentQuery('GET /applicants', listQuery);
documentBody('POST /applicants', createBody);
documentBody('PATCH /applicants/{id}', updateBody);
