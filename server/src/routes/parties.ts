import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';

export const partiesRouter = Router();

const searchQuery = z.object({ q: z.string().max(100).optional() });

/** Search returns names and verification state only; identity numbers and contact details are never included. */
partiesRouter.get('/', async (req, res) => {
  enforce(req, 'party.search', {}, { entityType: 'party' });
  const { q } = searchQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, party_type, name, identity_status, (national_id_ref IS NOT NULL) AS has_id_reference, is_synthetic, created_at
       FROM lais.party
      WHERE ($1::text IS NULL OR lower(name) LIKE '%' || lower($1) || '%')
      ORDER BY name LIMIT 50`,
    [q?.trim() || null],
  );
  res.json(rows);
});

const createBody = z.object({
  partyType: z.enum(['person', 'organization', 'community', 'government']),
  name: z.string().trim().min(2).max(200),
  nationalIdRef: z.string().trim().max(60).optional(),
  contact: z.string().trim().max(200).optional(),
});

partiesRouter.post('/', async (req, res) => {
  enforce(req, 'party.create', {}, { entityType: 'party' });
  const body = createBody.parse(req.body);
  const party = await tx(async (client) => {
    const { rows: [p] } = await client.query(
      `INSERT INTO lais.party (party_type, name, national_id_ref, contact, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.partyType, body.name, body.nationalIdRef || null, body.contact || null, req.auth!.user.id],
    );
    await writeAudit(req, { action: 'party.create', outcome: 'success', entityType: 'party', entityId: p.id, detail: { partyType: body.partyType } }, client);
    return p;
  });
  res.status(201).json(party);
});

/** Sensitive identity details, for officers who need them. Every read is logged. */
partiesRouter.get('/:id/sensitive', async (req, res) => {
  const id = parseId(req.params.id);
  enforce(req, 'party.view_sensitive', {}, { entityType: 'party', entityId: id });
  const { rows: [p] } = await pool.query('SELECT id, name, national_id_ref, contact FROM lais.party WHERE id = $1', [id]);
  if (!p) throw notFound('Party not found');
  await writeAudit(req, { action: 'party.view_sensitive', outcome: 'success', entityType: 'party', entityId: id });
  res.setHeader('Cache-Control', 'no-store');
  res.json(p);
});

const verifyBody = z.object({ note: z.string().trim().min(5).max(1000) });

partiesRouter.post('/:id/verify-identity', async (req, res) => {
  const id = parseId(req.params.id);
  enforce(req, 'party.verify_identity', {}, { entityType: 'party', entityId: id });
  const { note } = verifyBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM lais.party WHERE id = $1 FOR UPDATE', [id]);
    if (!p) throw notFound('Party not found');
    if (p.identity_status === 'verified') throw conflict('Identity already verified');
    if (p.created_by === req.auth!.user.id) {
      throw new HttpError(403, 'Separation of duties: the officer who recorded a party cannot verify their identity');
    }
    await client.query(
      `UPDATE lais.party SET identity_status = 'verified', verified_by = $2, verified_at = now(), verification_note = $3 WHERE id = $1`,
      [id, req.auth!.user.id, note],
    );
    await writeAudit(req, { action: 'party.verify_identity', outcome: 'success', entityType: 'party', entityId: id }, client);
  });
  res.json({ ok: true });
});

const linkBody = z.object({ username: z.string().trim().toLowerCase().max(64) });

/**
 * Links a landowner portal account to a verified party, after the officer has checked the
 * person's identity through the approved process. The link lets the account see that party's
 * registered interests; it is not itself evidence of ownership.
 */
partiesRouter.post('/:id/link-user', async (req, res) => {
  const id = parseId(req.params.id);
  enforce(req, 'party.link_user', {}, { entityType: 'party', entityId: id });
  const { username } = linkBody.parse(req.body);
  await tx(async (client) => {
    const { rows: [p] } = await client.query('SELECT identity_status FROM lais.party WHERE id = $1', [id]);
    if (!p) throw notFound('Party not found');
    if (p.identity_status !== 'verified') throw conflict('Verify the party identity before linking an account');
    const { rows: [u] } = await client.query(
      `SELECT u.id FROM lais.app_user u
        WHERE u.username = $1 AND EXISTS (SELECT 1 FROM lais.role_assignment r WHERE r.user_id = u.id AND r.role = 'landowner' AND r.revoked_at IS NULL)`,
      [username],
    );
    if (!u) throw badRequest('No landowner account with that username');
    await client.query(
      `INSERT INTO lais.user_party_link (user_id, party_id, linked_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [u.id, id, req.auth!.user.id],
    );
    await writeAudit(req, { action: 'party.link_user', outcome: 'success', entityType: 'party', entityId: id, detail: { userId: u.id } }, client);
  });
  res.json({ ok: true });
});
