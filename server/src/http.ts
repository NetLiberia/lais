import { z } from 'zod';
import type { AuditEntry } from './audit.js';

export class HttpError extends Error {
  /**
   * An audit event the error handler records once the request's transaction has rolled back.
   * Writing it from inside the transaction on a second connection could exhaust the pool.
   */
  auditEntry?: AuditEntry;

  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  withAudit(entry: AuditEntry): this {
    this.auditEntry = entry;
    return this;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, details);

const uuid = z.string().uuid();

/** Parses a route id; malformed ids are reported as not found rather than leaking validation detail. */
export function parseId(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}
