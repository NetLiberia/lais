import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { enforce } from '../authz/enforce.js';
import { authorize, scopeFor } from '../authz/policy.js';
import { documentQuery } from '../openapi.js';

/**
 * Global search across records the caller is allowed to discover: parcels (public fields only), cases in
 * their jurisdiction, staff accounts (if they can read users) and counties. Party names, identity data
 * and document contents are never searched or returned.
 */
export const searchRouter = Router();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const searchQuery = documentQuery('GET /search', z.object({ q: z.string().trim().min(2).max(60) }));

searchRouter.get('/', async (req, res) => {
  // Staff only: landowner portal accounts have no search.
  enforce(req, 'counties.read', {}, { entityType: 'search' });
  const { q } = searchQuery.parse(req.query);
  const like = `%${escapeLike(q)}%`;
  const principal = req.auth!.principal;
  const results: { type: string; id: string; title: string; subtitle: string; link: string }[] = [];

  const parcelScope = scopeFor(principal, 'parcel.view_internal');
  const { rows: parcels } = await pool.query(
    `SELECT p.upi, p.county_id, c.name AS county FROM lais.parcel p JOIN lais.county c ON c.id = p.county_id
      WHERE p.upi ILIKE $1 OR ($2::boolean AND p.legacy_ref ILIKE $1) ORDER BY p.upi LIMIT 8`,
    // Legacy references are internal: matched only for officers who can see internal parcel records.
    [like, parcelScope === 'all' || parcelScope.length > 0],
  );
  for (const p of parcels) {
    const internal = parcelScope === 'all' || parcelScope.includes(p.county_id);
    results.push({ type: 'parcel', id: p.upi, title: p.upi, subtitle: p.county, link: internal ? `/work/parcels/${p.upi}` : `/?upi=${p.upi}` });
  }

  const caseScope = scopeFor(principal, 'case.view');
  if (caseScope === 'all' || caseScope.length > 0) {
    const { rows: cases } = await pool.query(
      `SELECT c.id, c.case_no, c.case_type, c.status, co.code FROM lais.land_case c JOIN lais.county co ON co.id = c.county_id
        WHERE c.case_no ILIKE $1 AND ($2::smallint[] IS NULL OR c.county_id = ANY($2)) ORDER BY c.updated_at DESC LIMIT 8`,
      [like, caseScope === 'all' ? null : caseScope],
    );
    for (const c of cases) {
      results.push({ type: 'case', id: c.id, title: c.case_no, subtitle: `${c.case_type.replace('_', ' ')} · ${c.status.replace('_', ' ')} · ${c.code}`, link: `/work/cases/${c.id}` });
    }
  }

  if (authorize(principal, 'users.read').allowed) {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.staff_id FROM lais.app_user u
        WHERE (u.username ILIKE $1 OR u.display_name ILIKE $1 OR u.staff_id ILIKE $1)
          AND NOT EXISTS (SELECT 1 FROM lais.role_assignment r WHERE r.user_id = u.id AND r.role = 'landowner' AND r.revoked_at IS NULL)
        ORDER BY u.username LIMIT 8`,
      [like],
    );
    for (const u of users) {
      results.push({ type: 'user', id: u.id, title: u.display_name, subtitle: [u.username, u.staff_id].filter(Boolean).join(' · '), link: `/admin/users?user=${u.id}` });
    }
  }

  if (authorize(principal, 'counties.read').allowed) {
    const { rows: counties } = await pool.query(
      'SELECT id, code, name, boundary_status FROM lais.county WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT 5',
      [like],
    );
    const canManage = authorize(principal, 'counties.manage').allowed;
    for (const c of counties) {
      results.push({ type: 'county', id: String(c.id), title: c.name, subtitle: `${c.code} · boundary ${c.boundary_status}`, link: canManage ? `/admin/counties?county=${c.id}` : `/?county=${c.code}` });
    }
  }
  res.json({ q, results });
});
