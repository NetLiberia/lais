import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool, tx } from './db.js';
import { hashPassword, passwordPolicyProblem } from './auth/password.js';
import { AREA_METHOD } from './services/publication.js';

/**
 * Loads SYNTHETIC demonstration data: two pilot counties with simplified rectangular
 * boundaries (not official boundaries), fictional parties, parcels and accounts.
 * None of it describes real land, people or records.
 */

const COUNTIES = [
  { id: 1, code: 'MO', name: 'Montserrado (synthetic pilot boundary)', bbox: [-10.85, 6.25, -10.6, 6.45] },
  { id: 2, code: 'MG', name: 'Margibi (synthetic pilot boundary)', bbox: [-10.6, 6.25, -10.3, 6.45] },
];

const USERS: { username: string; displayName: string; role: string; county: number | null }[] = [
  { username: 'admin', displayName: 'System Administrator (synthetic)', role: 'system_admin', county: null },
  { username: 'gis.mo', displayName: 'GIS Officer, Montserrado (synthetic)', role: 'gis_officer', county: 1 },
  { username: 'proc.mo', displayName: 'Processor A, Montserrado (synthetic)', role: 'processor', county: 1 },
  { username: 'proc2.mo', displayName: 'Processor B, Montserrado (synthetic)', role: 'processor', county: 1 },
  { username: 'reg.mo', displayName: 'Land Registrar, Montserrado (synthetic)', role: 'registrar', county: 1 },
  { username: 'gis.mg', displayName: 'GIS Officer, Margibi (synthetic)', role: 'gis_officer', county: 2 },
  { username: 'proc.mg', displayName: 'Processor, Margibi (synthetic)', role: 'processor', county: 2 },
  { username: 'reg.mg', displayName: 'Land Registrar, Margibi (synthetic)', role: 'registrar', county: 2 },
  { username: 'supervisor', displayName: 'National Supervisor (synthetic)', role: 'supervisor', county: null },
  { username: 'auditor', displayName: 'Independent Auditor (synthetic)', role: 'auditor', county: null },
  { username: 'owner.demo', displayName: 'Musu Testperson (synthetic landowner)', role: 'landowner', county: null },
];

const PARTIES = [
  { key: 'musu', type: 'person', name: 'Musu Testperson', id: 'SYN-ID-0001' },
  { key: 'joseph', type: 'person', name: 'Joseph Testperson', id: 'SYN-ID-0002' },
  { key: 'comfort', type: 'person', name: 'Comfort Testperson', id: 'SYN-ID-0003' },
  { key: 'varney', type: 'person', name: 'Varney Testperson', id: 'SYN-ID-0004' },
  { key: 'hawa', type: 'person', name: 'Hawa Testperson', id: 'SYN-ID-0005' },
  { key: 'community', type: 'community', name: 'Sample Clan Community (synthetic)', id: null },
  { key: 'ministry', type: 'government', name: 'Example Ministry (synthetic government entity)', id: null },
  { key: 'bank', type: 'organization', name: 'Sample Bank (synthetic)', id: null },
  { key: 'company', type: 'organization', name: 'Sample Trading Company (synthetic)', id: null },
  { key: 'unverified', type: 'person', name: 'Unverified Applicant (synthetic)', id: 'SYN-ID-0099', unverified: true },
];

type Right = { party: string; type: string; share?: [number, number] };
interface ParcelSeed { county: number; col: number; row: number; category: string; use: string; rights: Right[]; disputed?: boolean }

const MO_ORIGIN = [-10.8, 6.3];
const MG_ORIGIN = [-10.5, 6.3];
const CELL = 0.001; // ~110 m
const GAP = 0.0002;

const PARCELS: ParcelSeed[] = [
  { county: 1, col: 0, row: 0, category: 'private', use: 'residential', rights: [{ party: 'musu', type: 'ownership' }] },
  { county: 1, col: 1, row: 0, category: 'private', use: 'residential', rights: [{ party: 'joseph', type: 'co_ownership', share: [1, 2] }, { party: 'comfort', type: 'co_ownership', share: [1, 2] }] },
  { county: 1, col: 2, row: 0, category: 'customary', use: 'agricultural', rights: [{ party: 'community', type: 'customary_tenure' }] },
  { county: 1, col: 3, row: 0, category: 'government', use: 'institutional', rights: [{ party: 'ministry', type: 'ownership' }] },
  { county: 1, col: 0, row: 1, category: 'private', use: 'commercial', rights: [{ party: 'joseph', type: 'ownership' }, { party: 'bank', type: 'mortgage' }] },
  { county: 1, col: 1, row: 1, category: 'public', use: 'open space', rights: [{ party: 'ministry', type: 'ownership' }] },
  { county: 1, col: 2, row: 1, category: 'private', use: 'residential', rights: [{ party: 'comfort', type: 'ownership' }], disputed: true },
  { county: 1, col: 3, row: 1, category: 'private', use: 'commercial', rights: [{ party: 'company', type: 'ownership' }] },
  { county: 1, col: 0, row: 2, category: 'private', use: 'residential', rights: [{ party: 'varney', type: 'ownership' }] },
  { county: 1, col: 1, row: 2, category: 'private', use: 'residential', rights: [{ party: 'hawa', type: 'ownership' }] },
  { county: 1, col: 2, row: 2, category: 'private', use: 'agricultural', rights: [{ party: 'musu', type: 'ownership' }] },
  { county: 1, col: 3, row: 2, category: 'private', use: 'commercial', rights: [{ party: 'varney', type: 'ownership' }, { party: 'company', type: 'lease' }] },
  { county: 2, col: 0, row: 0, category: 'private', use: 'residential', rights: [{ party: 'hawa', type: 'ownership' }] },
  { county: 2, col: 1, row: 0, category: 'customary', use: 'forest', rights: [{ party: 'community', type: 'customary_tenure' }] },
  { county: 2, col: 2, row: 0, category: 'private', use: 'agricultural', rights: [{ party: 'joseph', type: 'ownership' }] },
];

const rect = ([minX, minY, maxX, maxY]: number[]) =>
  `MULTIPOLYGON(((${minX} ${minY},${maxX} ${minY},${maxX} ${maxY},${minX} ${maxY},${minX} ${minY})))`;

export async function seed(password: string, log = console.log): Promise<void> {
  await tx(async (client: pg.PoolClient) => {
    const existing = await client.query('SELECT count(*)::int AS n FROM lais.county');
    if (existing.rows[0].n > 0) throw new Error('Database already contains data. Use `npm run db:reset` for a clean development database.');

    for (const c of COUNTIES) {
      await client.query(
        `INSERT INTO lais.county (id, code, name, geom, is_synthetic) VALUES ($1, $2, $3, ST_GeomFromText($4, 4326), true)`,
        [c.id, c.code, c.name, rect(c.bbox)],
      );
    }

    const hash = await hashPassword(password);
    const userIds: Record<string, string> = {};
    for (const u of USERS) {
      const { rows: [row] } = await client.query(
        `INSERT INTO lais.app_user (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [u.username, u.displayName, hash],
      );
      userIds[u.username] = row.id;
    }
    for (const u of USERS) {
      await client.query(
        `INSERT INTO lais.role_assignment (user_id, role, county_id, grant_reason, granted_by) VALUES ($1, $2, $3, $4, $5)`,
        [userIds[u.username], u.role, u.county, 'Synthetic seed account', u.username === 'admin' ? null : userIds.admin],
      );
    }

    const partyIds: Record<string, string> = {};
    for (const p of PARTIES) {
      const verified = !('unverified' in p);
      const { rows: [row] } = await client.query(
        `INSERT INTO lais.party (party_type, name, national_id_ref, identity_status, verified_by, verified_at, verification_note, is_synthetic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id`,
        [p.type, p.name, p.id, verified ? 'verified' : 'unverified', verified ? userIds['proc.mo'] : null,
          verified ? new Date() : null, verified ? 'Synthetic seed party' : null],
      );
      partyIds[p.key] = row.id;
    }
    await client.query(
      'INSERT INTO lais.user_party_link (user_id, party_id, linked_by) VALUES ($1, $2, $3)',
      [userIds['owner.demo'], partyIds.musu, userIds['proc.mo']],
    );

    let seq = 1;
    for (const p of PARCELS) {
      const county = COUNTIES.find((c) => c.id === p.county)!;
      const [ox, oy] = p.county === 1 ? MO_ORIGIN : MG_ORIGIN;
      const x = ox + p.col * (CELL + GAP);
      const y = oy + p.row * (CELL + GAP);
      const upi = `PROV-${county.code}-${String(seq).padStart(6, '0')}`;
      const { rows: [parcel] } = await client.query(
        `INSERT INTO lais.parcel (upi, county_id, status, is_synthetic) VALUES ($1, $2, $3, true) RETURNING id`,
        [upi, p.county, p.disputed ? 'disputed' : 'active'],
      );
      const { rows: [version] } = await client.query(
        `INSERT INTO lais.parcel_version (parcel_id, version_no, geom, area_m2_calculated, area_method, land_category, land_use, source_reference)
         SELECT $1, 1, g, round(ST_Area(g::geography)::numeric, 2), $3, $4, $5, $6
           FROM (SELECT ST_GeomFromText($2, 4326) AS g) s RETURNING id`,
        [parcel.id, rect([x, y, x + CELL, y + CELL]), AREA_METHOD, p.category, p.use, `SYNTHETIC-SURVEY-${String(seq).padStart(4, '0')}`],
      );
      await client.query('UPDATE lais.parcel SET current_version_id = $2 WHERE id = $1', [parcel.id, version.id]);
      for (const r of p.rights) {
        await client.query(
          `INSERT INTO lais.rrr (parcel_id, party_id, rrr_type, share_num, share_den, interest_status) VALUES ($1, $2, $3, $4, $5, 'registered')`,
          [parcel.id, partyIds[r.party], r.type, r.share?.[0] ?? null, r.share?.[1] ?? null],
        );
      }
      if (p.disputed) {
        await client.query(
          `INSERT INTO lais.parcel_dispute (parcel_id, opened_by, reason, referral) VALUES ($1, $2, $3, $4)`,
          [parcel.id, userIds['reg.mo'], 'Synthetic example: competing boundary claim lodged by a neighbouring party', 'Synthetic referral to the authorized dispute-resolution body'],
        );
      }
      seq += 1;
    }

    await client.query(
      `INSERT INTO audit.event (actor_username, action, outcome, detail) VALUES ('system', 'system.seed', 'success', $1)`,
      [JSON.stringify({ counties: COUNTIES.length, users: USERS.length, parties: PARTIES.length, parcels: PARCELS.length, synthetic: true })],
    );
    log(`seeded ${COUNTIES.length} counties, ${USERS.length} users, ${PARTIES.length} parties, ${PARCELS.length} parcels (all synthetic)`);
  });
}

export const SEED_USERNAMES = USERS.map((u) => u.username);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.SEED_PASSWORD ?? '';
  const problem = passwordPolicyProblem(password);
  if (problem) {
    console.error(`Set SEED_PASSWORD in server/.env first (${problem}).`);
    process.exit(1);
  }
  seed(password)
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
