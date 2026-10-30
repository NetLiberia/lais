import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import type pg from 'pg';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../http.js';
import { writeAudit } from '../audit.js';
import { detectDocumentType } from './files.js';
import { recordEvent, type CaseRow } from './cases.js';

/**
 * Application processing: completeness against the configured requirements, documents with versions,
 * and administrative document review.
 *
 * Three things are deliberately kept apart:
 *   - administrative completeness (this module): the configured fields and documents are present and the
 *     documents passed an administrative review (readable, complete, consistent);
 *   - technical verification by GIS officers and quality review by supervisors;
 *   - the registrar's legal decision (lais.case_decision).
 * Completeness never sets a decision, verifies an identity or approves a title.
 */

export const COMPLETENESS_LABELS: Record<string, string> = {
  draft: 'Draft (registration not finished)',
  awaiting_information: 'Awaiting additional information',
  incomplete: 'Incomplete',
  ready_for_review: 'Ready for administrative review',
  complete: 'Administratively complete',
};

export interface RequirementState {
  requirement_id: string; req_key: string; kind: 'field' | 'document'; label: string; stage: 'registration' | 'gis_handoff' | 'submission';
  mandatory: boolean; applies: boolean; state: 'complete' | 'missing' | 'received' | 'unreadable' | 'incomplete' | 'clarification'; waived_for: string[];
}

const STAGE_ORDER = { registration: 1, gis_handoff: 2, submission: 3 } as const;
export type Stage = keyof typeof STAGE_ORDER;

/** The checklist of an application and what still blocks each stage. */
export async function completeness(db: Db, caseId: string) {
  const [{ rows: items }, { rows: [status] }] = await Promise.all([
    db.query<RequirementState>('SELECT * FROM lais.application_requirement_states($1) ORDER BY stage, kind, label', [caseId]),
    db.query('SELECT lais.application_completeness($1) AS status', [caseId]),
  ]);
  const blocking = (stage: Stage) => items.filter((i) => i.applies && i.mandatory && STAGE_ORDER[i.stage] <= STAGE_ORDER[stage]
    && i.state !== 'complete' && !i.waived_for.includes(stage));
  return {
    status: status.status as string | null,
    label: status.status ? COMPLETENESS_LABELS[status.status] : 'Not registered through intake',
    items,
    blocking: { gis_handoff: blocking('gis_handoff'), submission: blocking('submission') },
    notice: 'Administrative completeness only: it is not legal verification and does not approve ownership or a title.',
  };
}

/**
 * The gate before a stage. Applications registered through intake must meet their configured mandatory
 * requirements, unless a supervisor granted an exception for that stage (recorded with a reason).
 */
export async function assertStageReady(db: Db, cs: CaseRow & { applicant_id?: string | null }, stage: Stage) {
  if (!cs.applicant_id) return;
  const c = await completeness(db, cs.id);
  const missing = c.blocking[stage as 'gis_handoff' | 'submission'] ?? [];
  if (missing.length) {
    throw conflict(`${missing.length} required item(s) are not complete: ${missing.map((m) => `${m.label} (${m.state})`).join('; ')}`,
      { missing: missing.map((m) => ({ key: m.req_key, label: m.label, state: m.state })) });
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const REVIEW_STATUSES = ['not_reviewed', 'under_review', 'accepted', 'incomplete', 'unreadable', 'inconsistent', 'requires_clarification'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
/** Outcomes that are a reviewer's finding; the uploader cannot record them on their own document. */
const FINDINGS: ReviewStatus[] = ['accepted', 'incomplete', 'unreadable', 'inconsistent'];
const NEEDS_REASON: ReviewStatus[] = ['incomplete', 'unreadable', 'inconsistent', 'requires_clarification'];
/** The legacy verification flag the registrar's validation reads, derived from the review status. */
const VERIFICATION_FOR: Partial<Record<ReviewStatus, 'verified' | 'rejected'>> = {
  accepted: 'verified', incomplete: 'rejected', unreadable: 'rejected', inconsistent: 'rejected',
};

export interface StoreDocumentInput {
  docType: string; classification: string; referenceNo?: string | null; issuer?: string | null; issuedOn?: string | null;
  title?: string | null; description?: string | null; supersedesId?: string | null; replacementReason?: string | null;
}

/** Stores an uploaded document (or a new version of one) on a case. The file is checked by its content, never its name. */
export async function storeDocument(req: Request, client: pg.PoolClient, cs: CaseRow, file: { buffer: Buffer; originalname: string; size: number }, input: StoreDocumentInput) {
  const { rows: [category] } = await client.query('SELECT active FROM lais.document_category WHERE code = $1', [input.docType]);
  if (!category?.active) throw badRequest('Unknown or inactive document category');
  const mime = detectDocumentType(file.buffer);
  if (!mime) throw badRequest('Only PDF, PNG, JPEG and TIFF files are accepted (checked from the file content, not its name)');
  if (input.docType === 'id_document' && input.classification !== 'highly_sensitive') throw badRequest('Identity documents must be classified as highly sensitive');
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');

  let previous: { id: string; document_no: string; version_no: number; review_status: string; doc_type: string } | undefined;
  if (input.supersedesId) {
    ({ rows: [previous] } = await client.query<NonNullable<typeof previous>>(
      'SELECT id, document_no, version_no, review_status, doc_type FROM lais.document WHERE id = $1 AND case_id = $2 FOR UPDATE', [input.supersedesId, cs.id]));
    if (!previous) throw notFound('The document to replace is not on this application');
    if (previous.review_status === 'superseded') throw conflict(`${previous.document_no} was already replaced; replace its latest version`);
    if ((input.replacementReason ?? '').trim().length < 5) throw badRequest('Give the reason for replacing the document (5+ characters)');
  }
  const { rows: [same] } = await client.query(
    `SELECT document_no FROM lais.document WHERE case_id = $1 AND sha256 = $2 AND doc_type = $3 AND review_status <> 'superseded' AND id IS DISTINCT FROM $4 LIMIT 1`,
    [cs.id, sha256, input.docType, input.supersedesId ?? null]);
  if (same) throw conflict(`This exact file is already on the application as ${same.document_no} in the same category`);

  const storageKey = randomBytes(16).toString('hex');
  const filePath = path.join(config.documentStorageDir, storageKey);
  await fs.mkdir(config.documentStorageDir, { recursive: true });
  // Malware scanning would plug in here before the file is accepted (not implemented in the prototype).
  await fs.writeFile(filePath, file.buffer, { flag: 'wx' });
  try {
    if (previous) {
      await client.query(`UPDATE lais.document SET review_status = 'superseded' WHERE id = $1`, [previous.id]);
      await client.query(
        `INSERT INTO lais.document_review_event (document_id, case_id, from_status, to_status, note, actor_id) VALUES ($1, $2, $3, 'superseded', $4, $5)`,
        [previous.id, cs.id, previous.review_status, `Replaced: ${input.replacementReason}`, req.auth!.user.id]);
    }
    const { rows: [doc] } = await client.query(
      `INSERT INTO lais.document (case_id, doc_type, reference_no, issuer, issued_on, classification, storage_key, sha256, mime_type, size_bytes,
                                  original_name, uploaded_by, title, description, version_no, supersedes_id, replacement_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id, document_no, version_no`,
      [cs.id, input.docType, input.referenceNo || null, input.issuer || null, input.issuedOn || null, input.classification, storageKey, sha256, mime,
        file.size, path.basename(file.originalname).replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document', req.auth!.user.id,
        input.title || null, input.description || null, previous ? previous.version_no + 1 : 1, previous?.id ?? null, previous ? input.replacementReason : null],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, previous ? 'replace_document' : 'upload_document',
      previous ? `${doc.document_no} (version ${doc.version_no}) replaces ${previous.document_no}: ${input.replacementReason}` : `${doc.document_no} ${input.docType} ${input.referenceNo ?? ''}`.trim());
    await writeAudit(req, {
      action: previous ? 'document.replace' : 'document.upload', outcome: 'success', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id,
      detail: { documentNo: doc.document_no, docType: input.docType, classification: input.classification, sha256, version: doc.version_no, supersedes: previous?.document_no ?? null },
    }, client);
    return doc as { id: string; document_no: string; version_no: number };
  } catch (err) {
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  }
}

/**
 * Records an administrative review of a document. Findings (accepted, incomplete, unreadable, inconsistent)
 * need a reviewer other than the uploader; negative findings and clarification requests need a reason.
 * A document can be referred for an authorized (legal) decision instead of being judged here.
 */
export async function reviewDocument(req: Request, client: pg.PoolClient, cs: CaseRow, documentId: string, input: {
  status: ReviewStatus; note?: string | null; checks?: Record<string, boolean>; refer?: boolean;
}) {
  const { rows: [doc] } = await client.query('SELECT * FROM lais.document WHERE id = $1 AND case_id = $2 FOR UPDATE', [documentId, cs.id]);
  if (!doc) throw notFound('Document not found on this application');
  if (doc.review_status === 'superseded') throw conflict(`${doc.document_no} was replaced by a newer version; review the latest version`);
  if (doc.review_status === input.status && !input.note) throw conflict(`${doc.document_no} is already ${input.status.replace(/_/g, ' ')}`);
  const note = (input.note ?? '').trim();
  if (NEEDS_REASON.includes(input.status) && note.length < 5) throw badRequest('Give the reason (5+ characters)');
  if (input.refer && note.length < 5) throw badRequest('Explain what needs an authorized decision (5+ characters)');
  if (FINDINGS.includes(input.status) && doc.uploaded_by === req.auth!.user.id) {
    throw new HttpError(403, 'Separation of duties: the officer who uploaded a document cannot record its review').withAudit({
      action: 'authz.denied', outcome: 'denied', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id,
      detail: { requestedAction: 'document.review', reason: 'uploader_cannot_review' },
    });
  }
  const verification = VERIFICATION_FOR[input.status];
  await client.query(
    `UPDATE lais.document SET review_status = $2,
            verification_status = $3, verified_by = CASE WHEN $3 = 'pending' THEN NULL ELSE $4::uuid END,
            verified_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END, verification_note = $5
      WHERE id = $1`,
    [doc.id, input.status, verification ?? 'pending', req.auth!.user.id, note || null],
  );
  await client.query(
    `INSERT INTO lais.document_review_event (document_id, case_id, from_status, to_status, checks, note, referred, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [doc.id, cs.id, doc.review_status, input.status, JSON.stringify(input.checks ?? {}), note || null, !!input.refer, req.auth!.user.id],
  );
  await recordEvent(client, cs.id, req.auth!.user.id, 'review_document',
    `${doc.document_no}: ${input.status.replace(/_/g, ' ')}${input.refer ? ' (referred for an authorized decision)' : ''}${note ? `: ${note}` : ''}`);
  await writeAudit(req, {
    action: 'document.review', outcome: 'success', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id,
    detail: { documentNo: doc.document_no, from: doc.review_status, to: input.status, referred: !!input.refer },
  }, client);
  return { documentNo: doc.document_no as string, status: input.status };
}

/** Masks contact details for viewers without permission: "+231 77 *** 123". */
export const maskPhone = (v: string | null) => (v ? `${v.slice(0, Math.min(7, v.length - 3))}***${v.slice(-3)}` : null);
export const maskEmail = (v: string | null) => (v ? v.replace(/^(.).*(@.*)$/, '$1***$2') : null);
