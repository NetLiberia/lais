import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';
import { CASE_TYPES } from '../authz/workflow.js';
import { documentBody } from '../openapi.js';

/**
 * Application categories and their requirements, configured by administrators. The seeded rows are
 * working defaults, not a statutory list: they should be replaced by the authority's checklist. Every
 * change needs a reason and is kept in the append-only lais.application_config_change.
 */
export const applicationConfigRouter = Router();

const FIELD_KEYS = ['applicant', 'purpose', 'submission_date', 'receiving_office', 'declared_parcel_ref', 'title_deed_ref', 'location_description',
  'district', 'locality', 'declared_land_use', 'declared_area', 'survey_reference'] as const;
const reason = z.string().trim().min(5).max(1000);

async function record(client: pg.PoolClient, entity: 'category' | 'requirement', key: string, change: Record<string, unknown>, why: string, userId: string) {
  await client.query('INSERT INTO lais.application_config_change (entity, entity_key, change, reason, changed_by) VALUES ($1, $2, $3, $4, $5)',
    [entity, key, JSON.stringify(change), why, userId]);
}

applicationConfigRouter.get('/', async (req, res) => {
  enforce(req, 'application_config.view', {}, { entityType: 'application_config' });
  const [categories, requirements, history, docCategories] = await Promise.all([
    pool.query('SELECT * FROM lais.application_category ORDER BY sort_order, label'),
    pool.query(`SELECT r.*, dc.label AS doc_label FROM lais.application_requirement r LEFT JOIN lais.document_category dc ON dc.code = r.doc_category ORDER BY r.category_code, r.stage, r.kind`),
    pool.query(`SELECT h.*, u.username AS changed_by_username FROM lais.application_config_change h JOIN lais.app_user u ON u.id = h.changed_by ORDER BY h.id DESC LIMIT 200`),
    pool.query('SELECT code, label FROM lais.document_category WHERE active ORDER BY label'),
  ]);
  res.json({
    categories: categories.rows, requirements: requirements.rows, history: history.rows, documentCategories: docCategories.rows,
    fieldKeys: FIELD_KEYS, caseTypes: CASE_TYPES, canManage: authorize(req.auth!.principal, 'application_config.manage').allowed,
    notice: 'Working defaults, not a statutory checklist. Replace them with the requirements approved by the land authority.',
  });
});

const categoryBody = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  label: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).optional(),
  caseType: z.enum(CASE_TYPES),
  sortOrder: z.number().int().min(0).max(1000).default(100),
  reason,
});

applicationConfigRouter.post('/categories', async (req, res) => {
  enforce(req, 'application_config.manage', {}, { entityType: 'application_config' });
  const b = categoryBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [exists] } = await client.query('SELECT 1 FROM lais.application_category WHERE code = $1', [b.code]);
    if (exists) throw conflict(`Category ${b.code} already exists`);
    await client.query('INSERT INTO lais.application_category (code, label, description, case_type, sort_order, updated_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [b.code, b.label, b.description ?? null, b.caseType, b.sortOrder, req.auth!.user.id]);
    await record(client, 'category', b.code, { created: { label: b.label, caseType: b.caseType } }, b.reason, req.auth!.user.id);
    await writeAudit(req, { action: 'application_config.category_created', outcome: 'success', entityType: 'application_category', entityId: b.code, detail: { caseType: b.caseType, reason: b.reason } }, client);
  });
  res.status(201).json({ ok: true });
});

const categoryPatch = z.object({
  label: z.string().trim().min(3).max(120).optional(), description: z.string().trim().max(1000).optional(),
  active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional(), reason,
});

/** The workflow (case type) of a category cannot change: applications already registered depend on it. */
applicationConfigRouter.patch('/categories/:code', async (req, res) => {
  enforce(req, 'application_config.manage', {}, { entityType: 'application_config' });
  const b = categoryPatch.parse(req.body);
  await tx(async (client) => {
    const { rows: [c] } = await client.query('SELECT * FROM lais.application_category WHERE code = $1 FOR UPDATE', [String(req.params.code)]);
    if (!c) throw notFound('Unknown category');
    const change: Record<string, unknown> = {};
    for (const [k, col] of [['label', 'label'], ['description', 'description'], ['active', 'active'], ['sortOrder', 'sort_order']] as const) {
      if (b[k] !== undefined && b[k] !== c[col]) change[col] = { from: c[col], to: b[k] };
    }
    if (!Object.keys(change).length) throw conflict('Nothing changed');
    await client.query(
      `UPDATE lais.application_category SET label = coalesce($2, label), description = coalesce($3, description), active = coalesce($4, active),
              sort_order = coalesce($5, sort_order), updated_by = $6, updated_at = now() WHERE code = $1`,
      [c.code, b.label ?? null, b.description ?? null, b.active ?? null, b.sortOrder ?? null, req.auth!.user.id]);
    await record(client, 'category', c.code, change, b.reason, req.auth!.user.id);
    await writeAudit(req, { action: 'application_config.category_changed', outcome: 'success', entityType: 'application_category', entityId: c.code, detail: { change, reason: b.reason } }, client);
  });
  res.json({ ok: true });
});

const requirementBody = z.object({
  categoryCode: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  kind: z.enum(['field', 'document']),
  fieldKey: z.enum(FIELD_KEYS).optional(),
  docCategory: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/).optional(),
  mandatory: z.boolean().default(true),
  conditionField: z.enum(['declared_area_unit', 'receiving_office', 'title_deed_ref_present', 'survey_reference_present']).optional(),
  conditionValue: z.string().trim().max(120).optional(),
  stage: z.enum(['registration', 'gis_handoff', 'submission']).default('gis_handoff'),
  note: z.string().trim().max(500).optional(),
  reason,
}).refine((b) => (b.kind === 'field') === !!b.fieldKey && (b.kind === 'document') === !!b.docCategory, 'A field requirement names a field; a document requirement names a document category')
  .refine((b) => !!b.conditionField === !!b.conditionValue, 'A condition needs both a field and a value');

applicationConfigRouter.post('/requirements', async (req, res) => {
  enforce(req, 'application_config.manage', {}, { entityType: 'application_config' });
  const b = requirementBody.parse(req.body);
  const id = await tx(async (client) => {
    const { rows: [r] } = await client.query(
      `INSERT INTO lais.application_requirement (category_code, kind, field_key, doc_category, mandatory, condition_field, condition_value, stage, note, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [b.categoryCode, b.kind, b.fieldKey ?? null, b.docCategory ?? null, b.mandatory, b.conditionField ?? null, b.conditionValue ?? null, b.stage, b.note ?? null, req.auth!.user.id]);
    await record(client, 'requirement', r.id, { created: { ...b, reason: undefined } }, b.reason, req.auth!.user.id);
    await writeAudit(req, { action: 'application_config.requirement_created', outcome: 'success', entityType: 'application_requirement', entityId: r.id, detail: { category: b.categoryCode, kind: b.kind, key: b.fieldKey ?? b.docCategory, reason: b.reason } }, client);
    return r.id;
  });
  res.status(201).json({ id });
});

const requirementPatch = z.object({
  mandatory: z.boolean().optional(), active: z.boolean().optional(), stage: z.enum(['registration', 'gis_handoff', 'submission']).optional(),
  note: z.string().trim().max(500).optional(), reason,
});

applicationConfigRouter.patch('/requirements/:id', async (req, res) => {
  enforce(req, 'application_config.manage', {}, { entityType: 'application_config' });
  const b = requirementPatch.parse(req.body);
  await tx(async (client) => {
    const { rows: [r] } = await client.query('SELECT * FROM lais.application_requirement WHERE id = $1 FOR UPDATE', [parseId(req.params.id)]);
    if (!r) throw notFound('Unknown requirement');
    const change: Record<string, unknown> = {};
    for (const k of ['mandatory', 'active', 'stage', 'note'] as const) if (b[k] !== undefined && b[k] !== r[k]) change[k] = { from: r[k], to: b[k] };
    if (!Object.keys(change).length) throw conflict('Nothing changed');
    await client.query(
      `UPDATE lais.application_requirement SET mandatory = coalesce($2, mandatory), active = coalesce($3, active), stage = coalesce($4, stage),
              note = coalesce($5, note), updated_by = $6, updated_at = now() WHERE id = $1`,
      [r.id, b.mandatory ?? null, b.active ?? null, b.stage ?? null, b.note ?? null, req.auth!.user.id]);
    await record(client, 'requirement', r.id, change, b.reason, req.auth!.user.id);
    await writeAudit(req, { action: 'application_config.requirement_changed', outcome: 'success', entityType: 'application_requirement', entityId: r.id, detail: { change, reason: b.reason } }, client);
  });
  res.json({ ok: true });
});

documentBody('POST /application-config/categories', categoryBody);
documentBody('PATCH /application-config/categories/{code}', categoryPatch);
documentBody('POST /application-config/requirements', requirementBody);
documentBody('PATCH /application-config/requirements/{id}', requirementPatch);
