import { Router } from 'express';
import { pool } from '../db.js';

/** Active document categories, for upload forms. Managing them is an administrator task (see adminOps). */
export const documentCategoriesRouter = Router();

documentCategoriesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT code, label, description FROM lais.document_category WHERE active ORDER BY system DESC, label');
  res.json(rows);
});
