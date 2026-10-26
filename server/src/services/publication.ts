import type { Request } from 'express';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { conflict } from '../http.js';
import { setStatus, type CaseRow } from './cases.js';
import { computeSnapshot } from './snapshot.js';
import { evaluateCase, findingKey, persistRun, type Finding } from './validation.js';
import { OWNERSHIP_TYPES } from './shares.js';

export type PublishOutcome =
  | { published: true; parcelId: string | null; upi: string }
  | { published: false; reason: string; findings: Finding[] };

export const AREA_METHOD = 'Geodesic area on the WGS 84 ellipsoid (PostGIS ST_Area on geography); not a surveyed or legal area';

/**
 * Publishes an approved case inside the caller's transaction. Either every change lands
 * (parcel, version, rights, case status, audit event) or none does.
 *
 * If the approved material changed, or new conflicts appeared since approval, nothing is
 * published: the case is reopened for review and the caller commits only that.
 */
export async function publishApprovedCase(
  client: pg.PoolClient,
  req: Request,
  cs: CaseRow,
  opts: { simulateFailure?: boolean } = {},
): Promise<PublishOutcome> {
  const actorId = req.auth!.user.id;
  const { rows: [approval] } = await client.query(
    `SELECT * FROM lais.case_decision
      WHERE case_id = $1 AND decision = 'approved' AND superseded_at IS NULL
      ORDER BY decided_at DESC LIMIT 1`,
    [cs.id],
  );
  if (!approval) throw conflict('This case has no current approval');

  // Serialise publication per county so two overlapping parcels cannot both pass the conflict check concurrently.
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [42, cs.county_id]);

  const snapshot = await computeSnapshot(client, cs);
  const evaluation = await evaluateCase(client, cs);
  const acknowledged = new Set<string>();
  if (approval.validation_run_id) {
    const { rows } = await client.query(
      `SELECT code, related_parcel_id, related_case_id FROM staging.finding WHERE run_id = $1 AND acknowledged_by IS NOT NULL`,
      [approval.validation_run_id],
    );
    for (const r of rows) acknowledged.add(findingKey({ code: r.code, relatedParcelId: r.related_parcel_id, relatedCaseId: r.related_case_id }));
  }
  const errors = evaluation.findings.filter((f) => f.severity === 'error');
  const newWarnings = evaluation.findings.filter((f) => f.severity === 'warning' && !acknowledged.has(findingKey(f)));

  let reopenReason: string | null = null;
  if (snapshot !== approval.snapshot_hash) reopenReason = 'The case material or the parcel changed after approval';
  else if (errors.length > 0) reopenReason = 'Validation errors appeared after approval';
  else if (newWarnings.length > 0) reopenReason = 'New conflicts appeared after approval and need review';

  if (reopenReason) {
    await persistRun(client, cs, evaluation, actorId, 'publication');
    await client.query('UPDATE lais.case_decision SET superseded_at = clock_timestamp() WHERE id = $1', [approval.id]);
    await setStatus(client, cs, 'under_review', actorId, 'reopen', reopenReason);
    await writeAudit(req, {
      action: 'case.publish', outcome: 'failure', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { reason: reopenReason, reopened: true, errorCount: errors.length, newWarningCount: newWarnings.length },
    }, client);
    return { published: false, reason: reopenReason, findings: [...errors, ...newWarnings] };
  }

  const result = cs.case_type === 'first_registration'
    ? await publishRegistration(client, cs)
    : cs.case_type === 'transfer'
      ? await publishTransfer(client, cs)
      : cs.case_type === 'correction'
        ? await publishCorrection(client, cs)
        : await publishReshape(client, cs);

  if (opts.simulateFailure) {
    // Test hook for the data-integrity evaluation: everything above must roll back.
    throw new Error('Simulated publication failure');
  }

  // Status and parcel link change in one UPDATE: the trigger forbids editing an approved case's fields otherwise.
  await setStatus(client, cs, 'published', actorId, 'publish', `Published as ${result.upi}`, result.parcelId ?? undefined);
  await writeAudit(req, {
    action: 'case.publish', outcome: 'success', entityType: 'parcel', entityId: result.parcelId, caseId: cs.id, countyId: cs.county_id,
    detail: { upi: result.upi, caseNo: cs.case_no, caseType: cs.case_type, approvalId: approval.id, snapshot },
  }, client);
  return { published: true, ...result };
}

interface Published {
  /** The single resulting parcel, or null when a subdivision creates several. */
  parcelId: string | null;
  /** The resulting identifier(s), comma-separated when there are several. */
  upi: string;
}

async function nextProvisionalUpi(client: pg.PoolClient, countyId: number): Promise<string> {
  const { rows: [r] } = await client.query(
    `SELECT c.code, lpad(nextval('lais.provisional_upi_seq')::text, 6, '0') AS n FROM lais.county c WHERE c.id = $1`,
    [countyId],
  );
  return `PROV-${r.code}-${r.n}`;
}

/** Creates a parcel with version 1 from a staged feature and registers the rights proposed for it. */
async function createParcelFromFeature(
  client: pg.PoolClient,
  cs: CaseRow,
  feature: { id: string; feature_index: number },
  upi: string,
  rightsFeatureIndex: number | null,
): Promise<string> {
  const { rows: [parcel] } = await client.query(
    'INSERT INTO lais.parcel (upi, county_id) VALUES ($1, $2) RETURNING id',
    [upi, cs.county_id],
  );
  const { rows: [version] } = await client.query(
    `INSERT INTO lais.parcel_version
       (parcel_id, version_no, geom, area_m2_calculated, area_method, land_category, land_use, source_reference, published_by_case)
     SELECT $1, 1, f.geom, round(ST_Area(f.geom::geography)::numeric, 2), $2, $3, $4, $5, $6
       FROM staging.feature f WHERE f.id = $7 AND f.structural_ok
     RETURNING id`,
    [parcel.id, AREA_METHOD, cs.land_category, cs.land_use, cs.source_reference, cs.id, feature.id],
  );
  if (!version) throw new Error('No valid staged geometry to publish');
  await client.query('UPDATE lais.parcel SET current_version_id = $2 WHERE id = $1', [parcel.id, version.id]);
  await insertProposedRights(client, cs, parcel.id, rightsFeatureIndex);
  return parcel.id;
}

async function activeFeatures(client: pg.PoolClient, caseId: string): Promise<{ id: string; feature_index: number }[]> {
  const { rows } = await client.query(
    `SELECT f.id, f.feature_index FROM staging.batch b JOIN staging.feature f ON f.batch_id = b.id
      WHERE b.case_id = $1 AND b.status = 'active' ORDER BY f.feature_index`,
    [caseId],
  );
  return rows;
}

async function publishRegistration(client: pg.PoolClient, cs: CaseRow): Promise<Published> {
  const [feature] = await activeFeatures(client, cs.id);
  if (!feature) throw new Error('No valid staged geometry to publish');
  const upi = cs.proposed_upi ?? (await nextProvisionalUpi(client, cs.county_id));
  const parcelId = await createParcelFromFeature(client, cs, feature, upi, null);
  await client.query(`UPDATE staging.batch SET status = 'published' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  return { parcelId, upi };
}

async function publishTransfer(client: pg.PoolClient, cs: CaseRow): Promise<Published> {
  const { rows: [parcel] } = await client.query('SELECT id, upi FROM lais.parcel WHERE id = $1 FOR UPDATE', [cs.parcel_id]);
  // Outgoing ownership interests are ended, not deleted. Encumbrances (mortgages, leases, easements) carry forward.
  await client.query(
    `UPDATE lais.rrr SET valid_to = now(), ended_by_case = $2
      WHERE parcel_id = $1 AND valid_to IS NULL AND rrr_type = ANY($3)`,
    [parcel.id, cs.id, OWNERSHIP_TYPES],
  );
  await insertProposedRights(client, cs, parcel.id, null);
  return { parcelId: parcel.id, upi: parcel.upi };
}

/**
 * Correction: closes the current version and publishes the next one with the corrected boundary
 * (from staging, or unchanged) and attributes. The erroneous version stays in the history. Rights are untouched.
 */
async function publishCorrection(client: pg.PoolClient, cs: CaseRow): Promise<Published> {
  const { rows: [parcel] } = await client.query(
    `SELECT p.id, p.upi, v.id AS version_id, v.version_no
       FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
      WHERE p.id = $1 FOR UPDATE OF p`,
    [cs.parcel_id],
  );
  const [feature] = await activeFeatures(client, cs.id);
  await client.query('UPDATE lais.parcel_version SET valid_to = now() WHERE id = $1', [parcel.version_id]);
  const { rows: [version] } = await client.query(
    `INSERT INTO lais.parcel_version
       (parcel_id, version_no, geom, area_m2_calculated, area_method, area_m2_surveyed, land_category, land_use, source_reference, published_by_case)
     SELECT $1, $2, g, round(ST_Area(g::geography)::numeric, 2), $3, $4, $5, $6, $7, $8
       FROM (SELECT coalesce((SELECT f.geom FROM staging.feature f WHERE f.id = $9 AND f.structural_ok),
                             (SELECT v.geom FROM lais.parcel_version v WHERE v.id = $10)) AS g) s
     RETURNING id`,
    [parcel.id, parcel.version_no + 1, AREA_METHOD, cs.area_m2_surveyed, cs.land_category, cs.land_use, cs.source_reference, cs.id,
      feature?.id ?? null, parcel.version_id],
  );
  await client.query('UPDATE lais.parcel SET current_version_id = $2 WHERE id = $1', [parcel.id, version.id]);
  if (feature) await client.query(`UPDATE staging.batch SET status = 'published' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  return { parcelId: parcel.id, upi: `${parcel.upi} (version ${parcel.version_no + 1})` };
}

/**
 * Subdivision and consolidation. The source parcels are retired: their current versions are closed
 * and every current right on them ends. Nothing is deleted. Each new parcel gets a new provisional
 * identifier, version 1 and the rights proposed for it, and lineage records link old to new.
 */
async function publishReshape(client: pg.PoolClient, cs: CaseRow): Promise<Published> {
  const { rows: sources } = await client.query(
    `SELECT id FROM lais.parcel WHERE id IN (SELECT parcel_id FROM lais.case_source_parcel WHERE case_id = $1) ORDER BY id FOR UPDATE`,
    [cs.id],
  );
  const sourceIds = sources.map((s) => s.id);
  await client.query(
    'UPDATE lais.rrr SET valid_to = now(), ended_by_case = $2 WHERE parcel_id = ANY($1::uuid[]) AND valid_to IS NULL',
    [sourceIds, cs.id],
  );
  await client.query('UPDATE lais.parcel_version SET valid_to = now() WHERE parcel_id = ANY($1::uuid[]) AND valid_to IS NULL', [sourceIds]);
  await client.query(`UPDATE lais.parcel SET status = 'retired' WHERE id = ANY($1::uuid[])`, [sourceIds]);

  const features = await activeFeatures(client, cs.id);
  const created: { id: string; upi: string }[] = [];
  for (const f of features) {
    const upi = await nextProvisionalUpi(client, cs.county_id);
    // Consolidation proposals target the single new parcel whether or not they name feature 0.
    const id = await createParcelFromFeature(client, cs, f, upi, cs.case_type === 'subdivision' ? f.feature_index : null);
    for (const parent of sourceIds) {
      await client.query(
        'INSERT INTO lais.parcel_lineage (parent_parcel_id, child_parcel_id, case_id) VALUES ($1, $2, $3)',
        [parent, id, cs.id],
      );
    }
    created.push({ id, upi });
  }
  await client.query(`UPDATE staging.batch SET status = 'published' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  return { parcelId: created.length === 1 ? created[0].id : null, upi: created.map((c) => c.upi).join(', ') };
}

/** Registers the case's proposed rights on a parcel; with featureIndex, only those proposed for that new parcel. */
async function insertProposedRights(client: pg.PoolClient, cs: CaseRow, parcelId: string, featureIndex: number | null): Promise<void> {
  await client.query(
    `INSERT INTO lais.rrr (parcel_id, party_id, rrr_type, share_num, share_den, interest_status, created_by_case)
     SELECT $1, party_id, rrr_type, share_num, share_den, 'registered', $2
       FROM lais.case_right_proposal WHERE case_id = $2 AND ($3::int IS NULL OR feature_index = $3)`,
    [parcelId, cs.id, featureIndex],
  );
}
