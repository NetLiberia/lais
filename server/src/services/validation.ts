import { config, METRIC_SRID, NATIONAL_EXTENT } from '../config.js';
import type { Db } from '../db.js';
import { OPEN_STATUSES } from '../authz/workflow.js';
import type { CaseRow } from './cases.js';
import { OWNERSHIP_TYPES, sharesSumToWhole } from './shares.js';
import { parseLegacyProperties } from './legacy.js';

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
  /** For multi-feature batches: which imported feature (0-based) the finding is about. */
  featureIndex?: number | null;
  detail?: Record<string, unknown>;
}

export const PROVISIONAL_UPI_PATTERN = /^PROV-[A-Z]{2}-\d{6}$/;

export interface Evaluation {
  findings: Finding[];
  batchId: string | null;
  /** The rule-set version whose severities were applied, and the county boundary's status at the time. */
  ruleSetVersion?: number | null;
  boundaryStatus?: string | null;
}

export async function evaluateCase(db: Db, cs: CaseRow): Promise<Evaluation> {
  const findings: Finding[] = [];
  let batchId: string | null = null;
  let landCategory = cs.land_category;

  if (cs.case_type === 'first_registration') {
    batchId = await registrationChecks(db, cs, findings);
  } else if (cs.case_type === 'transfer') {
    landCategory = await transferChecks(db, cs, findings);
  } else if (cs.case_type === 'confirmation') {
    landCategory = await confirmationChecks(db, cs, findings);
  } else if (cs.case_type === 'correction') {
    batchId = await correctionChecks(db, cs, findings);
  } else if (cs.case_type === 'migration') {
    batchId = await migrationChecks(db, cs, findings);
  } else {
    batchId = await reshapeChecks(db, cs, findings);
  }
  // A correction never changes rights, and a migration records legacy holders as documented interests.
  if (cs.case_type !== 'correction' && cs.case_type !== 'migration') await rightsChecks(db, cs, landCategory, findings);
  await documentChecks(db, cs, findings, batchId !== null);
  if (batchId) await sourceIdChecks(db, cs, findings);
  return applyRuleSet(db, cs, { findings, batchId });
}

/** Two features carrying the same source identifier usually means a duplicated record in the source data. */
async function sourceIdChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<void> {
  const features = await stagedFeatures(db, cs.id);
  const byId = new Map<string, number[]>();
  for (const f of features) {
    const v = f.properties?.source_id;
    if (v === undefined || v === null || v === '') continue;
    byId.set(String(v), [...(byId.get(String(v)) ?? []), f.feature_index]);
  }
  for (const [id, idx] of byId) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      out.push(warn('DUPLICATE_SOURCE_ID', `Feature ${i + 1}: source_id "${id.slice(0, 60)}" is also used by feature(s) ${idx.filter((x) => x !== i).map((x) => x + 1).join(', ')}`, { featureIndex: i }));
    }
  }
}

/**
 * Applies the administrator-configured severities. Only rules marked configurable can differ from their
 * default (a database CHECK), so safety rules such as invalid geometry or a wrong county always block.
 */
async function applyRuleSet(db: Db, cs: CaseRow, e: Evaluation): Promise<Evaluation> {
  const { rows: rules } = await db.query<{ code: string; severity: 'error' | 'warning' }>('SELECT code, severity FROM staging.validation_rule');
  const severity = new Map(rules.map((r) => [r.code, r.severity]));
  const { rows: [v] } = await db.query('SELECT max(version) AS version FROM staging.rule_set_version');
  const { rows: [c] } = await db.query('SELECT boundary_status FROM lais.county WHERE id = $1', [cs.county_id]);
  for (const f of e.findings) {
    const s = severity.get(f.code);
    if (s && s !== f.severity) { f.detail = { ...f.detail, defaultSeverity: f.severity }; f.severity = s; }
  }
  return { ...e, ruleSetVersion: v?.version ?? null, boundaryStatus: c?.boundary_status ?? null };
}

/**
 * Correction of a published parcel's boundary and/or attributes. The result is a new version; the
 * erroneous version stays in the history. Large boundary changes are flagged, because a "correction"
 * that moves a boundary substantially may really be a transfer of land between neighbours.
 */
async function correctionChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  if (!cs.correction_reason || cs.correction_reason.trim().length < 10) {
    out.push(err('CORRECTION_REASON_MISSING', 'Describe the error being corrected and how it was established (10+ characters)'));
  }
  const { rows: [current] } = await db.query(
    `SELECT p.id, p.upi, p.status, p.county_id, v.land_category, v.land_use, v.source_reference, v.area_m2_surveyed, v.area_m2_calculated
       FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id AND v.valid_to IS NULL
      WHERE p.id = $1`,
    [cs.parcel_id],
  );
  if (!current) {
    out.push(err('PARCEL_NOT_FOUND', 'The parcel to correct has no current published version'));
    return null;
  }
  parcelStateChecks(current, cs, 'correction', out);
  await competingCaseWarnings(db, cs, [current.id], out);

  const features = await stagedFeatures(db, cs.id);
  const batchId = features[0]?.batch_id ?? null;
  let boundaryChanged = false;
  if (features.length > 0 && (await geometryChecks(db, cs, features, [current.id], out))) {
    const { rows: [diff] } = await db.query(
      `SELECT ST_HausdorffDistance(ST_Transform(v.geom, ${METRIC_SRID}), ST_Transform(f.geom, ${METRIC_SRID})) AS moved_m,
              ST_Area(f.geom::geography) AS new_area_m2, ST_Area(v.geom::geography) AS old_area_m2,
              ST_Equals(v.geom, f.geom) AS same
         FROM staging.feature f, lais.parcel_version v
        WHERE f.id = $1 AND v.id = (SELECT current_version_id FROM lais.parcel WHERE id = $2)`,
      [features[0].id, current.id],
    );
    boundaryChanged = !diff.same;
    const areaChangePct = Math.abs(diff.new_area_m2 - diff.old_area_m2) / diff.old_area_m2 * 100;
    if (diff.moved_m > config.significantBoundaryChangeM || areaChangePct > config.significantAreaChangePct) {
      out.push(warn('SIGNIFICANT_BOUNDARY_CHANGE',
        `The corrected boundary moves up to ${Number(diff.moved_m).toFixed(1)} m and changes the calculated area by ${areaChangePct.toFixed(1)}%. ` +
        'Confirm this is a correction of an error and not a change of the land held, which would need its own transaction.',
        { relatedParcelId: current.id, detail: { moved_m: Number(diff.moved_m), areaChangePct } }));
    }
  } else if (features.length > 0) {
    boundaryChanged = true; // invalid geometry; the error above blocks the case
  }

  const attributeChanged =
    (cs.land_category ?? null) !== (current.land_category ?? null) ||
    (cs.land_use ?? null) !== (current.land_use ?? null) ||
    (cs.source_reference ?? null) !== (current.source_reference ?? null) ||
    (cs.area_m2_surveyed === null ? null : Number(cs.area_m2_surveyed)) !== (current.area_m2_surveyed === null ? null : Number(current.area_m2_surveyed));
  if (!boundaryChanged && !attributeChanged) {
    out.push(err('NO_CHANGE', 'The correction does not change anything in the published record'));
  }
  if (!cs.land_category) out.push(err('LAND_CATEGORY_MISSING', 'The corrected record needs a land category'));
  if (!cs.source_reference?.trim()) out.push(err('SOURCE_REFERENCE_MISSING', 'A survey or source record reference is required'));
  if (cs.land_category && cs.land_category !== current.land_category) {
    out.push(warn('CATEGORY_CHANGE', `The land category changes from ${current.land_category} to ${cs.land_category}; a category change needs its own legal basis`, { relatedParcelId: current.id }));
  }
  return batchId;
}

const err = (code: string, message: string, extra: Partial<Finding> = {}): Finding => ({ code, severity: 'error', message, ...extra });
const warn = (code: string, message: string, extra: Partial<Finding> = {}): Finding => ({ code, severity: 'warning', message, ...extra });

interface StagedFeature {
  id: string;
  feature_index: number;
  structural_ok: boolean;
  structural_message: string | null;
  batch_id: string;
  properties: Record<string, unknown>;
}

/** The active batch's features, leaving out any a GIS officer has quarantined. */
async function stagedFeatures(db: Db, caseId: string): Promise<StagedFeature[]> {
  const { rows } = await db.query<StagedFeature>(
    `SELECT f.id, f.feature_index, f.structural_ok, f.structural_message, b.id AS batch_id, f.properties
       FROM staging.batch b JOIN staging.feature f ON f.batch_id = b.id
      WHERE b.case_id = $1 AND b.status = 'active' AND NOT f.excluded
      ORDER BY f.feature_index`,
    [caseId],
  );
  return rows;
}

/** Prefix naming the staged feature in messages; empty when the case creates a single parcel. */
const featureLabel = (f: StagedFeature, many: boolean) => (many ? `New parcel ${f.feature_index + 1}: ` : '');

/**
 * Checks one valid staged feature: plausible location, inside the case county, and conflicts with
 * published parcels (other than the parcels this case replaces) and with other open submissions.
 */
async function featureChecks(db: Db, cs: CaseRow, f: StagedFeature, label: string, replacedParcelIds: string[], out: Finding[]): Promise<void> {
  const { rows: [g] } = await db.query(
    `SELECT ST_X(ST_Centroid(f.geom)) AS cx, ST_Y(ST_Centroid(f.geom)) AS cy,
            ST_Area(f.geom::geography) AS area_m2, ST_NumGeometries(f.geom) AS parts,
            ST_Within(f.geom, ST_MakeEnvelope($3, $4, $5, $6, 4326)) AS in_national_extent,
            ST_CoveredBy(f.geom, c.geom) AS in_county,
            ST_Intersects(f.geom, c.geom) AS touches_county
       FROM staging.feature f, lais.county c
      WHERE f.id = $1 AND c.id = $2`,
    [f.id, cs.county_id, NATIONAL_EXTENT.minLon, NATIONAL_EXTENT.minLat, NATIONAL_EXTENT.maxLon, NATIONAL_EXTENT.maxLat],
  );

  const swapped = g.cx >= NATIONAL_EXTENT.minLat && g.cx <= NATIONAL_EXTENT.maxLat && g.cy <= NATIONAL_EXTENT.maxLon && g.cy >= NATIONAL_EXTENT.minLon;
  if (swapped) {
    out.push(err('AXIS_ORDER_SWAPPED_SUSPECTED', `${label}Coordinates look like latitude/longitude instead of longitude/latitude. GeoJSON requires [longitude, latitude].`, { detail: { centroid: [g.cx, g.cy] } }));
    return;
  }
  if (!g.in_national_extent) {
    out.push(err('OUTSIDE_NATIONAL_EXTENT', `${label}The geometry falls outside Liberia. Check that the declared coordinate reference system is correct.`, { detail: { centroid: [g.cx, g.cy] } }));
    return;
  }
  if (!g.in_county) {
    out.push(g.touches_county
      ? err('CROSSES_COUNTY_BOUNDARY', `${label}The parcel crosses the boundary of the case county`)
      : err('OUTSIDE_CASE_COUNTY', `${label}The parcel lies outside the county this case belongs to`));
  }
  if (g.area_m2 < config.minParcelAreaM2) {
    out.push(warn('AREA_UNUSUALLY_SMALL', `${label}Calculated area is ${Number(g.area_m2).toFixed(2)} m², below the ${config.minParcelAreaM2} m² review threshold`));
  }
  if (g.area_m2 > config.maxParcelAreaM2) {
    out.push(warn('AREA_UNUSUALLY_LARGE', `${label}Calculated area is ${(Number(g.area_m2) / 10_000).toFixed(1)} ha, above the ${(config.maxParcelAreaM2 / 10_000).toFixed(0)} ha review threshold`));
  }
  if (g.parts > 1) {
    out.push(warn('MULTIPART_GEOMETRY', `${label}The parcel consists of ${g.parts} separate parts`, { detail: { parts: Number(g.parts) } }));
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
      WHERE f.id = $1 AND NOT (p.id = ANY($2::uuid[]))`,
    [f.id, replacedParcelIds],
  );
  for (const p of published) {
    if (p.hausdorff_m <= config.duplicateHausdorffM) {
      out.push(warn('DUPLICATE_GEOMETRY_SUSPECTED', `${label}The geometry is nearly identical to published parcel ${p.upi} (max deviation ${Number(p.hausdorff_m).toFixed(2)} m). This may be a duplicate registration.`, {
        relatedParcelId: p.id, detail: { upi: p.upi, hausdorff_m: Number(p.hausdorff_m) },
      }));
    } else if (p.overlap_m2 > config.overlapToleranceM2) {
      out.push(warn('OVERLAP_PUBLISHED_PARCEL', `${label}Overlaps published parcel ${p.upi} by ${Number(p.overlap_m2).toFixed(2)} m². Investigate before deciding; an overlap is not by itself evidence of a legal conflict.`, {
        relatedParcelId: p.id, detail: { upi: p.upi, overlap_m2: Number(p.overlap_m2) },
      }));
    }
  }

  // Other open cases proposing geometry in the same place.
  const { rows: competing } = await db.query(
    `SELECT c.id, c.case_no, ST_Area(ST_Intersection(o.geom, f.geom)::geography) AS overlap_m2
       FROM staging.feature f
       JOIN staging.feature o ON o.batch_id <> f.batch_id AND o.geom IS NOT NULL AND ST_Intersects(o.geom, f.geom)
       JOIN staging.batch b ON b.id = o.batch_id AND b.status = 'active'
       JOIN lais.land_case c ON c.id = b.case_id
      WHERE f.id = $1 AND c.id <> $2 AND c.status = ANY($3)`,
    [f.id, cs.id, OPEN_STATUSES],
  );
  const seen = new Set<string>();
  for (const c of competing) {
    if (c.overlap_m2 > config.overlapToleranceM2 && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(warn('CONFLICTING_OPEN_SUBMISSION', `${label}Overlaps the geometry proposed in open case ${c.case_no} by ${Number(c.overlap_m2).toFixed(2)} m²`, {
        relatedCaseId: c.id, detail: { caseNo: c.case_no, overlap_m2: Number(c.overlap_m2) },
      }));
    }
  }
}

/** Structural and location checks on every imported feature. Returns whether all are structurally valid. */
async function geometryChecks(db: Db, cs: CaseRow, features: StagedFeature[], replacedParcelIds: string[], out: Finding[]): Promise<boolean> {
  const many = features.length > 1;
  let allValid = true;
  for (const f of features) {
    const before = out.length;
    if (!f.structural_ok) {
      allValid = false;
      out.push(err('GEOMETRY_INVALID', `${featureLabel(f, many)}The imported geometry is invalid: ${f.structural_message}. Correct it in the GIS tool and re-import; the system does not repair geometries.`));
    } else {
      await featureChecks(db, cs, f, featureLabel(f, many), replacedParcelIds, out);
    }
    // Record which feature each finding is about, for record-level review.
    for (const finding of out.slice(before)) finding.featureIndex = f.feature_index;
  }
  return allValid;
}

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

  const features = await stagedFeatures(db, cs.id);
  if (features.length === 0) {
    out.push(err('NO_GEOMETRY', 'No parcel geometry has been imported for this case'));
    return null;
  }
  await geometryChecks(db, cs, features, [], out);
  return features[0].batch_id;
}

/** The published parcels a subdivision or consolidation replaces. */
export async function sourceParcels(db: Db, caseId: string) {
  const { rows } = await db.query(
    `SELECT p.id, p.upi, p.status, p.county_id, v.land_category
       FROM lais.parcel p
       LEFT JOIN lais.parcel_version v ON v.id = p.current_version_id AND v.valid_to IS NULL
      WHERE p.id IN (SELECT parcel_id FROM lais.case_source_parcel WHERE case_id = $1)
      ORDER BY p.upi`,
    [caseId],
  );
  return rows;
}

/** Checks that a parcel the case depends on is still in a state where the case can proceed. */
function parcelStateChecks(parcel: { id: string; upi: string; status: string; county_id: number }, cs: CaseRow, what: string, out: Finding[]): void {
  if (parcel.county_id !== cs.county_id) out.push(err('PARCEL_COUNTY_MISMATCH', `Parcel ${parcel.upi} is not in the case county`, { relatedParcelId: parcel.id }));
  if (parcel.status === 'disputed') out.push(err('PARCEL_DISPUTED', `Parcel ${parcel.upi} has an open dispute; ${what} is blocked until it is resolved through the authorized process`, { relatedParcelId: parcel.id }));
  if (parcel.status === 'retired') out.push(err('PARCEL_RETIRED', `Parcel ${parcel.upi} is retired`, { relatedParcelId: parcel.id }));
}

async function encumbranceWarnings(db: Db, parcelIds: string[], carriesForward: boolean, out: Finding[]): Promise<void> {
  const { rows } = await db.query(
    `SELECT r.parcel_id, p.upi, r.rrr_type, count(*)::int AS n
       FROM lais.rrr r JOIN lais.parcel p ON p.id = r.parcel_id
      WHERE r.parcel_id = ANY($1::uuid[]) AND r.valid_to IS NULL AND r.rrr_type IN ('mortgage', 'lease', 'easement')
      GROUP BY r.parcel_id, p.upi, r.rrr_type`,
    [parcelIds],
  );
  for (const e of rows) {
    out.push(warn('ENCUMBRANCE_PRESENT', carriesForward
      ? `The parcel has ${e.n} current ${e.rrr_type} record(s), which will carry forward unless separately discharged`
      : `Parcel ${e.upi} has ${e.n} current ${e.rrr_type} record(s). They end when the parcel is retired; record them on the new parcel(s) if they continue, with the holder's consent.`,
    { relatedParcelId: e.parcel_id, detail: { rrrType: e.rrr_type, upi: e.upi } }));
  }
}

/** Other open cases acting on the same parcels. Only the first to publish can succeed. */
async function competingCaseWarnings(db: Db, cs: CaseRow, parcelIds: string[], out: Finding[]): Promise<void> {
  const { rows } = await db.query(
    `SELECT DISTINCT c.id, c.case_no, c.case_type
       FROM lais.land_case c
       LEFT JOIN lais.case_source_parcel s ON s.case_id = c.id
      WHERE c.id <> $1 AND c.status = ANY($2)
        AND (c.parcel_id = ANY($3::uuid[]) OR s.parcel_id = ANY($3::uuid[]))`,
    [cs.id, OPEN_STATUSES, parcelIds],
  );
  for (const c of rows) {
    out.push(warn('PARCEL_IN_OTHER_OPEN_CASE', `Open case ${c.case_no} (${c.case_type.replace('_', ' ')}) also acts on this parcel; whichever is published second will be refused and reopened`, { relatedCaseId: c.id }));
  }
}

/** Lower-cased, single-spaced name for comparing a legacy record with a verified party. */
const normaliseName = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Confirmation of documented interests (for example from a legacy migration). The holders to be
 * registered must be verified parties with valid shares; names that differ from the legacy record are
 * flagged for the registrar rather than matched or rejected automatically.
 */
async function confirmationChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  const { rows: [parcel] } = await db.query(
    `SELECT p.id, p.upi, p.status, p.county_id, v.land_category
       FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id AND v.valid_to IS NULL
      WHERE p.id = $1`,
    [cs.parcel_id],
  );
  if (!parcel) {
    out.push(err('PARCEL_NOT_FOUND', 'The parcel has no current published version'));
    return null;
  }
  parcelStateChecks(parcel, cs, 'confirmation', out);
  await competingCaseWarnings(db, cs, [parcel.id], out);

  const { rows: current } = await db.query(
    `SELECT r.interest_status, pa.name FROM lais.rrr r JOIN lais.party pa ON pa.id = r.party_id
      WHERE r.parcel_id = $1 AND r.valid_to IS NULL AND r.rrr_type = ANY($2)`,
    [parcel.id, OWNERSHIP_TYPES],
  );
  if (current.some((r) => r.interest_status === 'registered')) {
    out.push(err('ALREADY_REGISTERED', `Parcel ${parcel.upi} already has a registered owner; use a transfer to change it`, { relatedParcelId: parcel.id }));
  }
  const documented = current.filter((r) => r.interest_status === 'documented' || r.interest_status === 'claimed');
  if (documented.length === 0) {
    out.push(err('NOTHING_TO_CONFIRM', `Parcel ${parcel.upi} has no documented ownership interests to confirm`, { relatedParcelId: parcel.id }));
    return parcel.land_category;
  }

  const { rows: proposed } = await db.query(
    'SELECT pa.name FROM lais.case_right_proposal r JOIN lais.party pa ON pa.id = r.party_id WHERE r.case_id = $1 AND r.rrr_type = ANY($2)',
    [cs.id, OWNERSHIP_TYPES],
  );
  const proposedNames = new Set(proposed.map((p) => normaliseName(p.name)));
  const documentedNames = new Set(documented.map((d) => normaliseName(d.name)));
  for (const d of documented) {
    if (proposed.length > 0 && !proposedNames.has(normaliseName(d.name))) {
      out.push(warn('DOCUMENTED_HOLDER_NOT_CONFIRMED', `"${d.name}" is named in the legacy record but is not among the holders to be registered`, { relatedParcelId: parcel.id, detail: { name: d.name } }));
    }
  }
  for (const p of proposed) {
    if (!documentedNames.has(normaliseName(p.name))) {
      out.push(warn('HOLDER_NOT_IN_LEGACY_RECORD', `"${p.name}" is to be registered but is not named in the legacy record`, { relatedParcelId: parcel.id, detail: { name: p.name } }));
    }
  }
  return parcel.land_category;
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
  parcelStateChecks(parcel, cs, 'a transfer', out);
  await encumbranceWarnings(db, [parcel.id], true, out);
  await competingCaseWarnings(db, cs, [parcel.id], out);
  if (parcel.land_category === 'customary') {
    out.push(warn('CUSTOMARY_LAND_TRANSFER', 'This is customary land. Confirm the applicable customary-land procedure and community consent have been followed.', { relatedParcelId: parcel.id }));
  }
  return parcel.land_category;
}

/**
 * Migration of legacy records. Each included feature must have valid legacy attributes and geometry;
 * problem features can be fixed and re-imported, or excluded (quarantined) with a reason.
 */
async function migrationChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  if (!cs.source_reference?.trim()) {
    out.push(err('SOURCE_REFERENCE_MISSING', 'Name the legacy register or dataset this batch comes from'));
  }
  const { rows: [batch] } = await db.query(`SELECT id FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  if (!batch) {
    out.push(err('NO_GEOMETRY', 'Import the legacy parcels as a GeoJSON file'));
    return null;
  }
  const features = await stagedFeatures(db, cs.id);
  if (features.length === 0) {
    out.push(err('NOTHING_TO_MIGRATE', 'Every feature in the batch has been excluded'));
    return batch.id;
  }

  const labelFor = (f: StagedFeature, ref: string | null) => `Feature ${f.feature_index + 1}${ref ? ` (${ref})` : ''}: `;
  const byRef = new Map<string, StagedFeature[]>();
  for (const f of features) {
    const record = parseLegacyProperties(f.properties);
    for (const problem of record.problems) {
      out.push(err('LEGACY_ATTRIBUTE_INVALID', `${labelFor(f, record.legacyRef)}${problem}`, { featureIndex: f.feature_index }));
    }
    if (record.legacyRef) byRef.set(record.legacyRef, [...(byRef.get(record.legacyRef) ?? []), f]);
  }
  for (const [ref, group] of byRef) {
    if (group.length < 2) continue;
    for (const f of group) {
      const others = group.filter((g) => g !== f).map((g) => g.feature_index + 1).join(', ');
      out.push(err('DUPLICATE_LEGACY_REF', `${labelFor(f, ref)}the same legacy_ref is used by feature(s) ${others}`, { featureIndex: f.feature_index }));
    }
  }
  const { rows: migrated } = await db.query(
    'SELECT legacy_ref, upi, id FROM lais.parcel WHERE county_id = $1 AND legacy_ref = ANY($2)',
    [cs.county_id, [...byRef.keys()]],
  );
  for (const m of migrated) {
    for (const f of byRef.get(m.legacy_ref) ?? []) {
      out.push(err('ALREADY_MIGRATED', `${labelFor(f, m.legacy_ref)}already migrated as ${m.upi}`, { featureIndex: f.feature_index, relatedParcelId: m.id }));
    }
  }

  for (const f of features) {
    const label = labelFor(f, parseLegacyProperties(f.properties).legacyRef);
    if (!f.structural_ok) {
      out.push(err('GEOMETRY_INVALID', `${label}The imported geometry is invalid: ${f.structural_message}. The system does not repair geometries; fix it in the GIS tool or exclude the feature.`, { featureIndex: f.feature_index }));
      continue;
    }
    const before = out.length;
    await featureChecks(db, cs, f, label, [], out);
    for (const finding of out.slice(before)) finding.featureIndex = f.feature_index;
  }

  // Legacy datasets often overlap themselves. Flag it for the registrar rather than deciding it.
  const { rows: overlaps } = await db.query(
    `SELECT a.feature_index AS a, b.feature_index AS b, ST_Area(ST_Intersection(a.geom, b.geom)::geography) AS overlap_m2
       FROM staging.feature a JOIN staging.feature b
         ON a.batch_id = b.batch_id AND a.feature_index < b.feature_index AND NOT a.excluded AND NOT b.excluded
      WHERE a.batch_id = $1 AND a.geom IS NOT NULL AND b.geom IS NOT NULL AND ST_Intersects(a.geom, b.geom)`,
    [batch.id],
  );
  for (const o of overlaps) {
    if (o.overlap_m2 > config.overlapToleranceM2) {
      out.push(warn('MIGRATION_INTERNAL_OVERLAP', `Features ${o.a + 1} and ${o.b + 1} in this batch overlap by ${Number(o.overlap_m2).toFixed(2)} m²`, {
        featureIndex: o.a, detail: { otherFeature: o.b, overlap_m2: Number(o.overlap_m2) },
      }));
    }
  }
  return batch.id;
}

/** Subdivision and consolidation: the new parcels must exactly replace the old ones. */
async function reshapeChecks(db: Db, cs: CaseRow, out: Finding[]): Promise<string | null> {
  if (!cs.land_category) out.push(err('LAND_CATEGORY_MISSING', 'A land category for the new parcel(s) is required'));
  if (!cs.source_reference?.trim()) out.push(err('SOURCE_REFERENCE_MISSING', 'A survey or source record reference is required'));

  const subdivision = cs.case_type === 'subdivision';
  const sources = await sourceParcels(db, cs.id);
  if (subdivision ? sources.length !== 1 : sources.length < 2) {
    out.push(err('SOURCE_PARCEL_COUNT', subdivision ? 'A subdivision replaces exactly one parcel' : 'A consolidation merges at least two parcels'));
  }
  for (const s of sources) parcelStateChecks(s, cs, subdivision ? 'subdivision' : 'consolidation', out);
  const sourceIds = sources.map((s) => s.id);
  const categories = new Set(sources.map((s) => s.land_category).filter(Boolean));
  if (categories.size > 1) {
    out.push(warn('MIXED_SOURCE_CATEGORIES', `The parcels being merged have different land categories (${[...categories].join(', ')}); confirm the category of the result`));
  } else if (cs.land_category && categories.size === 1 && !categories.has(cs.land_category)) {
    out.push(warn('CATEGORY_CHANGE', `The new parcel(s) are categorised ${cs.land_category} but the source was ${[...categories][0]}; a category change needs its own legal basis`));
  }
  await encumbranceWarnings(db, sourceIds, false, out);
  await competingCaseWarnings(db, cs, sourceIds, out);

  const features = await stagedFeatures(db, cs.id);
  if (features.length === 0) {
    out.push(err('NO_GEOMETRY', subdivision ? 'Import the geometries of the new parcels' : 'Import the geometry of the merged parcel'));
    return null;
  }
  if (subdivision && features.length < 2) out.push(err('FEATURE_COUNT', 'A subdivision must create at least two parcels'));
  if (!subdivision && features.length !== 1) out.push(err('FEATURE_COUNT', 'A consolidation must create exactly one parcel'));

  const allValid = await geometryChecks(db, cs, features, sourceIds, out);
  if (!allValid || sources.length === 0) return features[0].batch_id;

  // The new parcels must not overlap each other.
  const { rows: overlaps } = await db.query(
    `SELECT a.feature_index AS a, b.feature_index AS b, ST_Area(ST_Intersection(a.geom, b.geom)::geography) AS overlap_m2
       FROM staging.feature a JOIN staging.feature b ON a.batch_id = b.batch_id AND a.feature_index < b.feature_index
      WHERE a.batch_id = $1 AND ST_Intersects(a.geom, b.geom)`,
    [features[0].batch_id],
  );
  for (const o of overlaps) {
    if (o.overlap_m2 > config.overlapToleranceM2) {
      out.push(err('NEW_PARCELS_OVERLAP', `New parcels ${o.a + 1} and ${o.b + 1} overlap by ${Number(o.overlap_m2).toFixed(2)} m²`));
    }
  }

  // Together, the new parcels must cover exactly the area of the parcels they replace.
  const { rows: [cover] } = await db.query(
    `WITH src AS (SELECT ST_Union(v.geom) AS g FROM lais.parcel_version v WHERE v.parcel_id = ANY($1::uuid[]) AND v.valid_to IS NULL),
          new AS (SELECT ST_Union(f.geom) AS g FROM staging.feature f WHERE f.batch_id = $2)
     SELECT ST_Area(ST_Difference(src.g, new.g)::geography) AS uncovered_m2,
            ST_Area(ST_Difference(new.g, src.g)::geography) AS outside_m2,
            ST_NumGeometries(src.g) AS source_parts
       FROM src, new`,
    [sourceIds, features[0].batch_id],
  );
  if (cover.uncovered_m2 > config.coverageToleranceM2) {
    out.push(err('COVERAGE_GAP', `${Number(cover.uncovered_m2).toFixed(2)} m² of the original parcel area is not covered by the new parcel(s)`, { detail: { uncovered_m2: Number(cover.uncovered_m2) } }));
  }
  if (cover.outside_m2 > config.coverageToleranceM2) {
    out.push(err('COVERAGE_EXCEEDS_SOURCE', `The new parcel(s) extend ${Number(cover.outside_m2).toFixed(2)} m² beyond the original parcel area`, { detail: { outside_m2: Number(cover.outside_m2) } }));
  }
  if (!subdivision && cover.source_parts > 1) {
    out.push(warn('NON_CONTIGUOUS_CONSOLIDATION', 'The parcels being merged do not touch, so the result has separate parts'));
  }
  return features[0].batch_id;
}

interface ProposalRow {
  id: string;
  rrr_type: string;
  share_num: number | null;
  share_den: number | null;
  feature_index: number | null;
  party_id: string;
  name: string;
  party_type: string;
  identity_status: string;
}

/** Checks the set of interests proposed for one resulting parcel. */
function interestSetChecks(rows: ProposalRow[], label: string, landCategory: string | null, out: Finding[]): void {
  const ownership = rows.filter((r) => (OWNERSHIP_TYPES as readonly string[]).includes(r.rrr_type));
  if (ownership.length === 0) {
    out.push(err('NO_OWNERSHIP_INTEREST', `${label}At least one ownership, co-ownership or customary tenure interest is required`));
  } else {
    const kinds = new Set(ownership.map((r) => r.rrr_type));
    if (kinds.size > 1) {
      out.push(err('MIXED_OWNERSHIP_TYPES', `${label}Do not mix ${[...kinds].join(', ')} interests on one parcel`));
    } else if (kinds.has('ownership') && ownership.length > 1) {
      out.push(err('MULTIPLE_SOLE_OWNERS', `${label}More than one sole ownership interest; use co-ownership with shares instead`));
    } else if (kinds.has('co_ownership') && ownership.some((r) => r.share_den === null)) {
      out.push(err('SHARE_MISSING', `${label}Every co-ownership interest needs a share`));
    } else {
      const shares = ownership.map((r) => ({ num: r.share_num ?? 1, den: r.share_den ?? 1 }));
      if (!sharesSumToWhole(shares)) {
        out.push(err('SHARES_DO_NOT_SUM', `${label}Ownership shares must add up to exactly one whole parcel`, { detail: { shares: shares.map((s) => `${s.num}/${s.den}`) } }));
      }
    }
    const partyIds = ownership.map((r) => r.party_id);
    if (new Set(partyIds).size !== partyIds.length) out.push(err('DUPLICATE_RIGHTS_HOLDER', `${label}The same party appears twice as a holder of the ownership interest`));
  }

  if (landCategory === 'customary' && !rows.some((r) => r.rrr_type === 'customary_tenure' && r.party_type === 'community')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', `${label}Customary land is usually held by a community under customary tenure; check the recorded interest`));
  }
  if (landCategory !== 'customary' && rows.some((r) => r.rrr_type === 'customary_tenure')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', `${label}Customary tenure is recorded on land that is not categorised as customary`));
  }
  if ((landCategory === 'government' || landCategory === 'public') && !ownership.some((r) => r.party_type === 'government')) {
    out.push(warn('CATEGORY_RIGHT_MISMATCH', `${label}${landCategory} land would normally be held by a government entity; check the recorded interest`));
  }
}

async function rightsChecks(db: Db, cs: CaseRow, landCategory: string | null, out: Finding[]): Promise<void> {
  const { rows } = await db.query<ProposalRow>(
    `SELECT r.id, r.rrr_type, r.share_num, r.share_den, r.feature_index, p.id AS party_id, p.name, p.party_type, p.identity_status
       FROM lais.case_right_proposal r JOIN lais.party p ON p.id = r.party_id
      WHERE r.case_id = $1 ORDER BY r.created_at`,
    [cs.id],
  );
  if (rows.length === 0) {
    out.push(err('NO_PROPOSED_RIGHTS', cs.case_type === 'transfer'
      ? 'Record the incoming rights holder(s) for this transfer'
      : cs.case_type === 'confirmation'
        ? 'Record the verified holder(s) to be registered'
      : cs.case_type === 'subdivision'
        ? 'Record the rights holder(s) for each new parcel'
        : 'Record at least one rights holder for this parcel'));
    return;
  }

  for (const r of rows) {
    if (r.identity_status !== 'verified') {
      out.push(err('PARTY_IDENTITY_UNVERIFIED', `The identity of ${r.name} has not been verified by an authorized officer`));
    }
  }

  if (cs.case_type !== 'subdivision') {
    interestSetChecks(rows, '', landCategory, out);
    return;
  }

  // Subdivision: every new parcel needs its own complete set of interests.
  const features = await stagedFeatures(db, cs.id);
  for (const r of rows) {
    if (r.feature_index === null || r.feature_index >= features.length) {
      out.push(err('RIGHT_TARGET_UNKNOWN', `The ${r.rrr_type.replace('_', ' ')} interest for ${r.name} is not assigned to one of the new parcels`));
    }
  }
  for (const f of features) {
    const label = `New parcel ${f.feature_index + 1}: `;
    const forFeature = rows.filter((r) => r.feature_index === f.feature_index);
    if (forFeature.length === 0) out.push(err('NO_PROPOSED_RIGHTS', `${label}Record the rights holder(s)`));
    else interestSetChecks(forFeature, label, landCategory, out);
  }
}


async function documentChecks(db: Db, cs: CaseRow, out: Finding[], hasGeometry: boolean): Promise<void> {
  const { rows: docs } = await db.query(
    `SELECT id, doc_type, reference_no, verification_status FROM lais.document WHERE case_id = $1 AND review_status <> 'superseded'`,
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
  } else if (cs.case_type === 'transfer') {
    if (!verified('deed')) out.push(err('MISSING_TRANSFER_DEED', 'A verified transfer deed is required'));
  } else if (cs.case_type === 'confirmation') {
    if (!['deed', 'customary_certificate', 'other'].some(verified)) {
      out.push(err('MISSING_EVIDENCE_OF_INTEREST', 'Verified evidence of the interest (deed, customary land certificate or other legally recognised evidence) is required'));
    }
  } else if (cs.case_type === 'migration') {
    if (!docs.some((d) => d.verification_status === 'verified')) {
      out.push(err('MISSING_MIGRATION_SOURCE', 'Attach and verify the source of the batch (register extract, dataset description or migration authorization)'));
    }
  } else if (cs.case_type === 'correction') {
    if (hasGeometry && !verified('survey_plan')) {
      out.push(err('MISSING_SURVEY_PLAN', 'A boundary correction needs a verified survey plan'));
    } else if (!docs.some((d) => d.verification_status === 'verified')) {
      out.push(err('MISSING_CORRECTION_EVIDENCE', 'Verified evidence of the error is required'));
    }
  } else if (!verified('survey_plan')) {
    out.push(err('MISSING_SURVEY_PLAN', `A verified survey plan for the ${cs.case_type} is required`));
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
    `INSERT INTO staging.validation_run (case_id, batch_id, run_by, purpose, error_count, warning_count, rule_set_version, boundary_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [cs.id, evaluation.batchId, actorId, purpose, errors, evaluation.findings.length - errors, evaluation.ruleSetVersion ?? null, evaluation.boundaryStatus ?? null],
  );
  for (const f of evaluation.findings) {
    await db.query(
      `INSERT INTO staging.finding (run_id, code, severity, message, related_parcel_id, related_case_id, feature_index, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [run.id, f.code, f.severity, f.message, f.relatedParcelId ?? null, f.relatedCaseId ?? null, f.featureIndex ?? null, JSON.stringify(f.detail ?? {})],
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
export const findingKey = (f: { code: string; relatedParcelId?: string | null; relatedCaseId?: string | null; featureIndex?: number | null }) =>
  `${f.code}|${f.relatedParcelId ?? ''}|${f.relatedCaseId ?? ''}|${f.featureIndex ?? ''}`;
