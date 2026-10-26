import { Router } from 'express';
import { pool } from '../db.js';
import { notFound, parseId } from '../http.js';
import { enforce } from '../authz/enforce.js';
import type { Action } from '../authz/policy.js';
import { caseContext, getCase } from '../services/cases.js';
import { sendStoredDocument } from '../services/storedDocuments.js';

export const documentsRouter = Router();

const ACTION_FOR_CLASSIFICATION: Record<string, Action> = {
  public: 'case.view',
  restricted: 'document.view_restricted',
  highly_sensitive: 'document.view_highly_sensitive',
};

documentsRouter.get('/:id/file', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: [doc] } = await pool.query('SELECT * FROM lais.document WHERE id = $1', [id]);
  if (!doc) throw notFound('Document not found');
  const cs = await getCase(pool, doc.case_id);
  enforce(req, ACTION_FOR_CLASSIFICATION[doc.classification], await caseContext(pool, cs), {
    entityType: 'document', entityId: doc.id, caseId: cs.id,
  });
  await sendStoredDocument(req, res, doc, { action: 'document.access', caseId: cs.id, countyId: cs.county_id });
});
