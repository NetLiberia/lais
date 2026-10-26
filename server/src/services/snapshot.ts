import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { CaseRow } from './cases.js';

/**
 * Fingerprint of exactly what a decision-maker reviewed: case attributes, the staged geometry,
 * proposed rights, documents (by content hash and verification state) and, for transfers, the
 * parcel's current state. Stored with each decision and re-checked at publication, so nothing
 * can change between approval and publication without the approval becoming invalid.
 */
export async function computeSnapshot(db: Db, cs: CaseRow): Promise<string> {
  const geometry = await db.query(
    `SELECT f.id, encode(sha256(ST_AsEWKB(f.geom_input)), 'hex') AS geom_hash
       FROM staging.batch b JOIN staging.feature f ON f.batch_id = b.id
      WHERE b.case_id = $1 AND b.status = 'active' ORDER BY f.feature_index`,
    [cs.id],
  );
  const rights = await db.query(
    `SELECT id, party_id, rrr_type, share_num, share_den FROM lais.case_right_proposal WHERE case_id = $1 ORDER BY id`,
    [cs.id],
  );
  const documents = await db.query(
    `SELECT id, doc_type, classification, sha256, verification_status FROM lais.document WHERE case_id = $1 ORDER BY id`,
    [cs.id],
  );
  let parcelState: unknown = null;
  if (cs.parcel_id) {
    const parcel = await db.query('SELECT current_version_id, status FROM lais.parcel WHERE id = $1', [cs.parcel_id]);
    const current = await db.query(
      'SELECT id FROM lais.rrr WHERE parcel_id = $1 AND valid_to IS NULL ORDER BY id',
      [cs.parcel_id],
    );
    parcelState = { parcel: parcel.rows[0] ?? null, currentRights: current.rows.map((r) => r.id) };
  }

  const material = {
    case: {
      id: cs.id,
      type: cs.case_type,
      county: cs.county_id,
      parcel: cs.parcel_id,
      upi: cs.proposed_upi,
      category: cs.land_category,
      use: cs.land_use,
      source: cs.source_reference,
    },
    geometry: geometry.rows,
    rights: rights.rows,
    documents: documents.rows,
    parcelState,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
