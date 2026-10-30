import type { Db } from '../db.js';

export const REQUESTABLE_DOCUMENT_TYPES = ['deed', 'survey_plan', 'customary_certificate', 'power_of_attorney', 'other'] as const;

/**
 * The verified, linked party through which this account currently holds a registered interest
 * in the parcel, or null. Checked when a request is made and again at every download, so access
 * ends when the interest ends.
 */
export async function eligibleParty(db: Db, userId: string, parcelId: string): Promise<{ id: string; name: string } | null> {
  const { rows: [party] } = await db.query(
    `SELECT pa.id, pa.name
       FROM lais.user_party_link l
       JOIN lais.party pa ON pa.id = l.party_id AND pa.identity_status = 'verified'
       JOIN lais.rrr r ON r.party_id = pa.id AND r.parcel_id = $2 AND r.valid_to IS NULL AND r.interest_status = 'registered'
       JOIN lais.parcel p ON p.id = r.parcel_id AND p.status <> 'retired'
      WHERE l.user_id = $1 AND l.revoked_at IS NULL
      ORDER BY pa.name LIMIT 1`,
    [userId, parcelId],
  );
  return party ?? null;
}

/**
 * Documents that may be considered for release on a parcel: verified documents from published cases
 * that registered, transferred or created the parcel. Highly sensitive documents are listed for the
 * officer's information but are never releasable.
 */
export async function candidateDocuments(db: Db, parcelId: string) {
  const { rows } = await db.query(
    `SELECT d.id, d.doc_type, d.reference_no, d.issuer, d.issued_on, d.classification, d.original_name, d.size_bytes,
            c.case_no, c.case_type, (d.classification <> 'highly_sensitive') AS releasable
       FROM lais.document d
       JOIN lais.land_case c ON c.id = d.case_id
      WHERE c.status = 'published' AND d.verification_status = 'verified' AND d.review_status <> 'superseded'
        AND (c.parcel_id = $1 OR c.id IN (SELECT case_id FROM lais.parcel_lineage WHERE child_parcel_id = $1))
      ORDER BY c.updated_at DESC, d.doc_type`,
    [parcelId],
  );
  return rows;
}
