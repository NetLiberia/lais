import type { Request } from 'express';
import { HttpError } from '../http.js';
import { authorize, type Action, type ResourceContext } from './policy.js';

interface Target {
  entityType: string;
  entityId?: string | null;
  caseId?: string | null;
}

/**
 * Server-side permission check. A denial throws a 403 that carries its audit event;
 * the error handler writes it after any surrounding transaction has rolled back, so
 * denials are always recorded without holding a second database connection.
 */
export function enforce(req: Request, action: Action, ctx: ResourceContext, target: Target): void {
  const decision = authorize(req.auth?.principal, action, ctx);
  if (decision.allowed) return;
  throw new HttpError(403, decision.reason).withAudit({
    action: 'authz.denied',
    outcome: 'denied',
    entityType: target.entityType,
    entityId: target.entityId,
    caseId: target.caseId,
    countyId: ctx.countyId ?? null,
    detail: { requestedAction: action, reason: decision.reason, method: req.method, path: req.originalUrl.split('?')[0] },
  });
}
