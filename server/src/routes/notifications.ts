import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound, parseId } from '../http.js';

/** In-app notifications for the signed-in user. Users only ever see their own. */
export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const unreadOnly = z.enum(['true', 'false']).default('false').parse(req.query.unreadOnly) === 'true';
  const { rows } = await pool.query(
    `SELECT id, category, title, body, link, created_at, read_at FROM lais.notification
      WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC LIMIT 50`,
    [req.auth!.user.id, unreadOnly],
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
