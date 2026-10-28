import type pg from 'pg';
import { badRequest } from '../http.js';
import type { CaseRow } from './cases.js';

/**
 * Working versions of a case's geometry. Every staging batch is a numbered version; importing,
 * synchronizing from ArcMap or correcting attributes creates a new one and supersedes the previous.
 * A version that was submitted for review is frozen (database trigger), so corrections always create a
 * new version and the submitted snapshot stays exactly as reviewed. Nothing here is published data.
 */

export interface IncomingFeature { geometry: Record<string, unknown>; properties: Record<string, unknown> }

export interface StageOptions {
  features: IncomingFeature[];
  srid: number;
  sourceName: string;
  sha256: string;
  userId: string;
  sourceKind: 'upload' | 'arcmap' | 'correction';
  jobId?: string | null;
  changeReason?: string | null;
}

export async function nextVersionNo(client: pg.PoolClient, caseId: string): Promise<number> {
  const { rows: [r] } = await client.query('SELECT coalesce(max(version_no), 0) + 1 AS n FROM staging.batch WHERE case_id = $1', [caseId]);
  return r.n;
}

/** Stores features as a new working version. Structurally invalid geometry is kept as received and flagged, never repaired. */
export async function stageFeatures(client: pg.PoolClient, cs: CaseRow, o: StageOptions) {
  const versionNo = await nextVersionNo(client, cs.id);
  const { rows: [previous] } = await client.query(`SELECT id FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  await client.query(`UPDATE staging.batch SET status = 'superseded' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  const { rows: [batch] } = await client.query(
    `INSERT INTO staging.batch (case_id, uploaded_by, source_filename, file_sha256, declared_srid, feature_count, status,
                                version_no, source_kind, job_id, parent_batch_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11) RETURNING id`,
    [cs.id, o.userId, o.sourceName.slice(0, 200), o.sha256, o.srid, o.features.length, versionNo, o.sourceKind, o.jobId ?? null, previous?.id ?? null, o.changeReason ?? null],
  );

  const problems: (string | null)[] = [];
  for (const [index, { geometry, properties }] of o.features.entries()) {
    const label = o.features.length > 1 ? `Feature ${index + 1}: ` : '';
    let structural;
    try {
      ({ rows: [structural] } = await client.query(
        `WITH g AS (SELECT ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1), $2)) AS gi)
         SELECT gi, GeometryType(gi) AS gtype, ST_IsEmpty(gi) AS empty, ST_IsValid(gi) AS valid, ST_IsValidReason(gi) AS reason,
                ST_XMin(gi) AS xmin, ST_XMax(gi) AS xmax, ST_YMin(gi) AS ymin, ST_YMax(gi) AS ymax FROM g`,
        [JSON.stringify(geometry), o.srid],
      ));
    } catch {
      throw badRequest(`${label}The geometry could not be read as GeoJSON`);
    }
    let problem: string | null = null;
    if (!['POLYGON', 'MULTIPOLYGON'].includes(structural.gtype)) problem = `Expected a Polygon or MultiPolygon, got ${structural.gtype}`;
    else if (structural.empty) problem = 'The geometry is empty';
    else if (!structural.valid) problem = structural.reason;
    else if (o.srid === 4326 && (structural.xmin < -180 || structural.xmax > 180 || structural.ymin < -90 || structural.ymax > 90)) {
      problem = 'Coordinates are outside the valid longitude/latitude range for EPSG:4326; check the declared CRS';
    }
    problems.push(problem && `${label}${problem}`);
    await client.query(
      `INSERT INTO staging.feature (batch_id, feature_index, geom_input, geom, structural_ok, structural_message, properties)
       VALUES ($1, $2, $3::geometry, CASE WHEN $4 THEN ST_Multi(ST_Transform($3::geometry, 4326)) END, $4, $5, $6)`,
      [batch.id, index, structural.gi, problem === null, problem, JSON.stringify(properties)],
    );
  }
  return { batchId: batch.id as string, versionNo, problems: problems.filter((p): p is string => p !== null) };
}

/**
 * Copies a version into a new working version, optionally changing feature attributes or exclusion.
 * Geometry is copied exactly; geometry corrections come back through a new import or ArcMap sync.
 */
export async function copyVersion(
  client: pg.PoolClient, cs: CaseRow, fromBatchId: string, userId: string, reason: string,
  change: (f: { feature_index: number; properties: Record<string, unknown>; excluded: boolean; exclusion_reason: string | null }) =>
    { properties?: Record<string, unknown>; excluded?: boolean; exclusion_reason?: string | null } | null = () => null,
  jobId: string | null = null,
) {
  const { rows: [src] } = await client.query('SELECT * FROM staging.batch WHERE id = $1 AND case_id = $2', [fromBatchId, cs.id]);
  if (!src) throw badRequest('That version does not belong to this case');
  const versionNo = await nextVersionNo(client, cs.id);
  await client.query(`UPDATE staging.batch SET status = 'superseded' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
  const { rows: [batch] } = await client.query(
    `INSERT INTO staging.batch (case_id, uploaded_by, source_filename, file_sha256, declared_srid, feature_count, status,
                                version_no, source_kind, job_id, parent_batch_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 'correction', $8, $9, $10) RETURNING id`,
    [cs.id, userId, src.source_filename, src.file_sha256, src.declared_srid, src.feature_count, versionNo, jobId, src.id, reason],
  );
  const { rows: features } = await client.query(
    'SELECT feature_index, properties, excluded, exclusion_reason FROM staging.feature WHERE batch_id = $1 ORDER BY feature_index', [src.id]);
  let changed = 0;
  for (const f of features) {
    const c = change(f);
    if (c) changed++;
    await client.query(
      `INSERT INTO staging.feature (batch_id, feature_index, geom_input, geom, structural_ok, structural_message, properties, excluded, exclusion_reason)
       SELECT $1, feature_index, geom_input, geom, structural_ok, structural_message, $3, $4, $5 FROM staging.feature WHERE batch_id = $2 AND feature_index = $6`,
      [batch.id, src.id, JSON.stringify(c?.properties ?? f.properties), c?.excluded ?? f.excluded,
        c && 'exclusion_reason' in c ? c.exclusion_reason : f.exclusion_reason, f.feature_index],
    );
  }
  return { batchId: batch.id as string, versionNo, changed };
}

export async function isSubmitted(client: pg.PoolClient | pg.Pool, batchId: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM staging.submission WHERE batch_id = $1 LIMIT 1', [batchId]);
  return rows.length > 0;
}

/** Hash of a version's features (geometry, attributes, exclusion), so a snapshot can be checked later. */
export async function versionHash(client: pg.PoolClient | pg.Pool, batchId: string): Promise<string | null> {
  const { rows: [r] } = await client.query(
    `SELECT encode(sha256(convert_to(coalesce(string_agg(
              feature_index || ':' || encode(ST_AsEWKB(geom_input), 'hex') || ':' || properties::text || ':' || excluded,
              '|' ORDER BY feature_index), ''), 'UTF8')), 'hex') AS h
       FROM staging.feature WHERE batch_id = $1`,
    [batchId],
  );
  return r?.h ?? null;
}

/** Records the immutable submission snapshot for a submitted case. */
export async function recordSubmission(client: pg.PoolClient, o: {
  caseId: string; runId: string; userId: string; outcome: 'under_review' | 'returned_by_validation';
  summary?: string | null; changeExplanation?: string | null; outstandingWarnings?: string | null; warningsAcknowledged?: boolean;
}) {
  const { rows: [batch] } = await client.query(`SELECT id, feature_count FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [o.caseId]);
  const { rows: [previous] } = await client.query('SELECT id FROM staging.submission WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1', [o.caseId]);
  const hash = batch ? await versionHash(client, batch.id) : null;
  const { rows: [s] } = await client.query(
    `INSERT INTO staging.submission (case_id, batch_id, validation_run_id, submitted_by, outcome, summary, change_explanation,
                                     outstanding_warnings, warnings_acknowledged, snapshot_hash, feature_count, previous_submission_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, submission_no`,
    [o.caseId, batch?.id ?? null, o.runId, o.userId, o.outcome, o.summary ?? null, o.changeExplanation ?? null, o.outstandingWarnings ?? null,
      o.warningsAcknowledged ?? false, hash, batch?.feature_count ?? 0, previous?.id ?? null],
  );
  return s as { id: string; submission_no: string };
}
