import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { writeAudit } from '../audit.js';

interface StoredDocument {
  id: string;
  storage_key: string;
  sha256: string;
  mime_type: string;
  original_name: string;
  classification: string;
  doc_type: string;
}

/**
 * Sends a stored document after checking it still matches its recorded hash.
 * The access event is audited with the given action name and context.
 */
export async function sendStoredDocument(
  req: Request,
  res: Response,
  doc: StoredDocument,
  audit: { action: string; caseId?: string | null; countyId?: number | null; detail?: Record<string, unknown> },
): Promise<void> {
  const buffer = await fs.readFile(path.join(config.documentStorageDir, doc.storage_key));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== doc.sha256) {
    await writeAudit(req, { action: 'document.integrity_failure', outcome: 'failure', entityType: 'document', entityId: doc.id, caseId: audit.caseId, countyId: audit.countyId });
    throw new HttpError(500, 'The stored file does not match its recorded hash; access refused and the incident logged');
  }
  await writeAudit(req, {
    action: audit.action, outcome: 'success', entityType: 'document', entityId: doc.id, caseId: audit.caseId, countyId: audit.countyId,
    detail: { classification: doc.classification, docType: doc.doc_type, ...audit.detail },
  });

  const safeName = doc.original_name.replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}
