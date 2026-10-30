import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { config } from '../config.js';
import { pool, tx, type Db } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../http.js';
import { writeAudit } from '../audit.js';
import { log } from '../logger.js';
import { EDITABLE_STATUSES } from '../authz/workflow.js';
import { ACCEPTED_SRIDS, FEATURE_LIMITS } from './geojson.js';
import { getCase, recordEvent } from './cases.js';
import { openUpload, type LayerData } from './gisFormats.js';
import { stageFeatures, type IncomingFeature } from './staging.js';
import { notifyUsers } from './notify.js';

/**
 * GIS import and ArcMap synchronization jobs. A job reads an uploaded file into a NEW working version of
 * one case, in a single transaction: if anything fails, nothing is staged and the job records why.
 * Jobs run in the background (the API answers 202 and the client polls), and a job whose source is
 * byte-for-byte the current version's source does not create a duplicate version.
 */

// ---------------------------------------------------------------------------
// Upload store: files wait here between inspection and import, then are deleted.
// ---------------------------------------------------------------------------

interface UploadMeta { key: string; filename: string; size: number; sha256: string; uploadedBy: string; createdAt: string }
const keyPattern = /^[0-9a-f]{32}$/;
const uploadPath = (key: string) => path.join(config.gisUploadDir, `${key}.bin`);
const metaPath = (key: string) => path.join(config.gisUploadDir, `${key}.json`);

export async function saveUpload(buffer: Buffer, filename: string, userId: string): Promise<UploadMeta> {
  await fs.mkdir(config.gisUploadDir, { recursive: true });
  await purgeOldUploads();
  const key = randomBytes(16).toString('hex');
  // The original name is only metadata: the file is stored under the random key.
  const meta: UploadMeta = {
    key, filename: path.basename(filename).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'upload', size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'), uploadedBy: userId, createdAt: new Date().toISOString(),
  };
  await fs.writeFile(uploadPath(key), buffer, { flag: 'wx' });
  await fs.writeFile(metaPath(key), JSON.stringify(meta), { flag: 'wx' });
  return meta;
}

/** Loads an upload; only the person who uploaded it may use it. */
export async function loadUpload(key: string, userId: string): Promise<{ meta: UploadMeta; buffer: Buffer }> {
  if (!keyPattern.test(key)) throw badRequest('Invalid upload reference');
  let meta: UploadMeta;
  try { meta = JSON.parse(await fs.readFile(metaPath(key), 'utf8')); } catch { throw notFound('The upload has expired or does not exist; upload the file again'); }
  if (meta.uploadedBy !== userId) throw notFound('The upload has expired or does not exist; upload the file again');
  return { meta, buffer: await fs.readFile(uploadPath(key)) };
}

export async function purgeOldUploads() {
  const cutoff = Date.now() - config.gisUploadRetentionHours * 3_600_000;
  let names: string[];
  try { names = await fs.readdir(config.gisUploadDir); } catch { return; }
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(config.gisUploadDir, n), 'utf8')) as UploadMeta;
      if (Date.parse(meta.createdAt) < cutoff) {
        await fs.rm(uploadPath(meta.key), { force: true });
        await fs.rm(metaPath(meta.key), { force: true });
      }
    } catch { /* ignore unreadable entries */ }
  }
}

// ---------------------------------------------------------------------------
// Field mapping and CRS policy
// ---------------------------------------------------------------------------

/** Attributes LAIS understands on a staged parcel. Unmapped source fields are kept under their own names. */
export const TARGET_FIELDS = {
  source_id: { label: 'Source feature identifier', type: 'text' },
  legacy_ref: { label: 'Legacy reference', type: 'text' },
  land_category: { label: 'Land category (public, government, customary, private)', type: 'category' },
  land_use: { label: 'Land use', type: 'text' },
  surveyed_area_m2: { label: 'Surveyed area (m²)', type: 'number' },
  holder_names: { label: 'Holder names (migration only)', type: 'text' },
  holder_type: { label: 'Holder type (migration only)', type: 'text' },
  notes: { label: 'Technical notes', type: 'text' },
} as const;
export type TargetField = keyof typeof TARGET_FIELDS;
const LAND_CATEGORIES = ['public', 'government', 'customary', 'private'];

/** Required target fields per case type (matched by the validation rules of that case type). */
export const REQUIRED_FIELDS: Record<string, TargetField[]> = { migration: ['legacy_ref', 'land_category'] };

export function resolveCrs(detected: number | null, declared: number | null, exceptionReason: string | null, format: string) {
  if (detected !== null && !ACCEPTED_SRIDS[detected]) {
    throw badRequest(`The data is in EPSG:${detected}. LAIS accepts EPSG:4326 or EPSG:32629: reproject it in the GIS tool first (LAIS does not transform other systems).`);
  }
  if (detected !== null && declared !== null && detected !== declared) {
    throw badRequest(`You declared EPSG:${declared} but the file's metadata says EPSG:${detected}. Check the data; LAIS never overrides file metadata.`);
  }
  const srid = detected ?? declared;
  if (srid === null) throw badRequest('The coordinate reference system is unknown. Declare it (EPSG:4326 or EPSG:32629) and explain how you know it.');
  if (!ACCEPTED_SRIDS[srid]) throw badRequest(`EPSG:${srid} is not accepted`);
  let reason: string | null = null;
  if (detected === null) {
    // GeoJSON without a crs member is WGS 84 by definition (RFC 7946); anything else needs a stated reason.
    if (format === 'geojson' && srid === 4326 && !exceptionReason) reason = 'GeoJSON without a crs member is WGS 84 longitude/latitude by definition (RFC 7946)';
    else if (!exceptionReason || exceptionReason.trim().length < 10) throw badRequest('The file has no CRS metadata. State how the declared CRS was established (10+ characters); it is recorded with the import.');
    else reason = exceptionReason.trim();
  }
  return { srid, detected, reason };
}

function mapProperties(p: Record<string, unknown>, mapping: Partial<Record<TargetField, string>>) {
  const out: Record<string, unknown> = { ...p };
  for (const [target, source] of Object.entries(mapping)) {
    if (source && Object.prototype.hasOwnProperty.call(p, source)) out[target] = p[source];
  }
  return out;
}

/** Problems with one record's mapped attributes (reported, not fatal: validation decides what blocks). */
function attributeProblems(props: Record<string, unknown>, required: TargetField[]): string[] {
  const problems: string[] = [];
  for (const f of required) if (props[f] === undefined || props[f] === null || props[f] === '') problems.push(`${f} is empty`);
  if (props.land_category !== undefined && props.land_category !== null && props.land_category !== ''
      && !LAND_CATEGORIES.includes(String(props.land_category).toLowerCase())) problems.push(`land_category "${String(props.land_category).slice(0, 40)}" is not a land category`);
  if (props.surveyed_area_m2 !== undefined && props.surveyed_area_m2 !== null && props.surveyed_area_m2 !== ''
      && !(Number(props.surveyed_area_m2) > 0)) problems.push('surveyed_area_m2 is not a positive number');
  return problems;
}

const finite = (g: unknown): boolean => {
  const walk = (v: unknown): boolean => (Array.isArray(v) ? v.every(walk) : typeof v === 'number' ? Number.isFinite(v) : false);
  return walk((g as { coordinates?: unknown })?.coordinates);
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Maps and screens the records of a layer. Records without a usable polygon are rejected (and reported);
 * attribute problems are warnings, because validation decides what blocks. Geometry is not changed.
 */
export async function prepareRecords(db: Db, layer: LayerData, mapping: Partial<Record<TargetField, string>>, required: TargetField[]) {
  const missingMappings = required.filter((f) => !mapping[f] && !layer.info.fields.some((x) => x.name.toLowerCase() === f));
  const warnings: string[] = missingMappings.map((f) => `Required field "${f}" is not mapped: records will fail validation`);
  const rejections: { record: number; reason: string }[] = [];
  const accepted: IncomingFeature[] = [];
  for (const [i, f] of layer.features.entries()) {
    let geometry = f.geometry;
    if (geometry && 'wkt' in geometry) {
      try {
        const { rows: [g] } = await db.query('SELECT ST_AsGeoJSON(ST_GeomFromText($1))::json AS g', [String(geometry.wkt).slice(0, 2_000_000)]);
        geometry = g.g;
      } catch { rejections.push({ record: i + 1, reason: 'WKT geometry could not be read' }); continue; }
    } else if (geometry && 'wkb' in geometry) {
      // GeoPackage geometry: standard WKB, parsed by PostGIS (parameterised, never interpolated).
      try {
        const { rows: [g] } = await db.query(`SELECT ST_AsGeoJSON(ST_GeomFromWKB(decode($1, 'hex')))::json AS g`, [String(geometry.wkb)]);
        geometry = g.g;
      } catch { rejections.push({ record: i + 1, reason: 'GeoPackage geometry could not be read' }); continue; }
    }
    if (!geometry) { rejections.push({ record: i + 1, reason: 'No geometry (null or empty)' }); continue; }
    if (!['Polygon', 'MultiPolygon'].includes(String(geometry.type))) { rejections.push({ record: i + 1, reason: `Geometry type ${String(geometry.type)} is not a parcel polygon` }); continue; }
    if (!finite(geometry)) { rejections.push({ record: i + 1, reason: 'Invalid (non-numeric or infinite) coordinates' }); continue; }
    const props = mapProperties(f.properties, mapping);
    for (const p of attributeProblems(props, required)) warnings.push(`Record ${i + 1}: ${p}`);
    accepted.push({ geometry, properties: props });
  }
  return { accepted, rejections, warnings };
}

/** What an import would do, without staging anything: CRS decision, counts, rejections and mapped samples. */
export async function previewImport(req: Request, input: JobInput) {
  const cs = await getCase(pool, input.caseId);
  const { meta, buffer } = await loadUpload(input.uploadKey, req.auth!.user.id);
  const opened = await openUpload(buffer, meta.filename, { wktColumn: input.wktColumn });
  const want = input.layer;
  const layer = want ? opened.layers.find((l) => l.info.name === want.toLowerCase() || l.info.name === want) : opened.layers[0];
  if (!layer) throw badRequest(`Layer "${input.layer}" is not in the file`);
  const crs = resolveCrs(layer.info.crs.epsg, input.declaredCrs ?? null, input.crsExceptionReason ?? null, opened.format);
  const { accepted, rejections, warnings } = await prepareRecords(pool, layer, input.fieldMapping ?? {}, REQUIRED_FIELDS[cs.case_type] ?? []);
  const limits = FEATURE_LIMITS[cs.case_type];
  // Extent in EPSG:4326, so the officer can see on the map where the data will land before confirming.
  let extent: number[] | null = null;
  if (accepted.length) {
    const { rows: [e] } = await pool.query(
      `SELECT ST_XMin(x) AS a, ST_YMin(x) AS b, ST_XMax(x) AS c, ST_YMax(x) AS d FROM (
         SELECT ST_Transform(ST_SetSRID(ST_Extent(ST_GeomFromGeoJSON(g))::geometry, $2), 4326) AS x FROM unnest($1::text[]) g) t`,
      [accepted.slice(0, 2000).map((f) => JSON.stringify(f.geometry)), crs.srid],
    ).catch(() => ({ rows: [null] }));
    if (e && e.a !== null) extent = [e.a, e.b, e.c, e.d];
  }
  return {
    caseNo: cs.case_no, format: opened.format, layer: layer.info.name, file: meta.filename, sha256: meta.sha256,
    crs: { detected: crs.detected, declared: crs.srid, exceptionReason: crs.reason, name: ACCEPTED_SRIDS[crs.srid] },
    received: layer.features.length, accepted: accepted.length, rejected: rejections.length,
    withinLimits: !limits || (accepted.length >= limits.min && accepted.length <= limits.max), limitLabel: limits?.label ?? null,
    rejections: rejections.slice(0, 200), warnings: warnings.slice(0, 200), extent,
    sample: accepted.slice(0, 10).map((f) => f.properties),
    manifest: opened.manifest ?? null,
  };
}

export interface JobInput {
  kind: 'import' | 'arcmap_sync';
  caseId: string;
  uploadKey: string;
  layer?: string | null;
  declaredCrs?: number | null;
  crsExceptionReason?: string | null;
  fieldMapping?: Partial<Record<TargetField, string>>;
  purpose?: string | null;
  wktColumn?: string | null;
  retryOf?: string | null;
}

/** Creates a queued job after checking the case, the upload and the CRS. The caller has already authorized the user. */
export async function createJob(req: Request, input: JobInput) {
  const userId = req.auth!.user.id;
  const cs = await getCase(pool, input.caseId);
  const { meta, buffer } = await loadUpload(input.uploadKey, userId);
  const opened = await openUpload(buffer, meta.filename, { wktColumn: input.wktColumn });
  const want = input.layer; const layer = want ? opened.layers.find((l) => l.info.name === want.toLowerCase() || l.info.name === want) : opened.layers[0];
  if (!layer) throw badRequest(`Layer "${input.layer}" is not in the file`);
  const crs = resolveCrs(layer.info.crs.epsg, input.declaredCrs ?? null, input.crsExceptionReason ?? null, opened.format);
  const isPackage = opened.format === 'arcmap_package';
  // For CSV the "manifest" holds the reader options, so the runner reads the file the same way.
  const manifest = opened.manifest ?? (opened.format === 'csv_wkt' && input.wktColumn ? { wkt_column: input.wktColumn } : null);
  const kind = isPackage ? 'arcmap_sync' : input.kind;
  const text = (v: unknown, n: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n) : null);
  const exportId = isPackage ? text(manifest?.export_id, 100) : null;
  // A package names its own mapping (shapefile field names are at most 10 characters, so they rarely match
  // the targets). Only known targets pointing at fields that exist in the layer are taken from the file.
  let fieldMapping = input.fieldMapping ?? {};
  if (isPackage && !input.fieldMapping && manifest?.field_map && typeof manifest.field_map === 'object') {
    fieldMapping = Object.fromEntries(Object.entries(manifest.field_map as Record<string, unknown>)
      .filter(([t, f]) => t in TARGET_FIELDS && typeof f === 'string' && layer.info.fields.some((x) => x.name === f))) as Partial<Record<TargetField, string>>;
  }
  if (exportId) {
    // Idempotent resend: an export already processed for this case is answered with the earlier job.
    const { rows: [done] } = await pool.query(
      `SELECT id, job_no FROM staging.import_job WHERE case_id = $1 AND export_id = $2 AND status IN ('completed', 'completed_with_warnings')`, [cs.id, exportId]);
    if (done) return { id: done.id as string, job_no: done.job_no as string, duplicate: true };
  }
  const { rows: [job] } = await pool.query(
    `INSERT INTO staging.import_job (kind, county_id, case_id, initiated_by, purpose, source_name, source_format, source_layer, source_size_bytes,
                                     source_sha256, source_crs_detected, source_crs_declared, crs_exception_reason, adapter_version, source_dataset,
                                     source_version, export_id, manifest, field_mapping, upload_key, records_received, retry_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id, job_no`,
    [kind, cs.county_id, cs.id, userId, input.purpose ?? null, meta.filename, opened.format, layer.info.name, meta.size, meta.sha256,
      crs.detected, crs.srid, crs.reason, isPackage ? text(manifest?.adapter_version, 40) : null, isPackage ? text(manifest?.source_dataset, 300) : null,
      isPackage ? text(manifest?.source_version, 120) : null, exportId, manifest ? JSON.stringify(manifest) : null,
      JSON.stringify(fieldMapping), input.uploadKey, layer.info.featureCount, input.retryOf ?? null],
  );
  await writeAudit(req, {
    action: `gis.${kind === 'arcmap_sync' ? 'sync' : 'import'}_queued`, outcome: 'success', entityType: 'import_job', entityId: job.id, caseId: cs.id, countyId: cs.county_id,
    detail: { jobNo: job.job_no, file: meta.filename, format: opened.format, layer: layer.info.name, srid: crs.srid, crsDeclaredWithoutMetadata: crs.detected === null },
  });
  return { id: job.id as string, job_no: job.job_no as string, duplicate: false };
}

const running = new Map<string, Promise<void>>();

/** Starts a job in the background and returns a promise that settles when it ends. */
export function startJob(jobId: string): Promise<void> {
  const p = runJob(jobId).finally(() => running.delete(jobId));
  running.set(jobId, p);
  return p;
}

async function runJob(jobId: string): Promise<void> {
  const { rows: [job] } = await pool.query(`UPDATE staging.import_job SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [jobId]);
  if (!job) return;
  const startedAt = Date.now();
  const { rows: [owner] } = await pool.query('SELECT username FROM lais.app_user WHERE id = $1', [job.initiated_by]);
  const actor = { id: job.initiated_by as string, username: (owner?.username as string) ?? null };
  try {
    const { buffer, meta } = await loadUpload(job.upload_key, job.initiated_by);
    const opened = await openUpload(buffer, meta.filename, { wktColumn: job.manifest?.wkt_column ?? null });
    const layer = opened.layers.find((l) => l.info.name === job.source_layer) as LayerData | undefined;
    if (!layer) throw badRequest('The layer is no longer in the file');

    const result = await tx(async (client) => {
      const cs = await getCase(client, job.case_id, true);
      if (!(EDITABLE_STATUSES as readonly string[]).includes(cs.status)) throw conflict(`The case is ${cs.status}; geometry can only be imported while it is a draft or returned`);
      const limits = FEATURE_LIMITS[cs.case_type];
      if (!limits) throw badRequest(`${cs.case_type} cases do not take imported geometry`);

      // Idempotency: the same source, layer, mapping and CRS as the current version creates nothing new.
      const { rows: [same] } = await client.query(
        `SELECT j.job_no, b.id AS batch_id, b.version_no FROM staging.import_job j JOIN staging.batch b ON b.id = j.batch_id AND b.status = 'active'
          WHERE j.case_id = $1 AND j.id <> $2 AND j.status IN ('completed', 'completed_with_warnings')
            AND j.source_sha256 = $3 AND j.source_layer IS NOT DISTINCT FROM $4 AND j.field_mapping = $5 AND j.source_crs_declared = $6`,
        [cs.id, job.id, job.source_sha256, job.source_layer, JSON.stringify(job.field_mapping), job.source_crs_declared],
      );
      if (same) {
        return { batchId: same.batch_id, accepted: 0, rejected: 0, unchanged: layer.features.length, warnings: [`Identical to the current version ${same.version_no} (job ${same.job_no}): no new version was created`], rejections: [], versionNo: same.version_no, duplicate: true };
      }

      // ArcMap packages: the manifest must match the case and the data, and the county comes from the case, never the file.
      if (job.kind === 'arcmap_sync') {
        const m = job.manifest ?? {};
        const { rows: [county] } = await client.query('SELECT code FROM lais.county WHERE id = $1', [cs.county_id]);
        if (m.case_no && m.case_no !== cs.case_no) throw badRequest(`The package was exported for ${m.case_no}, not ${cs.case_no}`);
        if (m.county_code && String(m.county_code).toUpperCase() !== county.code) throw badRequest(`The package says county ${m.county_code}, but ${cs.case_no} is in ${county.code}`);
        if (m.feature_count !== undefined && Number(m.feature_count) !== layer.features.length) throw badRequest(`The manifest lists ${m.feature_count} features but the package contains ${layer.features.length}`);
        if (m.srid !== undefined && Number(m.srid) !== job.source_crs_declared) throw badRequest(`The manifest says EPSG:${m.srid} but the .prj says EPSG:${job.source_crs_declared}`);
      }

      const { accepted, rejections, warnings } = await prepareRecords(client, layer, job.field_mapping, REQUIRED_FIELDS[cs.case_type] ?? []);
      if (accepted.length < limits.min || accepted.length > limits.max) {
        throw badRequest(`${limits.label}; ${accepted.length} record(s) were accepted from this file (${rejections.length} rejected).`);
      }
      const staged = await stageFeatures(client, cs, {
        features: accepted, srid: job.source_crs_declared, sourceName: `${job.source_name}${job.source_layer && job.source_format !== 'geojson' ? ` / ${job.source_layer}` : ''}`,
        sha256: job.source_sha256, userId: job.initiated_by, sourceKind: job.kind === 'arcmap_sync' ? 'arcmap' : 'upload', jobId: job.id,
        changeReason: job.purpose,
      });
      warnings.push(...staged.problems);
      await recordEvent(client, cs.id, job.initiated_by, 'import_geometry',
        `${job.kind === 'arcmap_sync' ? 'ArcMap sync' : 'Import'} ${job.job_no}: ${job.source_name} (EPSG:${job.source_crs_declared}, ${accepted.length} feature(s)) as version ${staged.versionNo}`);
      return { batchId: staged.batchId, accepted: accepted.length, rejected: rejections.length, unchanged: 0, warnings, rejections, versionNo: staged.versionNo, duplicate: false };
    });

    const status = result.warnings.length || result.rejected ? 'completed_with_warnings' : 'completed';
    await pool.query(
      `UPDATE staging.import_job SET status = $2, batch_id = $3, records_accepted = $4, records_rejected = $5, records_inserted = $4, records_updated = 0,
              records_unchanged = $6, warnings = $7, rejections = $8, finished_at = now() WHERE id = $1`,
      [job.id, status, result.batchId, result.accepted, result.rejected, result.unchanged, JSON.stringify(result.warnings.slice(0, 500)), JSON.stringify(result.rejections.slice(0, 1000))],
    );
    await writeAudit(null, {
      action: `gis.${job.kind === 'arcmap_sync' ? 'sync' : 'import'}_completed`, outcome: 'success', actor, entityType: 'import_job', entityId: job.id,
      caseId: job.case_id, countyId: job.county_id,
      detail: { jobNo: job.job_no, version: result.versionNo, accepted: result.accepted, rejected: result.rejected, duplicate: result.duplicate, ms: Date.now() - startedAt },
    });
    await notifyUsers(pool, [job.initiated_by], {
      category: 'gis', title: `${job.job_no} ${result.duplicate ? 'matched the current version' : `staged as version ${result.versionNo}`}`,
      body: `${result.accepted} accepted, ${result.rejected} rejected`, link: `/gis/jobs?job=${job.id}`,
    });
  } catch (err) {
    // Known problems are explained to the officer; anything else is logged with the job number only.
    const resent = (err as { code?: string }).code === '23505';
    const message = err instanceof HttpError ? err.message
      : resent ? 'This ArcMap export was already processed for the case by another job; nothing new was staged.'
      : 'The job failed unexpectedly; nothing was staged. Retry it or contact support.';
    if (!(err instanceof HttpError) && !resent) log('error', 'gis job failed', { jobId: job.id, error: (err as Error).message, stack: (err as Error).stack });
    await pool.query(`UPDATE staging.import_job SET status = 'failed', error_summary = $2, finished_at = now() WHERE id = $1`, [job.id, message.slice(0, 1000)]);
    await writeAudit(null, {
      action: `gis.${job.kind === 'arcmap_sync' ? 'sync' : 'import'}_failed`, outcome: 'failure', actor, entityType: 'import_job', entityId: job.id,
      caseId: job.case_id, countyId: job.county_id, detail: { jobNo: job.job_no, error: message.slice(0, 300) },
    }).catch(() => undefined);
    await notifyUsers(pool, [job.initiated_by], { category: 'gis', title: `${job.job_no} failed`, body: message.slice(0, 200), link: `/gis/jobs?job=${job.id}` }).catch(() => undefined);
  }
}

/** Waits for a running job, up to a limit (for clients that prefer one call). */
export async function awaitJob(jobId: string, ms: number) {
  const p = running.get(jobId);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

/** Jobs left queued or running by a stopped server are marked failed at start-up: they never half-finished. */
export async function failInterruptedJobs() {
  const { rowCount } = await pool.query(
    `UPDATE staging.import_job SET status = 'failed', finished_at = now(), error_summary = 'Interrupted by a server restart; nothing was staged. Retry the job.'
      WHERE status IN ('queued', 'running')`,
  );
  if (rowCount) log('warn', 'gis jobs interrupted by restart', { count: rowCount });
}

export { HttpError };
