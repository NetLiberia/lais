import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { conflict, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize } from '../authz/policy.js';

export const parcelsRouter = Router();

async function findParcel(upi: string) {
  const { rows: [parcel] } = await pool.query('SELECT * FROM lais.parcel WHERE upi = $1', [z.string().max(40).parse(upi)]);
  if (!parcel) throw notFound('Parcel not found');
  return parcel;
}

/** Internal registry view: versions, current and historical rights, cases and disputes. Access is logged. */
parcelsRouter.get('/:upi', async (req, res) => {
  const parcel = await findParcel(req.params.upi);
  enforce(req, 'parcel.view_internal', { countyId: parcel.county_id }, { entityType: 'parcel', entityId: parcel.id });

  const [county, versions, rights, cases, disputes] = await Promise.all([
    pool.query('SELECT id, code, name FROM lais.county WHERE id = $1', [parcel.county_id]),
    pool.query(
      `SELECT v.id, v.version_no, v.land_category, v.land_use, v.area_m2_calculated, v.area_m2_surveyed, v.area_method,
              v.source_reference, v.valid_from, v.valid_to, c.case_no AS published_by_case,
              ST_AsGeoJSON(v.geom, 7)::json AS geometry
         FROM lais.parcel_version v LEFT JOIN lais.land_case c ON c.id = v.published_by_case
        WHERE v.parcel_id = $1 ORDER BY v.version_no DESC`,
      [parcel.id],
    ),
    pool.query(
      `SELECT r.id, r.rrr_type, r.share_num, r.share_den, r.interest_status, r.valid_from, r.valid_to,
              p.id AS party_id, p.name AS party_name, p.party_type, p.identity_status,
              cc.case_no AS created_by_case, ec.case_no AS ended_by_case
         FROM lais.rrr r
         JOIN lais.party p ON p.id = r.party_id
         LEFT JOIN lais.land_case cc ON cc.id = r.created_by_case
         LEFT JOIN lais.land_case ec ON ec.id = r.ended_by_case
        WHERE r.parcel_id = $1 ORDER BY r.valid_to NULLS FIRST, r.valid_from DESC`,
      [parcel.id],
    ),
    pool.query(
      `SELECT id, case_no, case_type, status, created_at, updated_at FROM lais.land_case WHERE parcel_id = $1 ORDER BY created_at DESC`,
      [parcel.id],
    ),
    pool.query(
      `SELECT d.id, d.reason, d.referral, d.opened_at, d.closed_at, d.resolution, o.username AS opened_by, c.username AS closed_by
         FROM lais.parcel_dispute d JOIN lais.app_user o ON o.id = d.opened_by LEFT JOIN lais.app_user c ON c.id = d.closed_by
        WHERE d.parcel_id = $1 ORDER BY d.opened_at DESC`,
      [parcel.id],
    ),
  ]);

  await writeAudit(req, { action: 'parcel.view_internal', outcome: 'success', entityType: 'parcel', entityId: parcel.id, countyId: parcel.county_id });
  res.json({
    parcel: { ...parcel, county: county.rows[0] },
    versions: versions.rows,
    currentRights: rights.rows.filter((r) => r.valid_to === null),
    historicalRights: rights.rows.filter((r) => r.valid_to !== null),
    cases: cases.rows,
    disputes: disputes.rows,
    canManageDisputes: authorize(req.auth!.principal, 'parcel.manage_dispute', { countyId: parcel.county_id }).allowed,
  });
});

const openDisputeBody = z.object({ reason: z.string().trim().min(10).max(2000), referral: z.string().max(300).optional() });

/** Records that a parcel is contested. The system records the dispute; it does not decide it. */
parcelsRouter.post('/:upi/disputes', async (req, res) => {
  const body = openDisputeBody.parse(req.body);
  const parcel = await findParcel(req.params.upi);
  enforce(req, 'parcel.manage_dispute', { countyId: parcel.county_id }, { entityType: 'parcel', entityId: parcel.id });
  const dispute = await tx(async (client) => {
    const { rows: [d] } = await client.query(
      'INSERT INTO lais.parcel_dispute (parcel_id, opened_by, reason, referral) VALUES ($1, $2, $3, $4) RETURNING id',
      [parcel.id, req.auth!.user.id, body.reason, body.referral ?? null],
    );
    await client.query(`UPDATE lais.parcel SET status = 'disputed' WHERE id = $1`, [parcel.id]);
    await writeAudit(req, { action: 'parcel.dispute_open', outcome: 'success', entityType: 'parcel', entityId: parcel.id, countyId: parcel.county_id, detail: { disputeId: d.id } }, client);
    return d;
  });
  res.status(201).json(dispute);
});

const closeDisputeBody = z.object({ resolution: z.string().trim().min(10).max(2000) });

parcelsRouter.post('/:upi/disputes/:disputeId/close', async (req, res) => {
  const body = closeDisputeBody.parse(req.body);
  const disputeId = parseId(req.params.disputeId);
  const parcel = await findParcel(req.params.upi);
  enforce(req, 'parcel.manage_dispute', { countyId: parcel.county_id }, { entityType: 'parcel', entityId: parcel.id });
  await tx(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE lais.parcel_dispute SET closed_by = $3, closed_at = now(), resolution = $4
        WHERE id = $1 AND parcel_id = $2 AND closed_at IS NULL`,
      [disputeId, parcel.id, req.auth!.user.id, body.resolution],
    );
    if (!rowCount) throw conflict('No open dispute with that id on this parcel');
    await client.query(
      `UPDATE lais.parcel SET status = 'active'
        WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM lais.parcel_dispute WHERE parcel_id = $1 AND closed_at IS NULL)`,
      [parcel.id],
    );
    await writeAudit(req, { action: 'parcel.dispute_close', outcome: 'success', entityType: 'parcel', entityId: parcel.id, countyId: parcel.county_id, detail: { disputeId } }, client);
  });
  res.json({ ok: true });
});
