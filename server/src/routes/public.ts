import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { badRequest, notFound } from '../http.js';

/**
 * Public information portal. Deliberately separate from the internal API: these queries
 * can only ever read the columns listed in PUBLIC_PARCEL_FIELDS, so no party names,
 * documents, identity data or internal notes can leak through the public map.
 *
 * The field list is a placeholder pending the disclosure policy approved under Liberian law.
 */
export const PUBLIC_PARCEL_FIELDS = ['upi', 'county', 'land_category', 'land_use', 'record_status'] as const;

export const publicRouter = Router();

// Anonymous visitors are rate limited per address. Signed-in staff are not: their maps use this endpoint
// too, and a county office behind one shared connection would otherwise exhaust a per-address limit.
// The session is verified (loadSession runs first), so a fabricated cookie does not bypass the limit.
publicRouter.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.auth?.state === 'active',
}));

// "registered" only when at least one interest has been confirmed through an approved case; parcels
// migrated from a legacy register carry documented (unverified) interests until then.
const STATUS_LABEL = `CASE
    WHEN p.status = 'disputed' THEN 'under dispute'
    WHEN p.status <> 'active' THEN p.status
    WHEN EXISTS (SELECT 1 FROM lais.rrr r WHERE r.parcel_id = p.id AND r.valid_to IS NULL AND r.interest_status = 'registered') THEN 'registered'
    ELSE 'recorded, interests not yet verified'
  END`;

publicRouter.get('/counties', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, is_synthetic, ST_AsGeoJSON(geom, 6)::json AS geometry FROM lais.county ORDER BY id`,
  );
  res.json({
    type: 'FeatureCollection',
    features: rows.map(({ geometry, ...properties }) => ({ type: 'Feature', geometry, properties })),
  });
});

const bboxQuery = z.object({ bbox: z.string() });
const MAX_BBOX_DEGREES = 1.0;
const MAX_FEATURES = 2000;

publicRouter.get('/parcels', async (req, res) => {
  const { bbox } = bboxQuery.parse(req.query);
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw badRequest('bbox must be minLon,minLat,maxLon,maxLat');
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) throw badRequest('bbox is inverted');
  if (maxLon - minLon > MAX_BBOX_DEGREES || maxLat - minLat > MAX_BBOX_DEGREES) {
    // Limits bulk harvesting and keeps responses small on slow connections.
    return res.json({ type: 'FeatureCollection', features: [], truncated: true, message: 'Zoom in to see parcels' });
  }
  const { rows } = await pool.query(
    `SELECT p.upi, c.name AS county, v.land_category, v.land_use, ${STATUS_LABEL} AS record_status,
            ST_AsGeoJSON(v.geom, 7)::json AS geometry
       FROM lais.parcel_version v
       JOIN lais.parcel p ON p.id = v.parcel_id AND p.current_version_id = v.id
       JOIN lais.county c ON c.id = p.county_id
      WHERE v.valid_to IS NULL AND p.status <> 'retired'
        AND v.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      LIMIT ${MAX_FEATURES + 1}`,
    [minLon, minLat, maxLon, maxLat],
  );
  const truncated = rows.length > MAX_FEATURES;
  res.json({
    type: 'FeatureCollection',
    truncated,
    features: rows.slice(0, MAX_FEATURES).map(({ geometry, ...properties }) => ({ type: 'Feature', geometry, properties })),
  });
});

publicRouter.get('/parcels/:upi', async (req, res) => {
  const upi = z.string().max(40).parse(req.params.upi);
  const { rows: [row] } = await pool.query(
    `SELECT p.upi, c.name AS county, v.land_category, v.land_use, ${STATUS_LABEL} AS record_status,
            v.area_m2_calculated, v.area_method, v.valid_from AS current_since,
            ST_AsGeoJSON(v.geom, 7)::json AS geometry
       FROM lais.parcel p
       JOIN lais.parcel_version v ON v.id = p.current_version_id
       JOIN lais.county c ON c.id = p.county_id
      WHERE p.upi = $1 AND p.status <> 'retired'`,
    [upi],
  );
  if (!row) {
    // A retired identifier points to the parcel(s) that replaced it, so old references remain traceable.
    const { rows: successors } = await pool.query(
      `SELECT DISTINCT child.upi FROM lais.parcel old
         JOIN lais.parcel_lineage l ON l.parent_parcel_id = old.id
         JOIN lais.parcel child ON child.id = l.child_parcel_id
        WHERE old.upi = $1 AND old.status = 'retired' ORDER BY child.upi`,
      [upi],
    );
    if (successors.length === 0) throw notFound('No public record for that identifier');
    throw notFound(`Parcel ${upi} has been retired and replaced by ${successors.map((s) => s.upi).join(', ')}`);
  }
  const { geometry, ...properties } = row;
  res.json({ type: 'Feature', geometry, properties });
});
