import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound, parseId } from '../http.js';
import { documentQuery } from '../openapi.js';

/** In-app notifications for the signed-in user. Users only ever see their own. */
export const notificationsRouter = Router();

const listQuery = documentQuery('GET /notifications', z.object({
  unreadOnly: z.enum(['true', 'false']).default('false'),
  category: z.enum(['account', 'security', 'workflow', 'gis', 'system', 'task', 'escalation', 'review']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}));

notificationsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const unreadOnly = q.unreadOnly === 'true';
  const { rows } = await pool.query(
    `SELECT id, category, title, body, link, created_at, read_at FROM lais.notification
      WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL) AND ($3::text IS NULL OR category = $3)
      ORDER BY created_at DESC LIMIT $4`,
    [req.auth!.user.id, unreadOnly, q.category ?? null, q.limit],
  );
  const { rows: [count] } = await pool.query(
    'SELECT count(*)::int AS unread FROM lais.notification WHERE user_id = $1 AND read_at IS NULL',
    [req.auth!.user.id],
  );
  res.json({ items: rows, unread: count.unread });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE lais.notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2',
    [parseId(req.params.id), req.auth!.user.id],
  );
  if (!rowCount) throw notFound('Notification not found');
  res.json({ ok: true });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await pool.query('UPDATE lais.notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.auth!.user.id]);
  res.json({ ok: true });
});
