import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config, isTest } from '../config.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, parseId } from '../http.js';
import { writeAudit } from '../audit.js';
import { enforce } from '../authz/enforce.js';
import { authorize, scopeFor, type Action } from '../authz/policy.js';
import { CASE_STATUSES } from '../authz/workflow.js';
import { caseContext, getCase, inCaseTx, recordEvent, setStatus } from '../services/cases.js';
import { ACCEPTED_SRIDS, extractFeatures, FEATURE_LIMITS } from '../services/geojson.js';
import { computeSnapshot } from '../services/snapshot.js';
import { evaluateCase, latestRun, persistRun, PROVISIONAL_UPI_PATTERN } from '../services/validation.js';
import { publishApprovedCase } from '../services/publication.js';
import { OWNERSHIP_TYPES } from '../services/shares.js';
import { notifyUsers } from '../services/notify.js';
import { detectDocumentType } from '../services/files.js';
import { csvCell } from '../csv.js';

export const casesRouter = Router();

const geojsonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

const LAND_CATEGORIES = ['public', 'government', 'customary', 'private'] as const;
const RRR_TYPES = ['ownership', 'co_ownership', 'customary_tenure', 'lease', 'mortgage', 'easement'] as const;
const CLASSIFICATIONS = ['public', 'restricted', 'highly_sensitive'] as const;

/** Case-level actions whose availability is reported to the UI. The server re-checks each one when called. */
const CASE_ACTIONS: Action[] = [
  'case.edit_attributes',
  'case.import_geometry',
  'case.edit_rights',
  'case.upload_document',
  'case.verify_document',
  'case.validate',
  'case.submit',
  'case.withdraw',
  'case.acknowledge_finding',
  'case.decide',
  'case.publish',
];

// ---------------------------------------------------------------------------
// List and create
// ---------------------------------------------------------------------------

const listQuery = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  countyId: z.coerce.number().int().optional(),
});

casesRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const scope = scopeFor(req.auth!.principal, 'case.view');
  if (scope !== 'all' && scope.length === 0) {
    enforce(req, 'case.view', { countyId: q.countyId ?? null }, { entityType: 'case' });
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.case_no, c.case_type, c.status, c.county_id, co.code AS county_code, co.name AS county_name,
            c.proposed_upi, p.upi AS parcel_upi, u.username AS created_by_username, c.created_at, c.updated_at
       FROM lais.land_case c
       JOIN lais.county co ON co.id = c.county_id
       JOIN lais.app_user u ON u.id = c.created_by
       LEFT JOIN lais.parcel p ON p.id = c.parcel_id
      WHERE ($1::smallint[] IS NULL OR c.county_id = ANY($1))
        AND ($2::text IS NULL OR c.status = $2)
        AND ($3::smallint IS NULL OR c.county_id = $3)
      ORDER BY c.updated_at DESC
      LIMIT 500`,
    [scope === 'all' ? null : scope, q.status ?? null, q.countyId ?? null],
  );
  res.json(rows);
});

const createBody = z.discriminatedUnion('caseType', [
  z.object({
    caseType: z.literal('first_registration'),
    countyId: z.number().int(),
    landCategory: z.enum(LAND_CATEGORIES).optional(),
    landUse: z.string().max(100).optional(),
    sourceReference: z.string().max(200).optional(),
    proposedUpi: z.string().regex(PROVISIONAL_UPI_PATTERN).optional(),
  }),
  z.object({
    caseType: z.literal('transfer'),
    parcelUpi: z.string().min(1).max(40),
    sourceReference: z.string().max(200).optional(),
  }),
  z.object({
    caseType: z.literal('subdivision'),
    parcelUpi: z.string().min(1).max(40),
    sourceReference: z.string().max(200).optional(),
  }),
  z.object({
    caseType: z.literal('confirmation'),
    parcelUpi: z.string().min(1).max(40),
    sourceReference: z.string().max(200).optional(),
  }),
  z.object({
    caseType: z.literal('migration'),
    countyId: z.number().int(),
    sourceReference: z.string().max(200).optional(),
  }),
  z.object({
    caseType: z.literal('correction'),
    parcelUpi: z.string().min(1).max(40),
    correctionReason: z.string().trim().max(2000).optional(),
  }),
  z.object({
    caseType: z.literal('consolidation'),
    parcelUpis: z.array(z.string().min(1).max(40)).min(2).max(20),
    sourceReference: z.string().max(200).optional(),
  }),
]);

casesRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const created = await tx(async (client) => {
    let countyId: number;
    let parcelId: string | null = null;
    let sourceIds: string[] = [];
    let landCategory: string | null = null;
    let landUse: string | null = null;
    let sourceReference: string | null = body.caseType === 'correction' ? null : body.sourceReference ?? null;
    let areaSurveyed: string | null = null;

    if (body.caseType === 'first_registration' || body.caseType === 'migration') {
      countyId = body.countyId;
      const exists = await client.query('SELECT 1 FROM lais.county WHERE id = $1', [countyId]);
      if (!exists.rows[0]) throw badRequest('Unknown county');
      if (body.caseType === 'first_registration') {
        landCategory = body.landCategory ?? null;
        landUse = body.landUse ?? null;
      }
    } else {
      // Jurisdiction comes from the published parcels, not from the request.
      const upis = body.caseType === 'consolidation' ? [...new Set(body.parcelUpis)] : [body.parcelUpi];
      if (body.caseType === 'consolidation' && upis.length < 2) throw badRequest('List at least two different parcels to merge');
      const { rows: parcels } = await client.query(
        `SELECT p.id, p.upi, p.county_id, p.status, v.land_category, v.land_use, v.source_reference, v.area_m2_surveyed
           FROM lais.parcel p LEFT JOIN lais.parcel_version v ON v.id = p.current_version_id
          WHERE p.upi = ANY($1)`,
        [upis],
      );
      const missing = upis.filter((u) => !parcels.some((p) => p.upi === u));
      if (missing.length) throw notFound(`No published parcel has the identifier ${missing.join(', ')}`);
      const retired = parcels.filter((p) => p.status === 'retired');
      if (retired.length) throw conflict(`Parcel ${retired.map((p) => p.upi).join(', ')} is retired`);
      if (new Set(parcels.map((p) => p.county_id)).size > 1) throw badRequest('All parcels in a case must be in the same county');
      countyId = parcels[0].county_id;
      if (body.caseType === 'transfer' || body.caseType === 'confirmation') {
        parcelId = parcels[0].id;
      } else if (body.caseType === 'correction') {
        // A correction starts from the current record; officers change only what is wrong.
        parcelId = parcels[0].id;
        landCategory = parcels[0].land_category;
        landUse = parcels[0].land_use;
        sourceReference = parcels[0].source_reference;
        areaSurveyed = parcels[0].area_m2_surveyed;
      } else {
        sourceIds = parcels.map((p) => p.id);
        // New parcels start with the category and use of their source; officers can change them before submitting.
        landCategory = parcels[0].land_category;
        landUse = parcels[0].land_use;
      }
    }
    enforce(req, 'case.create', { countyId }, { entityType: 'case' });
    const { rows: [county] } = await client.query('SELECT name, enabled FROM lais.county WHERE id = $1', [countyId]);
    if (!county.enabled) throw conflict(`${county.name} is not enabled for operations yet; an administrator must configure its boundary and enable it`);

    const { rows: [cs] } = await client.query(
      `INSERT INTO lais.land_case (case_type, county_id, parcel_id, land_category, land_use, source_reference, proposed_upi, created_by,
                                   correction_reason, area_m2_surveyed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, case_no`,
      [
        body.caseType,
        countyId,
        parcelId,
        landCategory,
        landUse,
        sourceReference,
        body.caseType === 'first_registration' ? body.proposedUpi ?? null : null,
        req.auth!.user.id,
        body.caseType === 'correction' ? body.correctionReason || null : null,
        areaSurveyed,
      ],
    );
    for (const sourceId of sourceIds) {
      await client.query('INSERT INTO lais.case_source_parcel (case_id, parcel_id) VALUES ($1, $2)', [cs.id, sourceId]);
    }
    await recordEvent(client, cs.id, req.auth!.user.id, 'create', null, null, 'draft');
    await writeAudit(req, { action: 'case.create', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId, detail: { caseNo: cs.case_no, caseType: body.caseType } }, client);
    return cs;
  });
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Case detail
// ---------------------------------------------------------------------------

casesRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const cs = await getCase(pool, id);
  const ctx = await caseContext(pool, cs);
  enforce(req, 'case.view', ctx, { entityType: 'case', entityId: cs.id, caseId: cs.id });
  const principal = req.auth!.principal;

  const [county, events, rights, documents, staged, parcel, decisions, validation] = await Promise.all([
    pool.query('SELECT id, code, name FROM lais.county WHERE id = $1', [cs.county_id]),
    pool.query(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.at, u.username AS actor
         FROM lais.case_event e LEFT JOIN lais.app_user u ON u.id = e.actor_id
        WHERE e.case_id = $1 ORDER BY e.id`,
      [cs.id],
    ),
    pool.query(
      `SELECT r.id, r.rrr_type, r.share_num, r.share_den, r.feature_index, p.id AS party_id, p.name AS party_name, p.party_type, p.identity_status
         FROM lais.case_right_proposal r JOIN lais.party p ON p.id = r.party_id
        WHERE r.case_id = $1 ORDER BY r.feature_index NULLS FIRST, r.created_at`,
      [cs.id],
    ),
    pool.query(
      `SELECT d.id, d.doc_type, d.reference_no, d.issuer, d.issued_on, d.classification, d.mime_type, d.size_bytes,
              d.original_name, d.sha256, d.verification_status, d.verification_note, d.uploaded_at, d.verified_at,
              d.uploaded_by, uu.username AS uploaded_by_username, vu.username AS verified_by_username
         FROM lais.document d
         JOIN lais.app_user uu ON uu.id = d.uploaded_by
         LEFT JOIN lais.app_user vu ON vu.id = d.verified_by
        WHERE d.case_id = $1 ORDER BY d.uploaded_at`,
      [cs.id],
    ),
    pool.query(
      `SELECT b.id AS batch_id, b.source_filename, b.declared_srid, b.created_at, u.username AS uploaded_by,
              coalesce((SELECT json_agg(json_build_object(
                         'index', f.feature_index,
                         'properties', f.properties,
                         'excluded', f.excluded,
                         'exclusion_reason', f.exclusion_reason,
                         'published_upi', (SELECT upi FROM lais.parcel WHERE id = f.published_parcel_id),
                         'structural_ok', f.structural_ok,
                         'structural_message', f.structural_message,
                         'geometry', ST_AsGeoJSON(coalesce(f.geom, ST_Transform(f.geom_input, 4326)), 7)::json,
                         'area_m2', CASE WHEN f.geom IS NOT NULL THEN round(ST_Area(f.geom::geography)::numeric, 2) END)
                         ORDER BY f.feature_index)
                         FROM staging.feature f WHERE f.batch_id = b.id), '[]'::json) AS features
         FROM staging.batch b
         JOIN lais.app_user u ON u.id = b.uploaded_by
        WHERE b.case_id = $1 AND b.status IN ('active', 'published')
        ORDER BY b.created_at DESC LIMIT 1`,
      [cs.id],
    ),
    cs.parcel_id
      ? pool.query(
          `SELECT p.id, p.upi, p.status, v.version_no, v.land_category, v.land_use, v.area_m2_calculated, v.area_m2_surveyed, v.source_reference,
                  ST_AsGeoJSON(v.geom, 7)::json AS geometry,
                  coalesce((SELECT json_agg(json_build_object('rrrType', r.rrr_type, 'share', CASE WHEN r.share_den IS NULL THEN NULL ELSE r.share_num || '/' || r.share_den END,
                                                    'partyName', pa.name, 'partyType', pa.party_type, 'interestStatus', r.interest_status))
                              FROM lais.rrr r JOIN lais.party pa ON pa.id = r.party_id
                             WHERE r.parcel_id = p.id AND r.valid_to IS NULL), '[]'::json) AS current_rights
             FROM lais.parcel p JOIN lais.parcel_version v ON v.id = p.current_version_id
            WHERE p.id = $1`,
          [cs.parcel_id],
        )
      : Promise.resolve({ rows: [] as any[] }),
    pool.query(
      `SELECT d.id, d.decision, d.reason, d.authority_basis, d.snapshot_hash, d.decided_at, d.superseded_at, u.username AS decided_by
         FROM lais.case_decision d JOIN lais.app_user u ON u.id = d.decided_by
        WHERE d.case_id = $1 ORDER BY d.decided_at`,
      [cs.id],
    ),
    latestRun(pool, cs.id),
  ]);

  // Parcels a subdivision or consolidation replaces, and the parcels it created once published.
  const { rows: sources } = await pool.query(
    `SELECT p.id, p.upi, p.status, v.land_category, v.land_use, v.area_m2_calculated,
            ST_AsGeoJSON(v.geom, 7)::json AS geometry,
            coalesce((SELECT json_agg(json_build_object('rrrType', r.rrr_type, 'share', CASE WHEN r.share_den IS NULL THEN NULL ELSE r.share_num || '/' || r.share_den END,
                                              'partyName', pa.name, 'partyType', pa.party_type, 'interestStatus', r.interest_status, 'ended', r.valid_to IS NOT NULL))
                        FROM lais.rrr r JOIN lais.party pa ON pa.id = r.party_id
                       WHERE r.parcel_id = p.id AND (r.valid_to IS NULL OR r.ended_by_case = $1)), '[]'::json) AS current_rights
       FROM lais.case_source_parcel s
       JOIN lais.parcel p ON p.id = s.parcel_id
       JOIN lais.parcel_version v ON v.id = p.current_version_id
      WHERE s.case_id = $1 ORDER BY p.upi`,
    [cs.id],
  );
  const { rows: children } = await pool.query(
    `SELECT DISTINCT p.upi, p.status FROM lais.parcel_lineage l JOIN lais.parcel p ON p.id = l.child_parcel_id
      WHERE l.case_id = $1 ORDER BY p.upi`,
    [cs.id],
  );

  const allowedActions = CASE_ACTIONS.filter((a) => authorize(principal, a, ctx).allowed);
  const canRead = (classification: string) =>
    classification === 'public' ||
    authorize(principal, classification === 'restricted' ? 'document.view_restricted' : 'document.view_highly_sensitive', ctx).allowed;
  const registrarHere = principal.grants.some((g) => g.role === 'registrar' && g.countyId === cs.county_id);
  const separationNotice = registrarHere && ctx.contributorIds!.includes(principal.userId)
    ? 'You contributed to this case, so another registrar must review and decide it.'
    : null;

  res.json({
    case: { ...cs, county: county.rows[0] },
    events: events.rows,
    rights: rights.rows,
    documents: documents.rows.map(({ uploaded_by, ...d }) => ({
      ...d,
      canDownload: canRead(d.classification),
      canVerify: allowedActions.includes('case.verify_document') && d.verification_status === 'pending' && uploaded_by !== principal.userId,
    })),
    staged: staged.rows[0] ?? null,
    parcel: parcel.rows[0] ?? null,
    sources,
    children,
    decisions: decisions.rows,
    validation,
    allowedActions,
    separationNotice,
  });
});

// ---------------------------------------------------------------------------
// Preparation (draft / returned)
// ---------------------------------------------------------------------------

const attributesBody = z.object({
  landCategory: z.enum(LAND_CATEGORIES).nullable().optional(),
  landUse: z.string().max(100).nullable().optional(),
  sourceReference: z.string().max(200).nullable().optional(),
  proposedUpi: z.string().regex(PROVISIONAL_UPI_PATTERN, 'Use the provisional pattern PROV-XX-000000').nullable().optional(),
  correctionReason: z.string().trim().max(2000).nullable().optional(),
  areaM2Surveyed: z.number().positive().max(1e10).nullable().optional(),
});

casesRouter.patch('/:id', async (req, res) => {
  const body = attributesBody.parse(req.body);
  await inCaseTx(req, 'case.edit_attributes', async (client, cs) => {
    if ((cs.case_type === 'transfer' || cs.case_type === 'confirmation') && (body.landCategory !== undefined || body.landUse !== undefined || body.proposedUpi !== undefined)) {
      throw badRequest('This case changes interests only, not the parcel category, land use or identifier');
    }
    if (cs.case_type === 'migration' && (body.landCategory !== undefined || body.landUse !== undefined)) {
      throw badRequest('In a migration, land category and use come from each feature in the file');
    }
    if (cs.case_type !== 'first_registration' && body.proposedUpi) {
      throw badRequest('Only a first registration can propose an identifier');
    }
    if (cs.case_type !== 'correction' && (body.correctionReason !== undefined || body.areaM2Surveyed !== undefined)) {
      throw badRequest('Correction reason and surveyed area apply only to correction cases');
    }
    const next = {
      land_category: body.landCategory !== undefined ? body.landCategory : cs.land_category,
      land_use: body.landUse !== undefined ? body.landUse : cs.land_use,
      source_reference: body.sourceReference !== undefined ? body.sourceReference : cs.source_reference,
      proposed_upi: body.proposedUpi !== undefined ? body.proposedUpi : cs.proposed_upi,
      correction_reason: body.correctionReason !== undefined ? body.correctionReason : cs.correction_reason,
      area_m2_surveyed: body.areaM2Surveyed !== undefined ? body.areaM2Surveyed : cs.area_m2_surveyed,
    };
    await client.query(
      `UPDATE lais.land_case SET land_category = $2, land_use = $3, source_reference = $4, proposed_upi = $5,
                                 correction_reason = $6, area_m2_surveyed = $7 WHERE id = $1`,
      [cs.id, next.land_category, next.land_use, next.source_reference, next.proposed_upi, next.correction_reason, next.area_m2_surveyed],
    );
    // Record only the fields whose value actually changed.
    const asText = (v: unknown) => (v === null || v === undefined ? null : String(Number(v) || v));
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => asText(next[k]) !== asText(cs[k]));
    if (changed.length > 0) {
      await recordEvent(client, cs.id, req.auth!.user.id, 'update_attributes', changed.map((k) => k.replace(/_/g, ' ')).join(', '));
      await writeAudit(req, { action: 'case.update_attributes', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { fields: changed } }, client);
    }
  });
  res.json({ ok: true });
});

casesRouter.post('/:id/geometry', geojsonUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach a GeoJSON file');
  const srid = Number(req.body?.crs);
  if (!ACCEPTED_SRIDS[srid]) {
    throw badRequest(`Declare the coordinate reference system. Accepted: ${Object.entries(ACCEPTED_SRIDS).map(([k, v]) => `EPSG:${k} (${v})`).join('; ')}`);
  }

  const result = await inCaseTx(req, 'case.import_geometry', async (client, cs) => {
    const features = extractFeatures(req.file!.buffer.toString('utf8'), srid, FEATURE_LIMITS[cs.case_type]);

    await client.query(`UPDATE staging.batch SET status = 'superseded' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
    const { rows: [batch] } = await client.query(
      `INSERT INTO staging.batch (case_id, uploaded_by, source_filename, file_sha256, declared_srid, feature_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
      [cs.id, req.auth!.user.id, req.file!.originalname.slice(0, 200), createHash('sha256').update(req.file!.buffer).digest('hex'), srid, features.length],
    );

    const problems: (string | null)[] = [];
    for (const [index, { geometry, properties }] of features.entries()) {
      const label = features.length > 1 ? `Feature ${index + 1}: ` : '';
      let structural;
      try {
        ({ rows: [structural] } = await client.query(
          `WITH g AS (SELECT ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1), $2)) AS gi)
           SELECT gi, GeometryType(gi) AS gtype, ST_IsEmpty(gi) AS empty, ST_IsValid(gi) AS valid, ST_IsValidReason(gi) AS reason,
                  ST_XMin(gi) AS xmin, ST_XMax(gi) AS xmax, ST_YMin(gi) AS ymin, ST_YMax(gi) AS ymax FROM g`,
          [JSON.stringify(geometry), srid],
        ));
      } catch {
        throw badRequest(`${label}The geometry could not be read as GeoJSON`);
      }
      let problem: string | null = null;
      if (!['POLYGON', 'MULTIPOLYGON'].includes(structural.gtype)) problem = `Expected a Polygon or MultiPolygon, got ${structural.gtype}`;
      else if (structural.empty) problem = 'The geometry is empty';
      else if (!structural.valid) problem = structural.reason;
      else if (srid === 4326 && (structural.xmin < -180 || structural.xmax > 180 || structural.ymin < -90 || structural.ymax > 90)) {
        problem = 'Coordinates are outside the valid longitude/latitude range for EPSG:4326; check the declared CRS';
      }
      problems.push(problem && `${label}${problem}`);

      await client.query(
        `INSERT INTO staging.feature (batch_id, feature_index, geom_input, geom, structural_ok, structural_message, properties)
         VALUES ($1, $2, $3::geometry, CASE WHEN $4 THEN ST_Multi(ST_Transform($3::geometry, 4326)) END, $4, $5, $6)`,
        [batch.id, index, structural.gi, problem === null, problem, JSON.stringify(properties)],
      );
    }

    const invalid = problems.filter((p): p is string => p !== null);
    await recordEvent(client, cs.id, req.auth!.user.id, 'import_geometry', `${req.file!.originalname} (EPSG:${srid}, ${features.length} feature(s))`);
    await writeAudit(req, {
      action: 'staging.import', outcome: invalid.length ? 'failure' : 'success', entityType: 'staging_batch', entityId: batch.id, caseId: cs.id, countyId: cs.county_id,
      detail: { srid, filename: req.file!.originalname, featureCount: features.length, structuralProblems: invalid },
    }, client);
    return { batchId: batch.id, featureCount: features.length, structuralOk: invalid.length === 0, problem: invalid.join('; ') || null };
  });
  res.status(201).json(result);
});

const exclusionBody = z.object({
  excluded: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Migration quarantine: a GIS officer excludes a problem feature (with a reason) so the rest of the batch
 * can proceed, or includes it again. Excluded features are reported but never published.
 */
casesRouter.post('/:id/features/:index/exclusion', async (req, res) => {
  const index = z.coerce.number().int().min(0).max(999).parse(req.params.index);
  const body = exclusionBody.parse(req.body);
  if (body.excluded && (!body.reason || body.reason.length < 5)) throw badRequest('Give a reason for excluding the feature (5+ characters)');
  await inCaseTx(req, 'case.import_geometry', async (client, cs) => {
    if (cs.case_type !== 'migration') throw badRequest('Only features of a migration batch can be excluded');
    const { rowCount } = await client.query(
      `UPDATE staging.feature f SET excluded = $3, exclusion_reason = $4
         FROM staging.batch b
        WHERE b.id = f.batch_id AND b.case_id = $1 AND b.status = 'active' AND f.feature_index = $2`,
      [cs.id, index, body.excluded, body.excluded ? body.reason : null],
    );
    if (!rowCount) throw notFound('No such feature in the active batch');
    const note = body.excluded ? `Feature ${index + 1} excluded: ${body.reason}` : `Feature ${index + 1} included again`;
    await recordEvent(client, cs.id, req.auth!.user.id, 'update_attributes', note);
    await writeAudit(req, { action: 'staging.feature_exclusion', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { featureIndex: index, excluded: body.excluded, reason: body.reason ?? null } }, client);
  });
  res.json({ ok: true });
});

/**
 * Reconciliation report for a migration batch: one row per imported feature with its outcome,
 * so feature counts can be checked before and after processing.
 */
casesRouter.get('/:id/migration-report.csv', async (req, res) => {
  const id = parseId(req.params.id);
  const cs = await getCase(pool, id);
  enforce(req, 'case.view', await caseContext(pool, cs), { entityType: 'case', entityId: cs.id, caseId: cs.id });
  if (cs.case_type !== 'migration') throw badRequest('Only migration cases have a reconciliation report');

  const { rows: features } = await pool.query(
    `SELECT f.feature_index, f.properties, f.excluded, f.exclusion_reason, f.structural_ok, p.upi AS published_upi,
            CASE WHEN f.geom IS NOT NULL THEN round(ST_Area(f.geom::geography)::numeric, 2) END AS area_m2
       FROM staging.batch b JOIN staging.feature f ON f.batch_id = b.id
       LEFT JOIN lais.parcel p ON p.id = f.published_parcel_id
      WHERE b.case_id = $1 AND b.status IN ('active', 'published')
      ORDER BY f.feature_index`,
    [cs.id],
  );
  const latest = await latestRun(pool, cs.id);
  const findingsFor = (i: number, severity: string) =>
    (latest?.findings ?? []).filter((f) => f.feature_index === i && f.severity === severity);

  const header = ['feature', 'legacy_ref', 'land_category', 'holders', 'calculated_area_m2', 'outcome', 'upi', 'errors', 'warnings', 'notes'];
  const lines = [header.map(csvCell).join(',')];
  for (const f of features) {
    const errors = findingsFor(f.feature_index, 'error');
    const warnings = findingsFor(f.feature_index, 'warning');
    const outcome = f.published_upi ? 'published' : f.excluded ? 'excluded' : errors.length ? 'error' : warnings.length ? 'warning' : 'ready';
    lines.push([
      f.feature_index + 1, f.properties.legacy_ref, f.properties.land_category, f.properties.holder_names, f.area_m2,
      outcome, f.published_upi, errors.map((e) => e.code).join(' '), warnings.map((w) => w.code).join(' '),
      f.excluded ? f.exclusion_reason : [...errors, ...warnings].map((x) => x.message).join(' | '),
    ].map(csvCell).join(','));
  }
  const totals = features.reduce((acc: Record<string, number>, f) => {
    const k = f.published_upi ? 'published' : f.excluded ? 'excluded' : 'pending';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  lines.push('', `"# ${features.length} feature(s) imported: ${Object.entries(totals).map(([k, v]) => `${v} ${k}`).join(', ')}"`);

  await writeAudit(req, { action: 'case.migration_report', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${cs.case_no}-reconciliation.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n'));
});

const rightBody = z.object({
  partyId: z.string().uuid(),
  rrrType: z.enum(RRR_TYPES),
  shareNum: z.number().int().positive().optional(),
  shareDen: z.number().int().positive().optional(),
  /** Subdivision only: which new parcel (0-based, in import order) the interest applies to. */
  featureIndex: z.number().int().min(0).max(49).optional(),
}).refine((b) => (b.shareNum === undefined) === (b.shareDen === undefined), 'Give both share numerator and denominator, or neither')
  .refine((b) => b.shareNum === undefined || b.shareNum <= b.shareDen!, 'A share cannot exceed the whole');

casesRouter.post('/:id/rights', async (req, res) => {
  const body = rightBody.parse(req.body);
  const created = await inCaseTx(req, 'case.edit_rights', async (client, cs) => {
    if (cs.case_type === 'subdivision' && body.featureIndex === undefined) throw badRequest('Choose which new parcel this interest applies to');
    if (cs.case_type !== 'subdivision' && body.featureIndex !== undefined) throw badRequest('This case creates or changes a single parcel');
    const { rows: [party] } = await client.query('SELECT id, name FROM lais.party WHERE id = $1', [body.partyId]);
    if (!party) throw badRequest('Unknown party');
    const { rows: [row] } = await client.query(
      `INSERT INTO lais.case_right_proposal (case_id, party_id, rrr_type, share_num, share_den, feature_index, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [cs.id, body.partyId, body.rrrType, body.shareNum ?? null, body.shareDen ?? null, body.featureIndex ?? null, req.auth!.user.id],
    );
    const target = body.featureIndex === undefined ? '' : ` on new parcel ${body.featureIndex + 1}`;
    await recordEvent(client, cs.id, req.auth!.user.id, 'propose_right', `${body.rrrType} for ${party.name}${target}`);
    await writeAudit(req, { action: 'case.propose_right', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { partyId: body.partyId, rrrType: body.rrrType, featureIndex: body.featureIndex ?? null } }, client);
    return row;
  });
  res.status(201).json(created);
});

/**
 * Subdivision convenience: proposes the parent's current ownership-type interests on every new parcel.
 * Encumbrances are not copied; whether a mortgage or lease continues on each part needs its own evidence.
 */
casesRouter.post('/:id/rights/copy-from-source', async (req, res) => {
  const result = await inCaseTx(req, 'case.edit_rights', async (client, cs) => {
    if (cs.case_type !== 'subdivision') throw badRequest('Only a subdivision copies interests from its source parcel');
    const { rows: [batch] } = await client.query(`SELECT feature_count FROM staging.batch WHERE case_id = $1 AND status = 'active'`, [cs.id]);
    if (!batch) throw conflict('Import the new parcel geometries first');
    const existing = await client.query('SELECT 1 FROM lais.case_right_proposal WHERE case_id = $1 LIMIT 1', [cs.id]);
    if (existing.rows[0]) throw conflict('Remove the interests already proposed before copying from the source parcel');
    const { rowCount } = await client.query(
      `INSERT INTO lais.case_right_proposal (case_id, party_id, rrr_type, share_num, share_den, feature_index, created_by)
       SELECT $1, r.party_id, r.rrr_type, r.share_num, r.share_den, i, $3
         FROM lais.case_source_parcel s
         JOIN lais.rrr r ON r.parcel_id = s.parcel_id AND r.valid_to IS NULL AND r.rrr_type = ANY($4)
         CROSS JOIN generate_series(0, $2 - 1) AS i
        WHERE s.case_id = $1`,
      [cs.id, batch.feature_count, req.auth!.user.id, OWNERSHIP_TYPES],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'propose_right', `Copied source ownership to ${batch.feature_count} new parcels`);
    await writeAudit(req, { action: 'case.propose_right', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { copiedFromSource: true, rows: rowCount } }, client);
    return { created: rowCount };
  });
  res.status(201).json(result);
});

casesRouter.delete('/:id/rights/:rightId', async (req, res) => {
  const rightId = parseId(req.params.rightId);
  await inCaseTx(req, 'case.edit_rights', async (client, cs) => {
    const { rowCount } = await client.query('DELETE FROM lais.case_right_proposal WHERE id = $1 AND case_id = $2', [rightId, cs.id]);
    if (!rowCount) throw notFound('Proposed right not found on this case');
    await recordEvent(client, cs.id, req.auth!.user.id, 'remove_right');
    await writeAudit(req, { action: 'case.remove_right', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { rightId } }, client);
  });
  res.json({ ok: true });
});

const documentFields = z.object({
  // Checked against the active document categories below.
  docType: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  classification: z.enum(CLASSIFICATIONS),
  referenceNo: z.string().max(100).optional(),
  issuer: z.string().max(200).optional(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
});

casesRouter.post('/:id/documents', documentUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  const fields = documentFields.parse(req.body ?? {});
  const { rows: [category] } = await pool.query('SELECT active FROM lais.document_category WHERE code = $1', [fields.docType]);
  if (!category?.active) throw badRequest('Unknown or inactive document category');
  const mime = detectDocumentType(req.file.buffer);
  if (!mime) throw badRequest('Only PDF, PNG and JPEG files are accepted');
  if (fields.docType === 'id_document' && fields.classification !== 'highly_sensitive') {
    throw badRequest('Identity documents must be classified as highly sensitive');
  }

  const storageKey = randomBytes(16).toString('hex');
  const filePath = path.join(config.documentStorageDir, storageKey);
  try {
    const created = await inCaseTx(req, 'case.upload_document', async (client, cs) => {
      // Malware scanning would plug in here before the file is accepted (not implemented in the prototype).
      await fs.mkdir(config.documentStorageDir, { recursive: true });
      await fs.writeFile(filePath, req.file!.buffer, { flag: 'wx' });
      const sha256 = createHash('sha256').update(req.file!.buffer).digest('hex');
      const { rows: [doc] } = await client.query(
        `INSERT INTO lais.document (case_id, doc_type, reference_no, issuer, issued_on, classification, storage_key, sha256, mime_type, size_bytes, original_name, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [cs.id, fields.docType, fields.referenceNo ?? null, fields.issuer ?? null, fields.issuedOn ?? null, fields.classification,
          storageKey, sha256, mime, req.file!.size, req.file!.originalname.slice(0, 200), req.auth!.user.id],
      );
      await recordEvent(client, cs.id, req.auth!.user.id, 'upload_document', `${fields.docType} ${fields.referenceNo ?? ''}`.trim());
      await writeAudit(req, { action: 'document.upload', outcome: 'success', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id, detail: { docType: fields.docType, classification: fields.classification, sha256 } }, client);
      return doc;
    });
    res.status(201).json(created);
  } catch (err) {
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  }
});

const verifyBody = z.object({ status: z.enum(['verified', 'rejected']), note: z.string().min(5).max(1000) });

casesRouter.post('/:id/documents/:docId/verify', async (req, res) => {
  const docId = parseId(req.params.docId);
  const body = verifyBody.parse(req.body);
  await inCaseTx(req, 'case.verify_document', async (client, cs) => {
    const { rows: [doc] } = await client.query('SELECT * FROM lais.document WHERE id = $1 AND case_id = $2 FOR UPDATE', [docId, cs.id]);
    if (!doc) throw notFound('Document not found on this case');
    if (doc.verification_status !== 'pending') throw conflict('This document has already been checked');
    if (doc.uploaded_by === req.auth!.user.id) {
      throw new HttpError(403, 'Separation of duties: the officer who uploaded a document cannot verify it').withAudit({
        action: 'authz.denied', outcome: 'denied', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id,
        detail: { requestedAction: 'case.verify_document', reason: 'uploader_cannot_verify' },
      });
    }
    await client.query(
      `UPDATE lais.document SET verification_status = $2, verified_by = $3, verified_at = now(), verification_note = $4 WHERE id = $1`,
      [doc.id, body.status, req.auth!.user.id, body.note],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'verify_document', `${doc.doc_type}: ${body.status}`);
    await writeAudit(req, { action: 'document.verify', outcome: 'success', entityType: 'document', entityId: doc.id, caseId: cs.id, countyId: cs.county_id, detail: { result: body.status } }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Validation and submission
// ---------------------------------------------------------------------------

casesRouter.post('/:id/validate', async (req, res) => {
  const result = await inCaseTx(req, 'case.validate', async (client, cs) => {
    const evaluation = await evaluateCase(client, cs);
    const runId = await persistRun(client, cs, evaluation, req.auth!.user.id, 'preview');
    await writeAudit(req, { action: 'case.validate', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id, detail: { runId, findings: evaluation.findings.length } }, client);
    return { runId, findings: evaluation.findings };
  });
  res.json(result);
});

casesRouter.post('/:id/submit', async (req, res) => {
  const result = await inCaseTx(req, 'case.submit', async (client, cs) => {
    const actor = req.auth!.user.id;
    const validating = await setStatus(client, cs, 'validating', actor, 'submit');
    const evaluation = await evaluateCase(client, validating);
    const runId = await persistRun(client, validating, evaluation, actor, 'submission');
    const errors = evaluation.findings.filter((f) => f.severity === 'error');
    const next = errors.length > 0
      ? await setStatus(client, validating, 'returned', null, 'validation_failed', `${errors.length} blocking error(s)`)
      : await setStatus(client, validating, 'under_review', null, 'validation_passed');
    if (next.status === 'returned' && cs.created_by !== actor) {
      await notifyUsers(client, [cs.created_by], { category: 'workflow', title: `${cs.case_no} was returned by validation`, body: `${errors.length} blocking error(s) to correct`, link: `/work/cases/${cs.id}` });
    }
    await writeAudit(req, {
      action: 'case.submit', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { runId, result: next.status, errors: errors.length, warnings: evaluation.findings.length - errors.length },
    }, client);
    return { status: next.status, findings: evaluation.findings };
  });
  res.json(result);
});

const withdrawBody = z.object({ reason: z.string().min(5).max(1000) });

casesRouter.post('/:id/withdraw', async (req, res) => {
  const { reason } = withdrawBody.parse(req.body);
  await inCaseTx(req, 'case.withdraw', async (client, cs) => {
    await setStatus(client, cs, 'withdrawn', req.auth!.user.id, 'withdraw', reason);
    await client.query(`UPDATE staging.batch SET status = 'superseded' WHERE case_id = $1 AND status = 'active'`, [cs.id]);
    await writeAudit(req, { action: 'case.withdraw', outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id }, client);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Review, decision and publication (registrar)
// ---------------------------------------------------------------------------

const ackBody = z.object({ note: z.string().min(5).max(1000) });

casesRouter.post('/:id/findings/:findingId/acknowledge', async (req, res) => {
  const findingId = parseId(req.params.findingId);
  const { note } = ackBody.parse(req.body);
  await inCaseTx(req, 'case.acknowledge_finding', async (client, cs) => {
    const latest = await latestRun(client, cs.id);
    const finding = latest?.findings.find((f) => f.id === findingId);
    if (!finding) throw notFound('Finding not found in the latest validation run');
    if (finding.severity !== 'warning') throw conflict('Errors cannot be acknowledged; the case must be returned for correction');
    if (finding.acknowledged_by) throw conflict('Already acknowledged');
    await client.query(
      'UPDATE staging.finding SET acknowledged_by = $2, acknowledged_at = now(), acknowledgement_note = $3 WHERE id = $1',
      [findingId, req.auth!.user.id, note],
    );
    await recordEvent(client, cs.id, req.auth!.user.id, 'acknowledge_finding', `${finding.code}: ${note}`);
    await writeAudit(req, { action: 'finding.acknowledge', outcome: 'success', entityType: 'finding', entityId: findingId, caseId: cs.id, countyId: cs.county_id, detail: { code: finding.code } }, client);
  });
  res.json({ ok: true });
});

const decisionBody = z.object({
  decision: z.enum(['approved', 'rejected', 'returned']),
  reason: z.string().trim().min(5).max(2000),
  authorityBasis: z.string().trim().min(3).max(300).optional(),
});

casesRouter.post('/:id/decision', async (req, res) => {
  const body = decisionBody.parse(req.body);
  const status = await inCaseTx(req, 'case.decide', async (client, cs) => {
    const latest = await latestRun(client, cs.id);
    if (!latest) throw conflict('The case has not been validated');
    if (body.decision === 'approved') {
      if (latest.findings.some((f) => f.severity === 'error')) throw conflict('The case has unresolved validation errors and cannot be approved');
      const open = latest.findings.filter((f) => f.severity === 'warning' && !f.acknowledged_by);
      if (open.length > 0) throw conflict(`Acknowledge all ${open.length} warning(s) with a note before approving`, { codes: open.map((f) => f.code) });
      if (!body.authorityBasis) throw badRequest('State the delegated authority under which you approve');
    }
    const snapshot = await computeSnapshot(client, cs);
    await client.query(
      `INSERT INTO lais.case_decision (case_id, decided_by, decision, reason, authority_basis, validation_run_id, snapshot_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cs.id, req.auth!.user.id, body.decision, body.reason, body.authorityBasis ?? null, latest.run.id, snapshot],
    );
    const next = await setStatus(client, cs, body.decision, req.auth!.user.id, 'decide', body.reason);
    await notifyUsers(client, [cs.created_by], { category: 'workflow', title: `${cs.case_no} was ${body.decision} by the registrar`, link: `/work/cases/${cs.id}` });
    await writeAudit(req, {
      action: `case.${body.decision === 'approved' ? 'approve' : body.decision === 'rejected' ? 'reject' : 'return'}`,
      outcome: 'success', entityType: 'case', entityId: cs.id, caseId: cs.id, countyId: cs.county_id,
      detail: { snapshot, validationRunId: latest.run.id, authorityBasis: body.authorityBasis ?? null },
    }, client);
    return next.status;
  });
  res.json({ status });
});

const publishBody = z.object({ simulateFailure: z.boolean().optional(), simulateDelayMs: z.number().int().min(0).max(5000).optional() }).default({});

casesRouter.post('/:id/publish', async (req, res) => {
  const body = publishBody.parse(req.body ?? {});
  const id = parseId(req.params.id);
  try {
    const outcome = await inCaseTx(req, 'case.publish', (client, cs) =>
      publishApprovedCase(client, req, cs, isTest ? { simulateFailure: body.simulateFailure, simulateDelayMs: body.simulateDelayMs } : {}),
    );
    if (!outcome.published) {
      return res.status(409).json({ error: `${outcome.reason}. Publication was refused and the case has been returned to review.`, findings: outcome.findings });
    }
    res.json(outcome);
  } catch (err) {
    if (!(err instanceof HttpError)) {
      // Everything in the publication transaction has rolled back; record the failed attempt separately.
      await writeAudit(req, { action: 'case.publish', outcome: 'failure', entityType: 'case', entityId: id, caseId: id, detail: { reason: 'transaction_rolled_back', error: (err as Error).message } });
    }
    throw err;
  }
});
