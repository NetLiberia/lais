import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './http.js';
import { log, requestContext } from './logger.js';
import { writeAudit } from './audit.js';
import { csrfProtect, loadSession, requireActiveSession } from './auth/session.js';
import { adminRouter } from './routes/admin.js';
import { adminOpsRouter } from './routes/adminOps.js';
import { documentCategoriesRouter } from './routes/documentCategories.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter } from './routes/search.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { casesRouter } from './routes/cases.js';
import { documentsRouter } from './routes/documents.js';
import { documentRequestsRouter } from './routes/documentRequests.js';
import { meRouter } from './routes/me.js';
import { parcelsRouter } from './routes/parcels.js';
import { partiesRouter } from './routes/parties.js';
import { publicRouter } from './routes/public.js';
import { buildOpenApi } from './openapi.js';

/**
 * Every API router and where it is mounted under /api. The OpenAPI document is generated from this
 * table and the routers' own route lists, so it cannot describe an endpoint that does not exist.
 * 'public' routes need no session; 'internal' routes need a fully authenticated session and CSRF token.
 */
export const API_MOUNTS: { path: string; router: Router; access: 'public' | 'internal'; tag: string }[] = [
  { path: '/public', router: publicRouter, access: 'public', tag: 'Public portal' },
  { path: '/auth', router: authRouter, access: 'public', tag: 'Authentication' },
  { path: '/cases', router: casesRouter, access: 'internal', tag: 'Cases' },
  { path: '/documents', router: documentsRouter, access: 'internal', tag: 'Documents' },
  { path: '/document-requests', router: documentRequestsRouter, access: 'internal', tag: 'Document requests' },
  { path: '/parcels', router: parcelsRouter, access: 'internal', tag: 'Parcels' },
  { path: '/parties', router: partiesRouter, access: 'internal', tag: 'Parties' },
  { path: '/admin', router: adminRouter, access: 'internal', tag: 'Administration: accounts' },
  { path: '/admin', router: adminOpsRouter, access: 'internal', tag: 'Administration: operations' },
  { path: '/notifications', router: notificationsRouter, access: 'internal', tag: 'Notifications' },
  { path: '/search', router: searchRouter, access: 'internal', tag: 'Search' },
  { path: '/document-categories', router: documentCategoriesRouter, access: 'internal', tag: 'Reference data' },
  { path: '/audit', router: auditRouter, access: 'internal', tag: 'Audit' },
  { path: '/me', router: meRouter, access: 'internal', tag: 'Landowner portal' },
];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy, rate limits and audit records need the client address, not the proxy's.
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(requestContext);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', loadSession);

  // Public portal: separate router and a fixed public field list. The session is only used to exempt
  // signed-in staff from the anonymous rate limit; it never widens what these endpoints return.
  for (const m of API_MOUNTS.filter((m) => m.access === 'public')) app.use('/api' + m.path, m.router);
  // The API description lists endpoints only, never data, so it is public like the portal.
  const openApi = buildOpenApi(API_MOUNTS);
  app.get('/api/openapi.json', (_req, res) => { res.json(openApi); });

  // Everything else requires a fully authenticated session and a CSRF token on writes.
  const internal = express.Router();
  internal.use(requireActiveSession, csrfProtect);
  for (const m of API_MOUNTS.filter((m) => m.access === 'internal')) internal.use(m.path, m.router);
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
    // Full detail goes to the server log only; the client gets a generic message and the request id.
    log('error', 'unhandled error', { requestId: req.requestId, error: (err as Error)?.message, stack: (err as Error)?.stack });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
  });

  return app;
}
