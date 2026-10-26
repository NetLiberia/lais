import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import type { Action } from '../authz/policy.js';
import { caseContext, getCase } from '../services/cases.js';

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

  const buffer = await fs.readFile(path.join(config.documentStorageDir, doc.storage_key));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== doc.sha256) {
    await writeAudit(req, { action: 'document.integrity_failure', outcome: 'failure', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id });
    throw new HttpError(500, 'The stored file does not match its recorded hash; access refused and the incident logged');
  }
  await writeAudit(req, {
    action: 'document.access', outcome: 'success', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id,
    detail: { classification: doc.classification, docType: doc.doc_type },
  });

  const safeName = doc.original_name.replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});
