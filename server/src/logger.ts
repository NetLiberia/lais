import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Structured (JSON-lines) logging to stdout. Never log request bodies, passwords, tokens, cookies or
 * document contents: callers pass only the fields they mean to record.
 */
type Level = 'info' | 'warn' | 'error';

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && level === 'info') return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Gives every request a correlation id (reusing a well-formed X-Request-Id from a trusted proxy),
 * echoes it in the response, and logs one line per API request with its outcome and duration.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api')) return;
    log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      user: req.auth?.user.username,
    });
  });
  next();
}
