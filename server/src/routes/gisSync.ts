import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { badRequest, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { scopeFor } from '../authz/policy.js';
import { caseContext, getCase } from '../services/cases.js';
import { LIMITS } from '../services/gisFormats.js';
import { awaitJob, createJob, saveUpload, startJob } from '../services/gisJobs.js';
import { requireSyncToken } from '../auth/syncToken.js';
import { ADAPTER_VERSION } from './gis.js';
import { documentBody } from '../openapi.js';

/**
 * The endpoint the ArcMap adapter talks to. It authenticates with a personal sync token (Authorization:
 * Bearer), never a session cookie or a password, and accepts only LAIS export packages. A package becomes
 * an ordinary import job of the token owner, with the owner's county permissions; resending an export
 * that was already processed returns the earlier job instead of staging it twice.
 */
export const gisSyncRouter = Router();

gisSyncRouter.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));
gisSyncRouter.use(requireSyncToken);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.maxUploadBytes, files: 1, fields: 10 } });

/** Connection test used by the adapter: who the token belongs to and which counties it can sync. */
gisSyncRouter.get('/ping', async (req, res) => {
  const scope = scopeFor(req.auth!.principal, 'case.import_geometry');
  const { rows } = await pool.query('SELECT id, code, name FROM lais.county WHERE $1::smallint[] IS NULL OR id = ANY($1) ORDER BY code', [scope === 'all' ? null : scope]);
  res.json({ ok: true, user: req.auth!.user.username, counties: rows, serverAdapterVersion: ADAPTER_VERSION, acceptedCrs: [4326, 32629], maxUploadBytes: LIMITS.maxUploadBytes });
});

const packageFields = z.object({
  caseNo: z.string().trim().regex(/^[A-Z0-9-]{3,40}$/),
  purpose: z.string().trim().max(500).optional(),
});

gisSyncRouter.post('/packages', upload.single('package'), async (req, res) => {
  const fields = packageFields.parse(req.body ?? {});
  if (!req.file) throw badRequest('Attach the export package (field "package")');
  if (!/\.zip$/i.test(req.file.originalname)) throw badRequest('The package must be the .zip produced by the LAIS ArcMap adapter');
  const { rows: [found] } = await pool.query('SELECT id FROM lais.land_case WHERE case_no = $1', [fields.caseNo]);
  if (!found) throw notFound(`Case ${fields.caseNo} not found`);
  const cs = await getCase(pool, found.id);
  enforce(req, 'case.import_geometry', await caseContext(pool, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
  const meta = await saveUpload(req.file.buffer, req.file.originalname, req.auth!.user.id);
  const job = await createJob(req, { kind: 'arcmap_sync', caseId: cs.id, uploadKey: meta.key, purpose: fields.purpose ?? null });
  if (!job.duplicate) {
    startJob(job.id);
    await awaitJob(job.id, 20_000);
  }
  await writeAudit(req, { action: 'gis.sync_package_received', outcome: 'success', entityType: 'import_job', entityId: job.id, caseId: cs.id, countyId: cs.county_id,
    detail: { jobNo: job.job_no, duplicate: job.duplicate, via: 'sync_token', tokenId: req.auth!.syncTokenId } });
  res.status(job.duplicate ? 200 : 202).json({ ...(await jobStatus(job.id, req.auth!.user.id)), duplicate: job.duplicate });
});

async function jobStatus(id: string, userId: string) {
  const { rows: [j] } = await pool.query(
    `SELECT j.id, j.job_no, j.status, j.export_id, j.records_received, j.records_accepted, j.records_rejected, j.error_summary,
            jsonb_array_length(j.warnings) AS warning_count, b.version_no, c.case_no, j.created_at, j.finished_at
       FROM staging.import_job j JOIN lais.land_case c ON c.id = j.case_id LEFT JOIN staging.batch b ON b.id = j.batch_id
      WHERE j.id = $1 AND j.initiated_by = $2`,
    [id, userId],
  );
  if (!j) throw notFound('Job not found');
  return j;
}

/** The adapter polls its own jobs only. */
gisSyncRouter.get('/jobs/:id', async (req, res) => {
  res.json(await jobStatus(parseId(req.params.id), req.auth!.user.id));
});

documentBody('POST /gis/arcmap/packages', packageFields);
