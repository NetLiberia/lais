import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { badRequest } from '../http.js';

/**
 * GeoPackage (OGC 12-128r18) reader. A GeoPackage is a SQLite file, read here with Node's built-in
 * SQLite (no native add-on, no GDAL). The upload is untrusted, so:
 *   - it is written to a fresh private temporary directory and deleted afterwards, whatever happens;
 *   - it is opened read-only, extensions cannot be loaded, and `trusted_schema` is off, so functions in
 *     views or triggers inside the file are not run;
 *   - only feature tables listed in gpkg_contents that exist as real tables are read, with quoted
 *     identifiers, and row counts are checked before reading.
 * The CRS comes from gpkg_spatial_ref_sys (an EPSG organisation code). Undefined systems (srs_id -1 or 0)
 * and other organisations are reported as unknown, so the officer must declare the CRS with a reason.
 * Geometry blobs are unwrapped to standard WKB, which PostGIS parses; nothing is repaired.
 */

export interface GpkgLayer {
  name: string;
  geometryColumn: string;
  geometryType: string;
  crs: { epsg: number | null; name: string | null };
  fields: { name: string; type: string }[];
  rows: { wkbHex: string | null; properties: Record<string, unknown> }[];
}

const SQLITE_MAGIC = 'SQLite format 3\0';
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** The WKB inside a GeoPackage geometry blob, or null for an empty or unreadable geometry. */
export function gpkgBlobToWkb(blob: Uint8Array): Uint8Array | null {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null; // "GP"
  const flags = blob[3];
  if (flags & 0b0010_0000) return null; // extended geometry types are not standard WKB
  if (flags & 0b0001_0000) return null; // empty geometry
  const envelope = ENVELOPE_BYTES[(flags >> 1) & 0b111];
  if (envelope === undefined) return null;
  const start = 8 + envelope;
  return blob.length > start ? blob.subarray(start) : null;
}

export async function readGeoPackage(buffer: Uint8Array, maxFeatures: number, maxLayers = 20): Promise<GpkgLayer[]> {
  if (buffer.length < 100 || Buffer.from(buffer.subarray(0, 16)).toString('latin1') !== SQLITE_MAGIC) {
    throw badRequest('The file is not a GeoPackage (it is not an SQLite database)');
  }
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw badRequest('GeoPackage files cannot be read on this server (its Node.js has no SQLite module). Export the layer to a zipped shapefile or GeoJSON.');
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'lais-gpkg-'));
  const file = path.join(dir, 'upload.gpkg');
  let db: InstanceType<typeof sqlite.DatabaseSync> | null = null;
  try {
    await writeFile(file, buffer, { mode: 0o600 });
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
      db.exec('PRAGMA trusted_schema = OFF');
    } catch {
      throw badRequest('The GeoPackage could not be opened (the file may be damaged)');
    }
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name),
    );
    if (!tables.has('gpkg_contents') || !tables.has('gpkg_geometry_columns') || !tables.has('gpkg_spatial_ref_sys')) {
      throw badRequest('The file is an SQLite database but not a GeoPackage (the gpkg_ tables are missing)');
    }
    const contents = db.prepare(
      `SELECT c.table_name, g.column_name, g.geometry_type_name, g.srs_id, s.organization, s.organization_coordsys_id, s.srs_name
         FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
         LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id
        WHERE c.data_type = 'features' ORDER BY c.table_name`,
    ).all() as { table_name: string; column_name: string; geometry_type_name: string; srs_id: number; organization: string | null; organization_coordsys_id: number | null; srs_name: string | null }[];
    const layers = contents.filter((c) => tables.has(c.table_name) && c.table_name.length <= 128 && c.column_name.length <= 128);
    if (layers.length === 0) throw badRequest('The GeoPackage contains no feature tables');
    if (layers.length > maxLayers) throw badRequest(`The GeoPackage has ${layers.length} feature tables; at most ${maxLayers} can be inspected at once`);

    return layers.map((c) => {
      const { n } = db!.prepare(`SELECT count(*) AS n FROM ${quote(c.table_name)}`).get() as { n: number };
      if (n > maxFeatures) throw badRequest(`Layer "${c.table_name}" has ${n} features; at most ${maxFeatures} can be imported at once`);
      const columns = db!.prepare(`PRAGMA table_info(${quote(c.table_name)})`).all() as { name: string; type: string; pk: number }[];
      const fields = columns.filter((col) => col.name !== c.column_name && !(col.pk && /^(fid|objectid)$/i.test(col.name)))
        .map((col) => ({ name: col.name, type: /INT|REAL|DOUBLE|FLOAT|NUMERIC/i.test(col.type) ? 'number' : /DATE/i.test(col.type) ? 'date' : 'text' }));
      const rows = (db!.prepare(`SELECT * FROM ${quote(c.table_name)}`).all() as Record<string, unknown>[]).map((r) => {
        const blob = r[c.column_name];
        const wkb = blob instanceof Uint8Array ? gpkgBlobToWkb(blob) : null;
        const properties: Record<string, unknown> = {};
        for (const f of fields) {
          const v = r[f.name];
          if (!(v instanceof Uint8Array)) properties[f.name] = typeof v === 'bigint' ? Number(v) : v;
        }
        return { wkbHex: wkb ? Buffer.from(wkb).toString('hex') : null, properties };
      });
      const epsg = c.srs_id > 0 && (c.organization ?? '').toUpperCase() === 'EPSG' && c.organization_coordsys_id ? Number(c.organization_coordsys_id) : null;
      return {
        name: c.table_name, geometryColumn: c.column_name, geometryType: c.geometry_type_name,
        crs: { epsg, name: c.srs_name ?? null }, fields, rows,
      };
    });
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true });
  }
}
