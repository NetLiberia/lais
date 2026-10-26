import { Router } from 'express';
import { pool } from '../db.js';
import { enforce } from '../authz/enforce.js';

/** Landowner portal: only the registered interests of the parties linked to this account. */
export const meRouter = Router();

meRouter.get('/parcels', async (req, res) => {
  enforce(req, 'landowner.view_own', {}, { entityType: 'parcel' });
  const { rows } = await pool.query(
    `SELECT p.upi, c.name AS county, p.status, v.land_category, v.land_use, v.area_m2_calculated,
            ST_AsGeoJSON(v.geom, 7)::json AS geometry,
            json_agg(json_build_object('rrrType', r.rrr_type, 'share', CASE WHEN r.share_den IS NULL THEN NULL ELSE r.share_num || '/' || r.share_den END,
                                       'interestStatus', r.interest_status, 'since', r.valid_from, 'holder', pa.name)) AS my_interests
       FROM lais.user_party_link l
       JOIN lais.party pa ON pa.id = l.party_id
       JOIN lais.rrr r ON r.party_id = pa.id AND r.valid_to IS NULL AND r.interest_status = 'registered'
       JOIN lais.parcel p ON p.id = r.parcel_id
       JOIN lais.parcel_version v ON v.id = p.current_version_id
       JOIN lais.county c ON c.id = p.county_id
      WHERE l.user_id = $1 AND l.revoked_at IS NULL
      GROUP BY p.id, c.name, v.id
      ORDER BY p.upi`,
    [req.auth!.user.id],
  );
  res.json(rows);
});
