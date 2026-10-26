import { config, METRIC_SRID, NATIONAL_EXTENT } from '../config.js';
import type { Db } from '../db.js';
import { OPEN_STATUSES } from '../authz/workflow.js';
import type { CaseRow } from './cases.js';
import { OWNERSHIP_TYPES, sharesSumToWhole } from './shares.js';

/**
 * Validation and spatial conflict detection.
 *
 * Errors block submission and approval and must be corrected.
 * Warnings are investigation signals (for example an overlap with a published parcel):
 * they do not decide anything, but an authorized registrar must acknowledge each one
 * with a note before approving. Tolerances come from config and are placeholders until
 * the cadastral authority defines official rules.
 */
export interface Finding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  relatedParcelId?: string | null;
  relatedCaseId?: string | null;
  detail?: Record<string, unknown>;
}

export const PROVISIONAL_UPI_PATTERN = /^PROV-[A-Z]{2}-\d{6}$/;

export interface Evaluation {
  findings: Finding[];
  batchId: string | null;
}

export async function evaluateCase(db: Db, cs: CaseRow): Promise<Evaluation> {
  const findings: Finding[] = [];
  let batchId: string | null = null;
  let landCategory = cs.land_category;

  if (cs.case_type === 'first_registration') {
    batchId = await registrationChecks(db, cs, findings);
  } else {
    landCategory = await transferChecks(db, cs, findings);
  }
  await rightsChecks(db, cs, landCategory, findings);
  await documentChecks(db, cs, findings);
  return { findings, batchId };
}

const err = (code: string, message: string, extra: Partial<Finding> = {}): Finding => ({ code, severity: 'error', message, ...extra });
const warn = (code: string, message: string, extra: Partial<Finding> = {}): Finding => ({ code, severity: 'warning', message, ...extra });

async function registrationChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  if (!cs.land_category) out.push(err('LAND_CATEGORY_MISSING', 'A land category (public, government, customary or private) is required'));
  if (!cs.source_reference?.trim()) out.push(err('SOURCE_REFERENCE_MISSING', 'A survey or source record reference is required'));

  if (cs.proposed_upi) {
    if (!PROVISIONAL_UPI_PATTERN.test(cs.proposed_upi)) {
      out.push(err('UPI_FORMAT_INVALID', 'Proposed identifier must follow the provisional pattern PROV-XX-000000'));
    }
    const dup = await db.query('SELECT id FROM lais.parcel WHERE upi = $1', [cs.proposed_upi]);
    if (dup.rows[0]) out.push(err('DUPLICATE_UPI', `Identifier ${cs.proposed_upi} is already used by a published parcel`, { relatedParcelId: dup.rows[0].id }));
    const open = await db.query(
      `SELECT id, case_no FROM lais.land_case WHERE proposed_upi = $1 AND id <> $2 AND status = ANY($3)`,
      [cs.proposed_upi, cs.id, OPEN_STATUSES],
    );
    for (const r of open.rows) {
      out.push(warn('UPI_IN_OTHER_OPEN_CASE', `Identifier ${cs.proposed_upi} is also proposed in open case ${r.case_no}`, { relatedCaseId: r.id }));
    }
  }

  const { rows: features } = await db.query(
    `SELECT f.id, f.structural_ok, f.structural_message, b.id AS batch_id
       FROM staging.batch b JOIN staging.feature f ON f.batch_id = b.id
      WHERE b.case_id = $1 AND b.status = 'active'`,
    [cs.id],
  );
  if (features.length === 0) {
    out.push(err('NO_GEOMETRY', 'No parcel geometry has been imported for this case'));
    return null;
  }
  const feature = features[0];
  if (!feature.structural_ok) {
    out.push(err('GEOMETRY_INVALID', `The imported geometry is invalid: ${feature.structural_message}. Correct it in the GIS tool and re-import; the system does not repair geometries.`));
    return feature.batch_id;
  }

  const { rows: [g] } = await db.query(
    `SELECT ST_X(ST_Centroid(f.geom)) AS cx, ST_Y(ST_Centroid(f.geom)) AS cy,
            ST_Area(f.geom::geography) AS area_m2,
            ST_Within(f.geom, ST_MakeEnvelope($3, $4, $5, $6, 4326)) AS in_national_extent,
            ST_CoveredBy(f.geom, c.geom) AS in_county,
            ST_Intersects(f.geom, c.geom) AS touches_county
       FROM staging.feature f, lais.county c
      WHERE f.id = $1 AND c.id = $2`,
    [feature.id, cs.county_id, NATIONAL_EXTENT.minLon, NATIONAL_EXTENT.minLat, NATIONAL_EXTENT.maxLon, NATIONAL_EXTENT.maxLat],
  );

  const swapped = g.cx >= NATIONAL_EXTENT.minLat && g.cx <= NATIONAL_EXTENT.maxLat && g.cy <= NATIONAL_EXTENT.maxLon && g.cy >= NATIONAL_EXTENT.minLon;
  if (swapped) {
    out.push(err('AXIS_ORDER_SWAPPED_SUSPECTED', 'Coordinates look like latitude/longitude instead of longitude/latitude. GeoJSON requires [longitude, latitude].', { detail: { centroid: [g.cx, g.cy] } }));
    return feature.batch_id;
  }
  if (!g.in_national_extent) {
    out.push(err('OUTSIDE_NATIONAL_EXTENT', 'The geometry falls outside Liberia. Check that the declared coordinate reference system is correct.', { detail: { centroid: [g.cx, g.cy] } }));
    return feature.batch_id;
  }
  if (!g.in_county) {
    out.push(g.touches_county
      ? err('CROSSES_COUNTY_BOUNDARY', 'The parcel crosses the boundary of the case county')
      : err('OUTSIDE_CASE_COUNTY', 'The parcel lies outside the county this case belongs to'));
  }
  if (g.area_m2 < config.minParcelAreaM2) {
    out.push(warn('AREA_UNUSUALLY_SMALL', `Calculated area is ${Number(g.area_m2).toFixed(2)} m², below the ${config.minParcelAreaM2} m² review threshold`));
  }

  // Published parcels that the new geometry intersects. Touching boundaries (zero-area intersection) are not conflicts.
  // The metric SRID is a server constant, written inline: some PostGIS builds mishandle a bound SRID parameter in ST_Transform.
  const { rows: published } = await db.query(
    `SELECT p.id, p.upi,
            ST_Area(ST_Intersection(v.geom, f.geom)::geography) AS overlap_m2,
            ST_HausdorffDistance(ST_Transform(v.geom, ${METRIC_SRID}), ST_Transform(f.geom, ${METRIC_SRID})) AS hausdorff_m
       FROM staging.feature f
       JOIN lais.parcel_version v ON v.valid_to IS NULL AND ST_Intersects(v.geom, f.geom)
       JOIN lais.parcel p ON p.id = v.parcel_id
      WHERE f.id = $1`,
    [feature.id],
  );
  for (const p of published) {
    if (p.hausdorff_m <= config.duplicateHausdorffM) {
      out.push(warn('DUPLICATE_GEOMETRY_SUSPECTED', `The geometry is nearly identical to published parcel ${p.upi} (max deviation ${Number(p.hausdorff_m).toFixed(2)} m). This may be a duplicate registration.`, {
        relatedParcelId: p.id, detail: { upi: p.upi, hausdorff_m: Number(p.hausdorff_m) },
      }));
    } else if (p.overlap_m2 > config.overlapToleranceM2) {
      out.push(warn('OVERLAP_PUBLISHED_PARCEL', `Overlaps published parcel ${p.upi} by ${Number(p.overlap_m2).toFixed(2)} m². Investigate before deciding; an overlap is not by itself evidence of a legal conflict.`, {
        relatedParcelId: p.id, detail: { upi: p.upi, overlap_m2: Number(p.overlap_m2) },
      }));
    }
  }

  // Other open cases proposing geometry in the same place.
  const { rows: competing } = await db.query(
    `SELECT c.id, c.case_no, ST_Area(ST_Intersection(o.geom, f.geom)::geography) AS overlap_m2
       FROM staging.feature f
       JOIN staging.feature o ON o.id <> f.id AND o.geom IS NOT NULL AND ST_Intersects(o.geom, f.geom)
       JOIN staging.batch b ON b.id = o.batch_id AND b.status = 'active'
       JOIN lais.land_case c ON c.id = b.case_id
      WHERE f.id = $1 AND c.id <> $2 AND c.status = ANY($3)`,
    [feature.id, cs.id, OPEN_STATUSES],
  );
  for (const c of competing) {
    if (c.overlap_m2 > config.overlapToleranceM2) {
      out.push(warn('CONFLICTING_OPEN_SUBMISSION', `Overlaps the geometry proposed in open case ${c.case_no} by ${Number(c.overlap_m2).toFixed(2)} m²`, {
        relatedCaseId: c.id, detail: { caseNo: c.case_no, overlap_m2: Number(c.overlap_m2) },
      }));
    }
  }
  return feature.batch_id;
}

/** Returns the parcel's current land category, for category/right consistency checks. */
async function transferChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  const { rows: [parcel] } = await db.query(
    `SELECT p.id, p.upi, p.status, p.county_id, v.land_category
       FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
      WHERE p.id = $1`,
    [cs.parcel_id],
  );
  if (!parcel) {
    out.push(err('PARCEL_NOT_FOUND', 'The parcel for this transfer has no published version'));
    return null;
  }
  if (parcel.county_id !== cs.county_id) out.push(err('PARCEL_COUNTY_MISMATCH', 'The parcel is not in the case county'));
  if (parcel.status === 'disputed') out.push(err('PARCEL_DISPUTED', `Parcel ${parcel.upi} has an open dispute; transfers are blocked until it is resolved through the authorized process`, { relatedParcelId: parcel.id }));
  if (parcel.status === 'retired') out.push(err('PARCEL_RETIRED', `Parcel ${parcel.upi} is retired`, { relatedParcelId: parcel.id }));

  const { rows: encumbrances } = await db.query(
    `SELECT rrr_type, count(*)::int AS n FROM lais.rrr
      WHERE parcel_id = $1 AND valid_to IS NULL AND rrr_type IN ('mortgage', 'lease', 'easement')
      GROUP BY rrr_type`,
    [parcel.id],
  );
  for (const e of encumbrances) {
    out.push(warn('ENCUMBRANCE_PRESENT', `The parcel has ${e.n} current ${e.rrr_type} record(s), which will carry forward unless separately discharged`, { relatedParcelId: parcel.id, detail: { rrrType: e.rrr_type } }));
  }
  if (parcel.land_category === 'customary') {
    out.push(warn('CUSTOMARY_LAND_TRANSFER', 'This is customary land. Confirm the applicable customary-land procedure and community consent have been followed.', { relatedParcelId: parcel.id }));
  }
  return parcel.land_category;
}

async function rightsChecks(db: Db, cs: CaseRow, landCategory: string | null, out: Finding[]): Promise<void> {
  const { rows } = await db.query(
    `SELECT r.id, r.rrr_type, r.share_num, r.share_den, p.id AS party_id, p.name, p.party_type, p.identity_status
       FROM lais.case_right_proposal r JOIN lais.party p ON p.id = r.party_id
      WHERE r.case_id = $1 ORDER BY r.created_at`,
    [cs.id],
  );
  if (rows.length === 0) {
    out.push(err('NO_PROPOSED_RIGHTS', cs.case_type === 'transfer'
      ? 'Record the incoming rights holder(s) for this transfer'
      : 'Record at least one rights holder for this parcel'));
    return;
  }

  const ownership = rows.filter((r) => (OWNERSHIP_TYPES as readonly string[]).includes(r.rrr_type));
  if (ownership.length === 0) {
    out.push(err('NO_OWNERSHIP_INTEREST', 'At least one ownership, co-ownership or customary tenure interest is required'));
  } else {
    const kinds = new Set(ownership.map((r) => r.rrr_type));
    if (kinds.size > 1) {
      out.push(err('MIXED_OWNERSHIP_TYPES', `Do not mix ${[...kinds].join(', ')} interests on one parcel`));
    } else if (kinds.has('ownership') && ownership.length > 1) {
      out.push(err('MULTIPLE_SOLE_OWNERS', 'More than one sole ownership interest; use co-ownership with shares instead'));
    } else if (kinds.has('co_ownership') && ownership.some((r) => r.share_den === null)) {
      out.push(err('SHARE_MISSING', 'Every co-ownership interest needs a share'));
    } else {
      const shares = ownership.map((r) => ({ num: r.share_num ?? 1, den: r.share_den ?? 1 }));
      if (!sharesSumToWhole(shares)) {
        out.push(err('SHARES_DO_NOT_SUM', 'Ownership shares must add up to exactly one whole parcel', { detail: { shares: shares.map((s) => `${s.num}/${s.den}`) } }));
      }
    }
    const partyIds = ownership.map((r) => r.party_id);
    if (new Set(partyIds).size !== partyIds.length) out.push(err('DUPLICATE_RIGHTS_HOLDER', 'The same party appears twice as a holder of the ownership interest'));
  }

  for (const r of rows) {
    if (r.identity_status !== 'verified') {
      out.push(err('PARTY_IDENTITY_UNVERIFIED', `The identity of ${r.name} has not been verified by an authorized officer`));
    }
  }

  if (landCategory === 'customary' && !rows.some((r) => r.rrr_type === 'customary_tenure' && r.party_type === 'community')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', 'Customary land is usually held by a community under customary tenure; check the recorded interest'));
  }
  if (landCategory !== 'customary' && rows.some((r) => r.rrr_type === 'customary_tenure')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', 'Customary tenure is recorded on land that is not categorised as customary'));
  }
  if ((landCategory === 'government' || landCategory === 'public') && !ownership.some((r) => r.party_type === 'government')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', `${landCategory} land would normally be held by a government entity; check the recorded interest`));
  }
}

async function documentChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<void> {
  const { rows: docs } = await db.query(
    `SELECT id, doc_type, reference_no, verification_status FROM lais.document WHERE case_id = $1`,
    [cs.id],
  );
  for (const d of docs) {
    const label = `${d.doc_type.replace('_', ' ')} ${d.reference_no ?? ''}`.trim();
    if (d.verification_status === 'pending') out.push(err('DOCUMENT_PENDING_VERIFICATION', `Document "${label}" has not been checked by a processor`));
    if (d.verification_status === 'rejected') out.push(warn('DOCUMENT_REJECTED', `Document "${label}" was rejected during verification`));
  }
  const verified = (type: string) => docs.some((d) => d.doc_type === type && d.verification_status === 'verified');

  if (cs.case_type === 'first_registration') {
    if (!verified('survey_plan')) out.push(err('MISSING_SURVEY_PLAN', 'A verified survey plan is required'));
    if (!['deed', 'customary_certificate', 'other'].some(verified)) {
      out.push(err('MISSING_EVIDENCE_OF_INTEREST', 'Verified evidence of the interest (deed, customary land certificate or other legally recognised evidence) is required'));
    }
  } else if (!verified('deed')) {
    out.push(err('MISSING_TRANSFER_DEED', 'A verified transfer deed is required'));
  }
}

/** Stores a validation run and its findings; returns the run id. */
export async function persistRun(
  db: Db,
  cs: CaseRow,
  evaluation: Evaluation,
  actorId: string | null,
  purpose: 'preview' | 'submission' | 'publication',
): Promise<string> {
  const errors = evaluation.findings.filter((f) => f.severity === 'error').length;
  const { rows: [run] } = await db.query(
    `INSERT INTO staging.validation_run (case_id, batch_id, run_by, purpose, error_count, warning_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [cs.id, evaluation.batchId, actorId, purpose, errors, evaluation.findings.length - errors],
  );
  for (const f of evaluation.findings) {
    await db.query(
      `INSERT INTO staging.finding (run_id, code, severity, message, related_parcel_id, related_case_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [run.id, f.code, f.severity, f.message, f.relatedParcelId ?? null, f.relatedCaseId ?? null, JSON.stringify(f.detail ?? {})],
    );
  }
  return run.id;
}

export async function latestRun(db: Db, caseId: string) {
  const { rows: [run] } = await db.query(
    `SELECT * FROM staging.validation_run WHERE case_id = $1 ORDER BY run_at DESC LIMIT 1`,
    [caseId],
  );
  if (!run) return null;
  const { rows: findings } = await db.query(
    `SELECT f.*, u.username AS acknowledged_by_username
       FROM staging.finding f LEFT JOIN lais.app_user u ON u.id = f.acknowledged_by
      WHERE f.run_id = $1 ORDER BY f.severity, f.code`,
    [run.id],
  );
  return { run, findings };
}

/** Key used to match a fresh finding against one acknowledged earlier. */
export const findingKey = (f: { code: string; relatedParcelId?: string | null; relatedCaseId?: string | null }) =>
  `${f.code}|${f.relatedParcelId ?? ''}|${f.relatedCaseId ?? ''}`;
