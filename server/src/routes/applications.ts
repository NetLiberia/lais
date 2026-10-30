import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { CASE_TYPES, SPATIAL_CASE_TYPES } from '../authz/workflow.js';
import { caseContext, getCase, inCaseTx, recordEvent, type CaseRow } from '../services/cases.js';
import { completeness, COMPLETENESS_LABELS } from '../services/applications.js';
import { assertEligibleAssignee, resolveScope } from '../services/supervision.js';
import { notifyRoles, notifyUsers } from '../services/notify.js';
import { createCaseRecord } from './cases.js';
import { documentBody, documentQuery } from '../openapi.js';

/**
 * Land applications as processors see them. An application is a case (`lais.land_case`) registered
 * through intake: it has an applicant, a configurable category, intake details and a responsible
 * processor. Applicant-provided parcel details are "declared" and stay unverified; they never become
 * geometry. Completeness is administrative only: nothing here decides, approves a title, edits geometry
 * or changes a registrar's decision.
 */
export const applicationsRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countyParam = z.coerce.number().int().positive().optional();
/** Optional text: absent stays absent (so a partial update leaves it alone); empty means clear it. */
const opt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));

/**
 * Where an application stands, derived from the case, its latest GIS handoff and its completeness.
 * Parameters: none (uses aliases c = land_case, ho = latest handoff with task status, comp = completeness).
 */
export const STAGE_SQL = `CASE
  WHEN c.intake_status = 'draft' THEN 'registration_draft'
  WHEN c.status IN ('withdrawn', 'rejected', 'published', 'approved', 'returned') THEN c.status
  WHEN c.status IN ('validating', 'under_review') THEN 'under_review'
  WHEN ho.task_status IN ('unassigned', 'assigned', 'returned') THEN 'awaiting_gis'
  WHEN ho.task_status IN ('in_progress', 'blocked') THEN 'gis_processing'
  WHEN ho.task_status = 'completed' THEN 'gis_complete'
  WHEN comp = 'awaiting_information' THEN 'awaiting_information'
  WHEN comp IN ('incomplete', 'ready_for_review') THEN 'document_review'
  WHEN comp = 'complete' AND c.case_type = ANY('{first_registration,subdivision,consolidation,correction,migration}') THEN 'ready_for_gis'
  WHEN comp = 'complete' THEN 'ready_for_submission'
  ELSE 'in_preparation' END`;
export const STAGE_LABELS: Record<string, string> = {
  registration_draft: 'Registration draft', document_review: 'Document review', awaiting_information: 'Awaiting additional information',
  ready_for_gis: 'Ready for GIS processing', awaiting_gis: 'Awaiting GIS processing', gis_processing: 'GIS processing', gis_complete: 'GIS work done',
  ready_for_submission: 'Ready for submission', under_review: 'Under supervisor or registrar review', returned: 'Returned for correction',
  approved: 'Approved by the registrar', rejected: 'Rejected by the registrar', published: 'Published', withdrawn: 'Withdrawn', in_preparation: 'In preparation',
};
/** Joins that STAGE_SQL needs: the latest handoff's task status, and the completeness status. */
export const STAGE_JOINS = `
  LEFT JOIN LATERAL (SELECT t.status AS task_status, h.handoff_no, t.task_no, t.assignee_id AS gis_assignee
                       FROM lais.application_handoff h JOIN lais.task t ON t.id = h.task_id
                      WHERE h.case_id = c.id ORDER BY h.created_at DESC LIMIT 1) ho ON true
  CROSS JOIN LATERAL (SELECT lais.application_completeness(c.id) AS comp) cp`;

// ---------------------------------------------------------------------------
// Categories (active, for the registration wizard)
// ---------------------------------------------------------------------------

applicationsRouter.get('/categories', async (req, res) => {
  resolveScope(req, 'case.view');
  const [{ rows: categories }, { rows: requirements }] = await Promise.all([
    pool.query('SELECT code, label, description, case_type FROM lais.application_category WHERE active ORDER BY sort_order, label'),
    pool.query(
      `SELECT r.id, r.category_code, r.kind, r.field_key, r.doc_category, dc.label AS doc_label, r.mandatory, r.condition_field, r.condition_value, r.stage, r.note
         FROM lais.application_requirement r LEFT JOIN lais.document_category dc ON dc.code = r.doc_category WHERE r.active ORDER BY r.stage, r.kind`),
  ]);
  res.json({ categories: categories.map((c) => ({ ...c, requirements: requirements.filter((r) => r.category_code === c.code) })) });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const listQuery = z.object({
  countyId: countyParam,
  q: z.string().trim().max(80).optional(),
  stage: z.string().trim().max(40).optional(),
  completeness: z.enum(['draft', 'awaiting_information', 'incomplete', 'ready_for_review', 'complete']).optional(),
  category: z.string().trim().max(41).optional(),
  processor: z.string().trim().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['created_at', 'case_no', 'submission_date', 'stage']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

applicationsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const counties = resolveScope(req, 'case.view', q.countyId);
  const processor = q.processor === 'me' ? req.auth!.user.id : q.processor && /^[0-9a-f-]{36}$/.test(q.processor) ? q.processor : null;
  const order = { created_at: 'c.created_at', case_no: 'c.case_no', submission_date: 'c.submission_date', stage: 'stage' }[q.sort];
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT c.id, c.case_no, c.case_type, c.category_code, ac.label AS category_label, c.status, c.intake_status, c.county_id, co.code AS county_code,
              c.submission_date, c.created_at, c.updated_at, c.declared_parcel_ref, c.external_reference, c.priority,
              a.id AS applicant_id, a.applicant_no, a.name AS applicant_name, c.assigned_processor_id, pu.username AS assigned_processor,
              cp.comp AS completeness, ${STAGE_SQL} AS stage, ho.handoff_no, ho.task_no,
              (SELECT count(*) FROM lais.info_request i WHERE i.case_id = c.id AND i.status IN ('pending', 'response_received', 'partially_satisfied'))::int AS open_requests
         FROM lais.land_case c
         JOIN lais.county co ON co.id = c.county_id
         JOIN lais.applicant a ON a.id = c.applicant_id
         LEFT JOIN lais.application_category ac ON ac.code = c.category_code
         LEFT JOIN lais.app_user pu ON pu.id = c.assigned_processor_id
         ${STAGE_JOINS}
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
          AND ($2::text IS NULL OR c.case_no ILIKE '%' || $2 || '%' OR a.name ILIKE '%' || $2 || '%' OR a.applicant_no ILIKE '%' || $2 || '%'
               OR c.declared_parcel_ref ILIKE '%' || $2 || '%' OR c.external_reference ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR c.category_code = $3) AND ($4::uuid IS NULL OR c.assigned_processor_id = $4)
          AND ($5::date IS NULL OR coalesce(c.submission_date, c.created_at::date) >= $5) AND ($6::date IS NULL OR coalesce(c.submission_date, c.created_at::date) <= $6)
     ) x
     WHERE ($7::text IS NULL OR x.stage = $7) AND ($8::text IS NULL OR x.completeness = $8)
     ORDER BY ${order === 'stage' ? 'x.stage' : order.replace('c.', 'x.')} ${q.dir} NULLS LAST, x.case_no DESC
     LIMIT $9 OFFSET $10`,
    [counties, q.q || null, q.category || null, processor, q.from ?? null, q.to ?? null, q.stage || null, q.completeness ?? null, q.pageSize + 1, (q.page - 1) * q.pageSize],
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT count(*)::int AS total FROM (
       SELECT c.id, cp.comp AS completeness, ${STAGE_SQL} AS stage FROM lais.land_case c JOIN lais.applicant a ON a.id = c.applicant_id ${STAGE_JOINS}
        WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
          AND ($2::text IS NULL OR c.case_no ILIKE '%' || $2 || '%' OR a.name ILIKE '%' || $2 || '%' OR a.applicant_no ILIKE '%' || $2 || '%'
               OR c.declared_parcel_ref ILIKE '%' || $2 || '%' OR c.external_reference ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR c.category_code = $3) AND ($4::uuid IS NULL OR c.assigned_processor_id = $4)
          AND ($5::date IS NULL OR coalesce(c.submission_date, c.created_at::date) >= $5) AND ($6::date IS NULL OR coalesce(c.submission_date, c.created_at::date) <= $6)) x
     WHERE ($7::text IS NULL OR x.stage = $7) AND ($8::text IS NULL OR x.completeness = $8)`,
    [counties, q.q || null, q.category || null, processor, q.from ?? null, q.to ?? null, q.stage || null, q.completeness ?? null],
  );
  res.json({ items: rows.slice(0, q.pageSize), total, page: q.page, pageSize: q.pageSize, stageLabels: STAGE_LABELS, completenessLabels: COMPLETENESS_LABELS });
});

// ---------------------------------------------------------------------------
// Registration (wizard): applicant, application, declared parcel, then documents on the created draft
// ---------------------------------------------------------------------------

const newApplicant = z.object({
  applicantType: z.enum(['person', 'organization', 'community', 'government']),
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/, 'Enter a telephone number (digits, spaces, + ( ) -)').nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  address: opt(500),
  idDocumentType: z.enum(['national_id', 'passport', 'voter_card', 'drivers_licence', 'registration_certificate', 'other']).nullable().optional(),
  idReference: opt(60),
  representativeName: opt(200),
  representativeRole: opt(100),
  representativePhone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/).nullable().optional(),
});

const intakeFields = {
  purpose: opt(1000),
  submissionDate: isoDate.nullable().optional(),
  receivingOffice: opt(120),
  externalReference: z.string().trim().regex(/^[A-Za-z0-9/._-]{2,60}$/, 'Use letters, digits and / . _ - (2-60 characters)').nullable().optional(),
  declaredParcelRef: opt(80),
  titleDeedRef: opt(120),
  locationDescription: opt(2000),
  district: opt(120),
  locality: opt(120),
  declaredLandUse: opt(200),
  declaredArea: z.number().positive().max(1e9).nullable().optional(),
  declaredAreaUnit: z.enum(['m2', 'ha', 'acre']).nullable().optional(),
  surveyReference: opt(120),
  remarks: opt(2000),
};

const registerBody = z.object({
  mode: z.enum(['draft', 'register']),
  applicantId: z.string().uuid().optional(),
  applicant: newApplicant.optional(),
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  countyId: z.number().int().positive().optional(),
  parcelUpi: z.string().trim().max(40).optional(),
  parcelUpis: z.array(z.string().trim().max(40)).max(20).optional(),
  landCategory: z.enum(['public', 'government', 'customary', 'private']).optional(),
  correctionReason: opt(2000),
  assignedProcessorId: z.string().uuid().optional(),
  duplicateReview: z.object({ reason: z.string().trim().min(10).max(1000) }).optional(),
  ...intakeFields,
}).refine((b) => !!b.applicantId !== !!b.applicant, 'Choose an existing applicant or enter a new one (not both)')
  .refine((b) => (b.declaredArea == null) === (b.declaredAreaUnit == null), 'Give the declared size together with its unit');

const COLUMN_FOR: Record<string, string> = {
  purpose: 'purpose', submissionDate: 'submission_date', receivingOffice: 'receiving_office', externalReference: 'external_reference',
  declaredParcelRef: 'declared_parcel_ref', titleDeedRef: 'title_deed_ref', locationDescription: 'location_description', district: 'district',
  locality: 'locality', declaredLandUse: 'declared_land_use', declaredArea: 'declared_area', declaredAreaUnit: 'declared_area_unit',
  surveyReference: 'survey_reference', remarks: 'remarks',
};

async function insertApplicant(req: Request, client: pg.PoolClient, a: z.infer<typeof newApplicant>, countyId: number) {
  enforce(req, 'applicant.manage', { countyId }, { entityType: 'applicant' });
  const { rows: [row] } = await client.query(
    `INSERT INTO lais.applicant (applicant_type, name, phone, email, address, id_document_type, id_reference, representative_name, representative_role,
                                 representative_phone, county_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id, applicant_no`,
    [a.applicantType, a.name, a.phone ?? null, a.email ?? null, a.address, a.idDocumentType ?? null, a.idReference, a.representativeName,
      a.representativeRole, a.representativePhone ?? null, countyId, req.auth!.user.id],
  );
  await client.query(`INSERT INTO lais.applicant_change (applicant_id, field, new_value, reason, changed_by) VALUES ($1, 'record', 'created', 'Registered with an application', $2)`,
    [row.id, req.auth!.user.id]);
  await writeAudit(req, { action: 'applicant.create', outcome: 'success', entityType: 'applicant', entityId: row.id, countyId, detail: { applicantNo: row.applicant_no } }, client);
  return row as { id: string; applicant_no: string };
}

/** Missing registration-stage fields for a case (registration needs them; drafts do not). */
async function registrationGaps(db: pg.PoolClient | typeof pool, caseId: string) {
  const c = await completeness(db, caseId);
  return c.items.filter((i) => i.applies && i.mandatory && i.stage === 'registration' && i.state !== 'complete');
}

applicationsRouter.post('/', async (req, res) => {
  const body = registerBody.parse(req.body);
  const result = await tx(async (client) => {
    const { rows: [category] } = await client.query('SELECT code, case_type, active, label FROM lais.application_category WHERE code = $1', [body.categoryCode]);
    if (!category?.active) throw badRequest('Unknown or inactive application category');
    const caseType = category.case_type as (typeof CASE_TYPES)[number];
    // The survey (or deed) reference is the case's source reference, which registration validation requires.
    const sourceReference = body.surveyReference ?? body.titleDeedRef ?? undefined;
    const caseBody = caseType === 'first_registration' ? { caseType, countyId: body.countyId!, landCategory: body.landCategory, sourceReference }
      : caseType === 'migration' ? { caseType, countyId: body.countyId!, sourceReference }
      : caseType === 'consolidation' ? { caseType, parcelUpis: body.parcelUpis ?? [] }
      : caseType === 'correction' ? { caseType, parcelUpi: body.parcelUpi ?? '', correctionReason: body.correctionReason ?? undefined }
      : { caseType, parcelUpi: body.parcelUpi ?? '', sourceReference };
    if ((caseType === 'first_registration' || caseType === 'migration') && !body.countyId) throw badRequest('Choose the county');
    if (['transfer', 'subdivision', 'correction', 'confirmation'].includes(caseType) && !body.parcelUpi) throw badRequest(`A ${category.label} application concerns a registered parcel: give its identifier`);
    if (caseType === 'consolidation' && (body.parcelUpis?.length ?? 0) < 2) throw badRequest('List the registered parcels to consolidate');

    // Jurisdiction, county enablement and the registering permission are checked by the case creation.
    const cs = await createCaseRecord(req, client, caseBody as Parameters<typeof createCaseRecord>[2], 'application.register');

    let applicant: { id: string; applicant_no: string };
    if (body.applicantId) {
      const { rows: [a] } = await client.query('SELECT id, applicant_no, county_id, status FROM lais.applicant WHERE id = $1', [body.applicantId]);
      if (!a) throw notFound('Applicant not found');
      enforce(req, 'applicant.view', { countyId: a.county_id }, { entityType: 'applicant', entityId: a.id });
      if (a.status !== 'active') throw conflict(`${a.applicant_no} is archived`);
      applicant = a;
    } else {
      applicant = await insertApplicant(req, client, body.applicant!, cs.county_id);
    }

    if (body.externalReference) {
      const { rows: [used] } = await client.query(
        `SELECT case_no FROM lais.land_case WHERE county_id = $1 AND lower(external_reference) = lower($2) AND status <> 'withdrawn' AND id <> $3`,
        [cs.county_id, body.externalReference, cs.id]);
      if (used) throw conflict(`Receipt reference ${body.externalReference} is already used by ${used.case_no}`);
    }

    // Possible duplicates: an open application of the same applicant for the same parcel or deed, or the
    // same declared parcel or deed reference in the county. They are shown for review, never merged.
    const { rows: [created] } = await client.query('SELECT parcel_id FROM lais.land_case WHERE id = $1', [cs.id]);
    const { rows: similar } = await client.query(
      `SELECT c.id, c.case_no, a.applicant_no,
              CASE WHEN c.applicant_id = $2 AND c.category_code = $3 THEN 'same applicant and category'
                   WHEN $4::text IS NOT NULL AND lower(c.declared_parcel_ref) = lower($4) THEN 'same declared parcel reference'
                   WHEN $5::text IS NOT NULL AND lower(c.title_deed_ref) = lower($5) THEN 'same title or deed reference'
                   ELSE 'same registered parcel' END AS match_reason
         FROM lais.land_case c JOIN lais.applicant a ON a.id = c.applicant_id
        WHERE c.id <> $1 AND c.county_id = $6 AND c.status NOT IN ('withdrawn', 'rejected', 'published')
          AND ((c.applicant_id = $2 AND c.category_code = $3 AND ($4::text IS NULL OR c.declared_parcel_ref IS NULL OR lower(c.declared_parcel_ref) = lower($4)))
               OR ($4::text IS NOT NULL AND lower(c.declared_parcel_ref) = lower($4))
               OR ($5::text IS NOT NULL AND lower(c.title_deed_ref) = lower($5))
               OR ($7::uuid IS NOT NULL AND c.parcel_id = $7 AND c.category_code = $3))
        LIMIT 10`,
      [cs.id, applicant.id, category.code, body.declaredParcelRef ?? null, body.titleDeedRef ?? null, cs.county_id, created.parcel_id],
    );
    if (similar.length && !body.duplicateReview) {
      throw conflict('This may duplicate an application already registered. Review them, then register with a reason if it is a separate application.',
        { duplicates: similar.map((s) => ({ caseNo: s.case_no, applicantNo: s.applicant_no, matchReason: s.match_reason })) });
    }
    for (const s of similar) {
      await client.query(
        `INSERT INTO lais.application_duplicate_review (case_id, similar_case_id, match_reason, reason, reviewed_by) VALUES ($1, $2, $3, $4, $5)`,
        [cs.id, s.id, s.match_reason, body.duplicateReview!.reason, req.auth!.user.id]);
    }

    let processorId = req.auth!.user.id;
    if (body.assignedProcessorId && body.assignedProcessorId !== processorId) {
      await assertEligibleAssignee(client, body.assignedProcessorId, 'document_review', cs.county_id);
      processorId = body.assignedProcessorId;
    }
    const sets = Object.entries(COLUMN_FOR).filter(([k]) => (body as Record<string, unknown>)[k] !== undefined);
    await client.query(
      `UPDATE lais.land_case SET applicant_id = $2, category_code = $3, intake_status = 'draft', assigned_processor_id = $4
              ${sets.map(([, col], i) => `, ${col} = $${i + 5}`).join('')}
        WHERE id = $1`,
      [cs.id, applicant.id, category.code, processorId, ...sets.map(([k]) => (body as Record<string, unknown>)[k] ?? null)],
    );
    let intakeStatus = 'draft';
    if (body.mode === 'register') {
      const gaps = await registrationGaps(client, cs.id);
      if (gaps.length) throw badRequest(`Complete the required details before registering: ${gaps.map((g) => g.label).join(', ')}. Or save it as a draft.`);
      await client.query(`UPDATE lais.land_case SET intake_status = 'registered' WHERE id = $1`, [cs.id]);
      intakeStatus = 'registered';
    }
    await recordEvent(client, cs.id, req.auth!.user.id, intakeStatus === 'registered' ? 'register_application' : 'save_application_draft',
      `${category.label}; applicant ${applicant.applicant_no}${similar.length ? `; reviewed as not a duplicate of ${similar.map((s) => s.case_no).join(', ')}` : ''}`);
    if (processorId !== req.auth!.user.id) {
      await notifyUsers(client, [processorId], { category: 'application', title: `Application ${cs.case_no} assigned to you`, link: `/processor/applications/${cs.id}` });
    }
    await writeAudit(req, {
      action: intakeStatus === 'registered' ? 'application.register' : 'application.draft', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id,
      countyId: cs.county_id, detail: { caseNo: cs.case_no, category: category.code, applicantNo: applicant.applicant_no, duplicatesReviewed: similar.map((s) => s.case_no) },
    }, client);
    return { id: cs.id, caseNo: cs.case_no, applicantId: applicant.id, applicantNo: applicant.applicant_no, intakeStatus };
  });
  res.status(201).json(result);
});

/** Finishes a draft registration once the registration-stage requirements are met. */
applicationsRouter.post('/:id/register', async (req, res) => {
  const result = await inCaseTx(req, 'application.edit', async (client, cs) => {
    if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
    if (cs.intake_status === 'registered') throw conflict(`${cs.case_no} is already registered`);
    const gaps = await registrationGaps(client, cs.id);
    if (gaps.length) throw badRequest(`Complete the required details before registering: ${gaps.map((g) => g.label).join(', ')}`);
    await client.query(`UPDATE lais.land_case SET intake_status = 'registered' WHERE id = $1`, [cs.id]);
    await recordEvent(client, cs.id, req.auth!.user.id, 'register_application', 'Registration completed from draft');
    await writeAudit(req, { action: 'application.register', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { caseNo: cs.case_no } }, client);
    return { intakeStatus: 'registered' };
  });
  res.json(result);
});

const updateBody = z.object({ ...intakeFields, reason: z.string().trim().max(1000).optional() })
  .refine((b) => Object.keys(b).some((k) => k !== 'reason'), 'Change at least one field');

/** Updates intake details. Previous and new values are kept in the case history and the audit trail. */
applicationsRouter.patch('/:id', async (req, res) => {
  const body = updateBody.parse(req.body);
  const result = await inCaseTx(req, 'application.edit', async (client, cs) => {
    if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
    const row = cs as unknown as Record<string, unknown>;
    const changes = Object.entries(COLUMN_FOR)
      .filter(([k]) => (body as Record<string, unknown>)[k] !== undefined)
      .map(([k, col]) => ({ field: col, from: row[col] instanceof Date ? (row[col] as Date).toISOString().slice(0, 10) : row[col] ?? null, to: (body as Record<string, unknown>)[k] ?? null }))
      .filter((c) => String(c.from ?? '') !== String(c.to ?? ''));
    if (!changes.length) throw conflict('Nothing changed');
    if (cs.intake_status === 'registered' && (body.reason ?? '').length < 5) throw badRequest('Give the reason for changing a registered application (5+ characters)');
    if (body.externalReference) {
      const { rows: [used] } = await client.query(
        `SELECT case_no FROM lais.land_case WHERE county_id = $1 AND lower(external_reference) = lower($2) AND status <> 'withdrawn' AND id <> $3`,
        [cs.county_id, body.externalReference, cs.id]);
      if (used) throw conflict(`Receipt reference ${body.externalReference} is already used by ${used.case_no}`);
    }
    await client.query(
      `UPDATE lais.land_case SET ${changes.map((c, i) => `${c.field} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [cs.id, ...changes.map((c) => c.to)],
    );
    if (changes.some((c) => c.field === 'survey_reference' && c.to)) {
      await client.query('UPDATE lais.land_case SET source_reference = survey_reference WHERE id = $1', [cs.id]);
    }
    await recordEvent(client, cs.id, req.auth!.user.id, 'update_application',
      `${changes.map((c) => `${c.field}: "${c.from ?? ''}" → "${c.to ?? ''}"`).join('; ')}${body.reason ? ` (${body.reason})` : ''}`.slice(0, 4000));
    await writeAudit(req, { action: 'application.update', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { changes, reason: body.reason ?? null } }, client);
    return { changed: changes.length };
  });
  res.json(result);
});

const assignBody = z.object({ processorId: z.string().uuid(), reason: z.string().trim().min(5).max(500) });

applicationsRouter.post('/:id/assign', async (req, res) => {
  const body = assignBody.parse(req.body);
  await inCaseTx(req, 'application.assign', async (client, cs) => {
    if (cs.assigned_processor_id === body.processorId) throw conflict('Already assigned to this processor');
    await assertEligibleAssignee(client, body.processorId, 'document_review', cs.county_id);
    await client.query('UPDATE lais.land_case SET assigned_processor_id = $2 WHERE id = $1', [cs.id, body.processorId]);
    const { rows: [u] } = await client.query('SELECT username FROM lais.app_user WHERE id = $1', [body.processorId]);
    await recordEvent(client, cs.id, req.auth!.user.id, 'assign_processor', `Assigned to ${u.username}: ${body.reason}`);
    await notifyUsers(client, [body.processorId], { category: 'application', title: `Application ${cs.case_no} assigned to you`, body: body.reason, link: `/processor/applications/${cs.id}` });
    await writeAudit(req, { action: 'application.assign', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { to: body.processorId, reason: body.reason } }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Workspace: everything about one application, in separate, labelled parts
// ---------------------------------------------------------------------------

async function viewApplication(req: Request, id: string) {
  const cs = await getCase(pool, id);
  enforce(req, 'case.view', await caseContext(pool, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
  return cs;
}

applicationsRouter.get('/:id', async (req, res) => {
  const cs = await viewApplication(req, parseId(req.params.id));
  const p = req.auth!.principal;
  const ctx = await caseContext(pool, cs);
  const canContact = authorize(p, 'applicant.view_contact', { countyId: cs.county_id }).allowed;
  const [stage, applicant, documents, requests, handoffs, gis, reviews, decisions, notes, exceptions, duplicates, comp] = await Promise.all([
    pool.query(`SELECT ${STAGE_SQL} AS stage, ac.label AS category_label, co.code AS county_code, co.name AS county_name, pu.username AS assigned_processor,
                       cu.username AS created_by_username, pp.upi AS parcel_upi
                  FROM lais.land_case c ${STAGE_JOINS}
                  JOIN lais.county co ON co.id = c.county_id
                  LEFT JOIN lais.application_category ac ON ac.code = c.category_code
                  LEFT JOIN lais.app_user pu ON pu.id = c.assigned_processor_id
                  LEFT JOIN lais.app_user cu ON cu.id = c.created_by
                  LEFT JOIN lais.parcel pp ON pp.id = c.parcel_id
                 WHERE c.id = $1`, [cs.id]),
    cs.applicant_id ? pool.query(
      `SELECT id, applicant_no, applicant_type, name, phone, email, address, id_document_type, (id_reference IS NOT NULL) AS has_id_reference,
              representative_name, representative_role, representative_phone, status, party_id FROM lais.applicant WHERE id = $1`, [cs.applicant_id]) : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT d.id, d.document_no, d.doc_type, dc.label AS doc_label, d.title, d.reference_no, d.classification, d.mime_type, d.size_bytes, d.original_name,
              d.version_no, d.supersedes_id, d.replacement_reason, d.review_status, d.verification_status, d.verification_note, d.uploaded_at,
              uu.username AS uploaded_by, d.uploaded_by AS uploaded_by_id,
              (SELECT json_build_object('status', e.to_status, 'note', e.note, 'by', ru.username, 'at', e.at, 'referred', e.referred)
                 FROM lais.document_review_event e JOIN lais.app_user ru ON ru.id = e.actor_id WHERE e.document_id = d.id ORDER BY e.id DESC LIMIT 1) AS last_review
         FROM lais.document d JOIN lais.app_user uu ON uu.id = d.uploaded_by LEFT JOIN lais.document_category dc ON dc.code = d.doc_type
        WHERE d.case_id = $1 ORDER BY d.doc_type, d.version_no DESC`, [cs.id]),
    pool.query(
      `SELECT i.id, i.request_no, i.category, i.items, i.status, i.channel, i.delivery_status, i.due_date, i.created_at, u.username AS requested_by,
              (i.due_date < current_date AND i.status IN ('pending', 'response_received', 'partially_satisfied')) AS overdue
         FROM lais.info_request i JOIN lais.app_user u ON u.id = i.requested_by WHERE i.case_id = $1 ORDER BY i.created_at DESC`, [cs.id]),
    pool.query(
      `SELECT h.id, h.handoff_no, h.task_type, h.instructions, h.priority, h.created_at, u.username AS processor, t.id AS task_id, t.task_no, t.status AS task_status,
              gu.username AS gis_officer, h.exception_id IS NOT NULL AS with_exception,
              (SELECT e.note FROM lais.task_event e WHERE e.task_id = t.id AND e.action = 'clarification_requested' ORDER BY e.id DESC LIMIT 1) AS last_clarification
         FROM lais.application_handoff h JOIN lais.app_user u ON u.id = h.processor_id JOIN lais.task t ON t.id = h.task_id
         LEFT JOIN lais.app_user gu ON gu.id = t.assignee_id WHERE h.case_id = $1 ORDER BY h.created_at DESC`, [cs.id]),
    pool.query(
      `SELECT b.version_no, b.feature_count, b.declared_srid, b.created_at AS version_at, r.error_count, r.warning_count, r.run_at AS validated_at
         FROM lais.land_case c
         LEFT JOIN staging.batch b ON b.case_id = c.id AND b.status IN ('active', 'published')
         LEFT JOIN LATERAL (SELECT error_count, warning_count, run_at FROM staging.validation_run v WHERE v.case_id = c.id ORDER BY run_at DESC LIMIT 1) r ON true
        WHERE c.id = $1 ORDER BY b.created_at DESC NULLS LAST LIMIT 1`, [cs.id]),
    pool.query(
      `SELECT s.decision, s.notes, s.instructions, s.issue_categories, s.created_at, u.username AS reviewer
         FROM lais.supervisory_review s JOIN lais.app_user u ON u.id = s.reviewer_id WHERE s.case_id = $1 ORDER BY s.created_at DESC`, [cs.id]),
    pool.query(
      `SELECT d.decision, d.reason, d.decided_at, d.superseded_at, u.username AS registrar
         FROM lais.case_decision d JOIN lais.app_user u ON u.id = d.decided_by WHERE d.case_id = $1 ORDER BY d.decided_at DESC`, [cs.id]),
    pool.query(`SELECT n.id, n.note, n.at, u.username AS author FROM lais.application_note n JOIN lais.app_user u ON u.id = n.actor_id WHERE n.case_id = $1 ORDER BY n.id DESC`, [cs.id]),
    pool.query(`SELECT e.id, e.stage, e.requirement_keys, e.reason, e.granted_at, u.username AS granted_by FROM lais.completeness_exception e JOIN lais.app_user u ON u.id = e.granted_by WHERE e.case_id = $1 ORDER BY e.granted_at DESC`, [cs.id]),
    pool.query(`SELECT r.match_reason, r.reason, r.reviewed_at, c.case_no AS similar_case_no, u.username AS reviewed_by
                  FROM lais.application_duplicate_review r JOIN lais.land_case c ON c.id = r.similar_case_id JOIN lais.app_user u ON u.id = r.reviewed_by WHERE r.case_id = $1`, [cs.id]),
    cs.applicant_id ? completeness(pool, cs.id) : Promise.resolve(null),
  ]);
  const a = applicant.rows[0];
  const showDoc = (d: { classification: string }) => d.classification !== 'highly_sensitive' || authorize(p, 'document.view_highly_sensitive', ctx).allowed;
  res.json({
    application: { ...cs, ...stage.rows[0], stage_label: STAGE_LABELS[stage.rows[0].stage] },
    applicant: a ? {
      ...a, phone: canContact ? a.phone : null, email: canContact ? a.email : null, address: canContact ? a.address : null,
      representative_phone: canContact ? a.representative_phone : null, contactHidden: !canContact,
    } : null,
    documents: documents.rows.map((d) => (showDoc(d) ? d : { ...d, title: null, original_name: null, reference_no: null, restricted: true })),
    infoRequests: requests.rows,
    handoffs: handoffs.rows,
    gis: gis.rows[0] ?? null,
    supervisoryReviews: reviews.rows,
    decisions: decisions.rows,
    notes: notes.rows,
    exceptions: exceptions.rows,
    duplicateReviews: duplicates.rows,
    completeness: comp,
    can: {
      edit: authorize(p, 'application.edit', ctx).allowed && !!cs.applicant_id,
      upload: authorize(p, 'case.upload_document', ctx).allowed,
      reviewDocuments: authorize(p, 'application.review_document', ctx).allowed,
      requestInformation: authorize(p, 'info_request.manage', { countyId: cs.county_id }).allowed,
      handoff: authorize(p, 'application.handoff', ctx).allowed && (SPATIAL_CASE_TYPES as readonly string[]).includes(cs.case_type),
      grantException: authorize(p, 'application.grant_exception', ctx).allowed,
      submit: authorize(p, 'case.submit', ctx).allowed,
      note: authorize(p, 'application.note', { countyId: cs.county_id }).allowed,
      assign: authorize(p, 'application.assign', { countyId: cs.county_id }).allowed,
      viewAudit: authorize(p, 'audit.view_county', { countyId: cs.county_id }).allowed || authorize(p, 'audit.view_all', {}).allowed,
    },
    separation: 'Applicant-provided details are declared, not verified. Document review is administrative. GIS checks are technical. Supervisor review is quality control. Only the registrar decides.',
  });
});

applicationsRouter.get('/:id/completeness', async (req, res) => {
  const cs = await viewApplication(req, parseId(req.params.id));
  if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
  res.json(await completeness(pool, cs.id));
});

/**
 * The workflow timeline, generated from the stored events of every part of the process (never from
 * the client): case history, document reviews, information requests, handoffs and GIS task events,
 * supervisor reviews, registrar decisions, exceptions and notes.
 */
applicationsRouter.get('/:id/timeline', async (req, res) => {
  const cs = await viewApplication(req, parseId(req.params.id));
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'case' AS source, e.action AS event, e.at, u.username AS actor, e.from_status, e.to_status, e.note
         FROM lais.case_event e LEFT JOIN lais.app_user u ON u.id = e.actor_id WHERE e.case_id = $1
       UNION ALL
       SELECT 'document', 'document_' || e.to_status, e.at, u.username, e.from_status, e.to_status, d.document_no || coalesce(': ' || e.note, '')
         FROM lais.document_review_event e JOIN lais.document d ON d.id = e.document_id JOIN lais.app_user u ON u.id = e.actor_id WHERE e.case_id = $1
       UNION ALL
       SELECT 'info_request', 'information_' || e.action, e.at, u.username, e.from_status, e.to_status, i.request_no || coalesce(': ' || e.note, '')
         FROM lais.info_request_event e JOIN lais.info_request i ON i.id = e.request_id JOIN lais.app_user u ON u.id = e.actor_id WHERE i.case_id = $1
       UNION ALL
       SELECT 'gis', 'gis_task_' || e.action, e.at, u.username, e.from_value, e.to_value, t.task_no || coalesce(': ' || e.note, '')
         FROM lais.task_event e JOIN lais.task t ON t.id = e.task_id JOIN lais.application_handoff h ON h.task_id = t.id
         JOIN lais.app_user u ON u.id = e.actor_id WHERE h.case_id = $1 AND e.action IN ('created', 'acknowledged', 'claimed', 'status_changed', 'completed', 'clarification_requested', 'comment', 'returned')
       UNION ALL
       SELECT 'supervision', 'supervisor_' || s.decision, s.created_at, u.username, NULL, s.decision, s.notes
         FROM lais.supervisory_review s JOIN lais.app_user u ON u.id = s.reviewer_id WHERE s.case_id = $1
       UNION ALL
       SELECT 'registrar', 'registrar_' || d.decision, d.decided_at, u.username, NULL, d.decision, d.reason
         FROM lais.case_decision d JOIN lais.app_user u ON u.id = d.decided_by WHERE d.case_id = $1
       UNION ALL
       SELECT 'exception', 'completeness_exception', e.granted_at, u.username, NULL, e.stage, array_to_string(e.requirement_keys, ', ') || ': ' || e.reason
         FROM lais.completeness_exception e JOIN lais.app_user u ON u.id = e.granted_by WHERE e.case_id = $1
       UNION ALL
       SELECT 'note', 'note', n.at, u.username, NULL, NULL, n.note
         FROM lais.application_note n JOIN lais.app_user u ON u.id = n.actor_id WHERE n.case_id = $1
     ) t ORDER BY at, event`,
    [cs.id],
  );
  res.json(rows);
});

const noteBody = z.object({ note: z.string().trim().min(3).max(4000) });

applicationsRouter.post('/:id/notes', async (req, res) => {
  const { note } = noteBody.parse(req.body);
  const cs = await viewApplication(req, parseId(req.params.id));
  enforce(req, 'application.note', { countyId: cs.county_id }, { entityType: 'case', entityId: cs.id, caseId: cs.id });
  const { rows: [n] } = await pool.query('INSERT INTO lais.application_note (case_id, note, actor_id) VALUES ($1, $2, $3) RETURNING id', [cs.id, note, req.auth!.user.id]);
  await writeAudit(req, { action: 'application.note', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { noteId: n.id } });
  res.status(201).json({ id: n.id });
});

// ---------------------------------------------------------------------------
// Completeness exceptions (supervisors) and the GIS handoff
// ---------------------------------------------------------------------------

const exceptionBody = z.object({
  stage: z.enum(['gis_handoff', 'submission']),
  requirementKeys: z.array(z.string().regex(/^(field|document):[a-z][a-z0-9_]{1,40}$/)).min(1).max(30),
  reason: z.string().trim().min(20).max(2000),
});

/** A supervisor waives named requirements for one stage, with a justification. Recorded and audited, never silent. */
applicationsRouter.post('/:id/exceptions', async (req, res) => {
  const body = exceptionBody.parse(req.body);
  const result = await inCaseTx(req, 'application.grant_exception', async (client, cs) => {
    if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
    const c = await completeness(client, cs.id);
    const known = new Set(c.items.map((i) => i.req_key));
    const unknown = body.requirementKeys.filter((k) => !known.has(k));
    if (unknown.length) throw badRequest(`Not requirements of this application: ${unknown.join(', ')}`);
    const { rows: [e] } = await client.query(
      'INSERT INTO lais.completeness_exception (case_id, stage, requirement_keys, reason, granted_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [cs.id, body.stage, body.requirementKeys, body.reason, req.auth!.user.id]);
    await recordEvent(client, cs.id, req.auth!.user.id, 'completeness_exception', `${body.stage}: ${body.requirementKeys.join(', ')}: ${body.reason}`);
    await notifyUsers(client, [cs.assigned_processor_id], { category: 'application', title: `Completeness exception granted on ${cs.case_no}`, body: body.reason.slice(0, 200), link: `/processor/applications/${cs.id}` });
    await writeAudit(req, { action: 'application.exception', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { stage: body.stage, keys: body.requirementKeys, reason: body.reason } }, client);
    return { id: e.id };
  });
  res.status(201).json(result);
});

const HANDOFF_TASK_TYPES = ['gis_preparation', 'gis_validation_correction', 'attribute_verification'] as const;

async function handoffChecklist(db: pg.PoolClient | typeof pool, cs: CaseRow) {
  const c = await completeness(db, cs.id);
  const row = cs as unknown as Record<string, unknown>;
  const { rows: [county] } = await db.query('SELECT enabled, name FROM lais.county WHERE id = $1', [cs.county_id]);
  const { rows: [open] } = await db.query(
    `SELECT h.handoff_no, t.task_no, t.status FROM lais.application_handoff h JOIN lais.task t ON t.id = h.task_id
      WHERE h.case_id = $1 AND t.status NOT IN ('completed', 'cancelled') LIMIT 1`, [cs.id]);
  const { rows: [{ n: openRequests }] } = await db.query(
    `SELECT count(*)::int AS n FROM lais.info_request WHERE case_id = $1 AND status IN ('pending', 'response_received', 'partially_satisfied')`, [cs.id]);
  const blocking = c.blocking.gis_handoff;
  const surveyMissing = blocking.filter((b) => b.kind === 'document');
  const items = [
    { key: 'reference', label: 'Application reference exists', ok: true, detail: cs.case_no },
    { key: 'registered', label: 'Registration completed', ok: cs.intake_status === 'registered', detail: cs.intake_status === 'registered' ? 'Registered' : 'Still a draft' },
    { key: 'county', label: 'County confirmed', ok: !!county?.enabled, detail: county?.name ?? '?' },
    { key: 'spatial', label: 'Application needs spatial processing', ok: (SPATIAL_CASE_TYPES as readonly string[]).includes(cs.case_type), detail: cs.case_type.replace(/_/g, ' ') },
    { key: 'applicant', label: 'Applicant information sufficient', ok: !blocking.some((b) => b.stage === 'registration'), detail: blocking.filter((b) => b.stage === 'registration').map((b) => b.label).join(', ') || 'Complete' },
    { key: 'declared_parcel', label: 'Declared parcel information recorded', ok: !!(row.declared_parcel_ref || row.location_description || cs.parcel_id), detail: String(row.declared_parcel_ref ?? row.location_description ?? (cs.parcel_id ? 'Registered parcel' : 'None')) },
    { key: 'documents', label: 'Required documents (e.g. survey plan) attached and accepted', ok: surveyMissing.length === 0, detail: surveyMissing.map((b) => `${b.label}: ${b.state}`).join('; ') || 'Complete' },
    { key: 'requirements', label: 'All requirements for GIS handoff met (or excepted)', ok: blocking.length === 0, detail: blocking.length ? `${blocking.length} outstanding` : 'Complete' },
    { key: 'no_open_handoff', label: 'No GIS task already open', ok: !open, detail: open ? `${open.handoff_no} (${open.task_no}, ${open.status})` : 'None open' },
    { key: 'outstanding', label: 'Outstanding administrative issues documented', ok: true, warning: openRequests > 0, detail: openRequests ? `${openRequests} information request(s) still open: mention them in the instructions` : 'None' },
  ];
  return { ready: items.every((i) => i.ok), items, blocking, exceptions: c.items.filter((i) => i.waived_for.includes('gis_handoff')).map((i) => i.req_key) };
}

applicationsRouter.get('/:id/handoff-check', async (req, res) => {
  const cs = await viewApplication(req, parseId(req.params.id));
  if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
  res.json(await handoffChecklist(pool, cs));
});

const handoffBody = z.object({
  taskType: z.enum(HANDOFF_TASK_TYPES).default('gis_preparation'),
  assigneeId: z.string().uuid().nullable().optional(),
  instructions: z.string().trim().min(10).max(4000),
  documentIds: z.array(z.string().uuid()).max(50).default([]),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueDate: isoDate.optional(),
});

/**
 * Hands an application to GIS processing: creates a GIS task linked to the application, records the
 * checklist as it stood, and notifies the GIS officer or the county's GIS queue. Geometry is never sent
 * or edited here: the GIS officer does the spatial work.
 */
applicationsRouter.post('/:id/handoff', async (req, res) => {
  const body = handoffBody.parse(req.body);
  const result = await inCaseTx(req, 'application.handoff', async (client, cs) => {
    if (!cs.applicant_id) throw badRequest('This case was not opened through application intake');
    const check = await handoffChecklist(client, cs);
    const failed = check.items.filter((i) => !i.ok);
    if (failed.length) {
      throw conflict(`The application is not ready for GIS processing: ${failed.map((f) => `${f.label} (${f.detail})`).join('; ')}`, { checklist: check.items });
    }
    if (body.dueDate && body.dueDate < new Date().toISOString().slice(0, 10)) throw badRequest('The due date is in the past');
    const { rows: docs } = await client.query(
      `SELECT id, document_no FROM lais.document WHERE case_id = $1 AND id = ANY($2) AND review_status <> 'superseded'`, [cs.id, body.documentIds]);
    if (docs.length !== new Set(body.documentIds).size) throw badRequest('Attach only current documents of this application');
    if (body.assigneeId) await assertEligibleAssignee(client, body.assigneeId, body.taskType, cs.county_id);
    const row = cs as unknown as Record<string, unknown>;
    const { rows: [task] } = await client.query(
      `INSERT INTO lais.task (task_type, title, description, instructions, reference, county_id, case_id, assignee_id, status, priority, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, task_no`,
      [body.taskType, `GIS processing: ${cs.case_no}`, `Handoff from application processing${row.declared_parcel_ref ? `; declared parcel ${row.declared_parcel_ref}` : ''}`,
        body.instructions, docs.map((d) => d.document_no).join(', ') || null, cs.county_id, cs.id, body.assigneeId ?? null,
        body.assigneeId ? 'assigned' : 'unassigned', body.priority, body.dueDate ?? null, req.auth!.user.id],
    );
    await client.query(`INSERT INTO lais.task_event (task_id, actor_id, action, to_value, note) VALUES ($1, $2, 'created', $3, 'Created by a processor handoff')`,
      [task.id, req.auth!.user.id, body.assigneeId ?? 'unassigned']);
    const { rows: [exception] } = await client.query(
      `SELECT id FROM lais.completeness_exception WHERE case_id = $1 AND stage = 'gis_handoff' ORDER BY granted_at DESC LIMIT 1`, [cs.id]);
    const { rows: [h] } = await client.query(
      `INSERT INTO lais.application_handoff (case_id, task_id, processor_id, task_type, instructions, declared_parcel_ref, document_ids, priority, checklist, exception_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, handoff_no`,
      [cs.id, task.id, req.auth!.user.id, body.taskType, body.instructions, row.declared_parcel_ref ?? null, docs.map((d) => d.id), body.priority,
        JSON.stringify(check.items), check.exceptions.length ? exception?.id ?? null : null],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'gis_handoff', `${h.handoff_no} → ${task.task_no} (${body.assigneeId ? 'assigned' : 'county GIS queue'})`);
    const notice = { category: 'task' as const, title: `New GIS task ${task.task_no}: ${cs.case_no}`, body: body.instructions.slice(0, 200), link: '/gis/tasks' };
    if (body.assigneeId) await notifyUsers(client, [body.assigneeId], notice);
    else await notifyRoles(client, ['gis_officer'], notice, cs.county_id);
    await writeAudit(req, {
      action: 'application.handoff', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { handoffNo: h.handoff_no, taskNo: task.task_no, taskType: body.taskType, assigneeId: body.assigneeId ?? null, documents: docs.map((d) => d.document_no) },
    }, client);
    return { handoffNo: h.handoff_no, taskId: task.id, taskNo: task.task_no };
  });
  res.status(201).json(result);
});

/** Eligible staff for pickers (processors for assignment, GIS officers for handoff), in the application's county. */
applicationsRouter.get('/:id/staff', async (req, res) => {
  const cs = await viewApplication(req, parseId(req.params.id));
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.username, u.display_name, r.role FROM lais.app_user u JOIN lais.role_assignment r ON r.user_id = u.id AND r.revoked_at IS NULL
      WHERE u.status = 'active' AND r.role IN ('processor', 'gis_officer') AND (r.county_id = $1 OR r.county_id IS NULL) ORDER BY r.role, u.username`, [cs.county_id]);
  res.json(rows);
});

// Submission for review uses POST /cases/{id}/submit, which applies the completeness gate (stage "submission").

documentQuery('GET /applications', listQuery);
documentBody('POST /applications', registerBody);
documentBody('PATCH /applications/{id}', updateBody);
documentBody('POST /applications/{id}/assign', assignBody);
documentBody('POST /applications/{id}/notes', noteBody);
documentBody('POST /applications/{id}/exceptions', exceptionBody);
documentBody('POST /applications/{id}/handoff', handoffBody);
