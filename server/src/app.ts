import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import { HttpError } from './http.js';
import { writeAudit } from './audit.js';
import { csrfProtect, loadSession, requireActiveSession } from './auth/session.js';
import { adminRouter } from './routes/admin.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { casesRouter } from './routes/cases.js';
import { documentsRouter } from './routes/documents.js';
import { documentRequestsRouter } from './routes/documentRequests.js';
import { meRouter } from './routes/me.js';
import { parcelsRouter } from './routes/parcels.js';
import { partiesRouter } from './routes/parties.js';
import { publicRouter } from './routes/public.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', loadSession);

  // Public portal: separate router and a fixed public field list. The session is only used to exempt
  // signed-in staff from the anonymous rate limit; it never widens what these endpoints return.
  app.use('/api/public', publicRouter);
  app.use('/api/auth', authRouter);

  // Everything else requires a fully authenticated session and a CSRF token on writes.
  const internal = express.Router();
  internal.use(requireActiveSession, csrfProtect);
  internal.use('/cases', casesRouter);
  internal.use('/documents', documentsRouter);
  internal.use('/document-requests', documentRequestsRouter);
  internal.use('/parcels', parcelsRouter);
  internal.use('/parties', partiesRouter);
  internal.use('/admin', adminRouter);
  internal.use('/audit', auditRouter);
  internal.use('/me', meRouter);
  app.use('/api', internal);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.auditEntry) {
        await writeAudit(req, err.auditEntry).catch((auditErr) => console.error('audit write failed', auditErr));
      }
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Malformed JSON' });
    const pgErr = err as { code?: string; message?: string };
    // Messages raised by our own integrity triggers are safe to show; other database errors are not.
    if (pgErr.code === 'P0001') return res.status(409).json({ error: pgErr.message });
    if (pgErr.code === '23505') return res.status(409).json({ error: 'A record with that identifier already exists' });
    if (pgErr.code === '23514') return res.status(409).json({ error: 'The change violates a data integrity rule' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
