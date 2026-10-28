import path from 'node:path';
import { unzipSync } from 'fflate';
import Papa from 'papaparse';
import * as shapefile from 'shapefile';
import { badRequest } from '../http.js';
import { parseCrsMember } from './geojson.js';

/**
 * Reading uploaded GIS files. Everything here treats the upload as untrusted: archives are unpacked in
 * memory with entry-name, entry-count and size limits (no path is ever written from an archive name),
 * nothing from the file is executed, and a coordinate reference system is detected only from real
 * metadata (a .prj file or a GeoJSON "crs" member), never guessed.
 *
 * Supported: GeoJSON, zipped shapefiles (.shp + .shx + .dbf, optional .prj/.cpg), CSV with a WKT geometry
 * column, and LAIS ArcMap export packages (a zipped shapefile with manifest.json). File geodatabases and
 * GeoPackages are refused with an explanation: no reader for them is installed on the server.
 */

export type SourceFormat = 'geojson' | 'shapefile' | 'csv_wkt' | 'arcmap_package';

export interface FieldInfo { name: string; type: string }
export interface LayerInfo {
  name: string;
  featureCount: number;
  fields: FieldInfo[];
  geometryTypes: string[];
  crs: { epsg: number | null; name: string | null; source: 'prj' | 'geojson-crs' | 'none' };
  sample: Record<string, unknown>[];
  wktColumn?: string | null;
}
export interface Inspection {
  format: SourceFormat;
  layers: LayerInfo[];
  manifest?: Record<string, unknown> | null;
  warnings: string[];
}
export interface LayerData {
  features: { geometry: Record<string, unknown> | null; properties: Record<string, unknown> }[];
  info: LayerInfo;
}

export const LIMITS = {
  maxUploadBytes: 50 * 1024 * 1024,
  maxUnzippedBytes: 200 * 1024 * 1024,
  maxArchiveEntries: 60,
  maxFeatures: 5000,
};

export const UNSUPPORTED: Record<string, string> = {
  '.gpkg': 'GeoPackage files cannot be imported here: no GeoPackage reader is installed on the server. Export the layer to a zipped shapefile or GeoJSON (in ArcMap, the LAIS sync tool does this).',
  '.gdb': 'File geodatabases cannot be read on the server. Use the LAIS ArcMap sync tool, which exports the feature class to a shapefile package, or export it to a zipped shapefile.',
  '.mdb': 'Personal geodatabases are not supported. Export the feature class to a zipped shapefile.',
  '.kml': 'KML is not supported for parcel import. Export to a zipped shapefile or GeoJSON with a declared CRS.',
  '.kmz': 'KMZ is not supported for parcel import.',
  '.dwg': 'CAD drawings are not supported. Convert to polygons in a GIS and export a zipped shapefile.',
  '.dxf': 'CAD drawings are not supported. Convert to polygons in a GIS and export a zipped shapefile.',
};

const ARCHIVE_EXTENSIONS = new Set(['.shp', '.shx', '.dbf', '.prj', '.cpg', '.xml', '.sbn', '.sbx', '.json', '.txt', '.qmd', '.qix']);

/** Safe archive member name: relative, no traversal, no drive letters, printable. */
function safeEntryName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  return !/[\x00-\x1f]/.test(name);
}

/** Unzips in memory with limits. Folder structure is flattened to base names; nothing is written to disk. */
export function unzipSafely(buffer: Uint8Array): Map<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  const problems: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        entries++;
        if (entries > LIMITS.maxArchiveEntries) { problems.push(`more than ${LIMITS.maxArchiveEntries} files`); return false; }
        if (!safeEntryName(f.name)) { problems.push(`unsafe file name "${f.name.slice(0, 60)}"`); return false; }
        const ext = path.extname(f.name).toLowerCase();
        if (f.name.toLowerCase().includes('.gdb/')) { problems.push('a file geodatabase'); return false; }
        if (!ARCHIVE_EXTENSIONS.has(ext)) { problems.push(`unexpected file type "${ext || f.name}"`); return false; }
        total += f.originalSize;
        if (total > LIMITS.maxUnzippedBytes) { problems.push('more than 200 MB when unpacked'); return false; }
        return true;
      },
    });
  } catch {
    throw badRequest('The archive could not be read as a ZIP file');
  }
  if (problems.some((p) => p === 'a file geodatabase')) throw badRequest(UNSUPPORTED['.gdb']);
  if (problems.length) throw badRequest(`The archive was refused: it contains ${[...new Set(problems)].slice(0, 3).join('; ')}`);
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    const base = path.basename(name.replace(/\\/g, '/'));
    if (out.has(base.toLowerCase())) throw badRequest(`The archive contains "${base}" more than once`);
    out.set(base.toLowerCase(), data);
  }
  return out;
}

/** EPSG code from a .prj (ESRI or OGC WKT). Only the codes LAIS accepts, or an AUTHORITY tag, are recognised. */
export function epsgFromPrj(wkt: string): { epsg: number | null; name: string | null } {
  const text = wkt.trim();
  const name = /^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS)\["([^"]+)"/.exec(text)?.[1] ?? null;
  // A trailing top-level AUTHORITY["EPSG","n"] names the whole CRS.
  const authority = /AUTHORITY\["EPSG",\s*"?(\d+)"?\]\]\s*$/.exec(text);
  if (authority) return { epsg: Number(authority[1]), name };
  if (/^PROJCS\["(WGS_1984_UTM_Zone_29N|WGS 84 \/ UTM zone 29N)"/i.test(text)) return { epsg: 32629, name };
  if (/^GEOGCS\["(GCS_WGS_1984|WGS 84|WGS84)"/i.test(text)) return { epsg: 4326, name };
  return { epsg: null, name };
}

function geometryTypes(features: { geometry: Record<string, unknown> | null }[]): string[] {
  return [...new Set(features.map((f) => (f.geometry ? String(f.geometry.type) : 'null')))];
}

/** Attribute values are untrusted text: keep scalars only, trim long strings. */
function cleanProperties(p: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (Object.keys(out).length >= 100) break;
    const key = String(k).slice(0, 64);
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (v instanceof Date) out[key] = v.toISOString();
    else if (typeof v === 'string') out[key] = v.trim().slice(0, 500);
  }
  return out;
}

async function readShapefile(files: Map<string, Uint8Array>, stem: string): Promise<LayerData> {
  const shp = files.get(`${stem}.shp`);
  const dbf = files.get(`${stem}.dbf`);
  if (!shp || !files.get(`${stem}.shx`) || !dbf) {
    const missing = ['shp', 'shx', 'dbf'].filter((e) => !files.get(`${stem}.${e}`)).map((e) => `.${e}`);
    throw badRequest(`Shapefile "${stem}" is incomplete: ${missing.join(', ')} missing. A shapefile needs .shp, .shx and .dbf (and should have .prj).`);
  }
  const cpg = files.get(`${stem}.cpg`);
  const encoding = cpg ? new TextDecoder().decode(cpg).trim().replace(/^UTF[-_]?8$/i, 'utf-8') || 'windows-1252' : 'windows-1252';
  const prj = files.get(`${stem}.prj`);
  const crs = prj ? { ...epsgFromPrj(new TextDecoder().decode(prj)), source: 'prj' as const } : { epsg: null, name: null, source: 'none' as const };
  let source;
  let fields: FieldInfo[];
  try {
    const dbfSource = await shapefile.openDbf(dbf, { encoding: /^(utf-8|windows-1252|iso-8859-1)$/i.test(encoding) ? encoding : 'windows-1252' });
    fields = ((dbfSource as unknown as { _fields: { name: string; type: string }[] })._fields ?? [])
      .map((f) => ({ name: f.name, type: ({ C: 'text', N: 'number', F: 'number', D: 'date', L: 'boolean' } as Record<string, string>)[f.type] ?? f.type }));
    source = await shapefile.open(shp, dbf, { encoding: /^(utf-8|windows-1252|iso-8859-1)$/i.test(encoding) ? encoding : 'windows-1252' });
  } catch {
    throw badRequest(`Shapefile "${stem}" could not be read`);
  }
  const features: LayerData['features'] = [];
  for (;;) {
    let r;
    try { r = await source.read(); } catch { throw badRequest(`Shapefile "${stem}" is damaged after ${features.length} record(s)`); }
    if (r.done) break;
    if (features.length >= LIMITS.maxFeatures) throw badRequest(`More than ${LIMITS.maxFeatures} features: split the import`);
    const value = r.value as { geometry: Record<string, unknown> | null; properties: Record<string, unknown> };
    features.push({ geometry: value.geometry, properties: cleanProperties(value.properties) });
  }
  return { features, info: { name: stem, featureCount: features.length, fields, geometryTypes: geometryTypes(features), crs, sample: features.slice(0, 5).map((f) => f.properties) } };
}

function readGeoJson(text: string, name: string): LayerData {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw badRequest('The file is not valid JSON'); }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(doc)) throw badRequest('The file is not a GeoJSON object');
  const epsg = parseCrsMember(doc.crs);
  let raw: unknown[];
  if (doc.type === 'FeatureCollection' && Array.isArray(doc.features)) raw = doc.features;
  else if (doc.type === 'Feature') raw = [doc];
  else throw badRequest('Expected a GeoJSON FeatureCollection or Feature');
  if (raw.length > LIMITS.maxFeatures) throw badRequest(`More than ${LIMITS.maxFeatures} features: split the import`);
  const features = raw.map((f) => {
    const feat = isObj(f) ? f : {};
    return { geometry: isObj(feat.geometry) ? feat.geometry : null, properties: cleanProperties(isObj(feat.properties) ? feat.properties : {}) };
  });
  const fieldNames = [...new Set(features.flatMap((f) => Object.keys(f.properties)))];
  const fields = fieldNames.map((n) => ({ name: n, type: typeof features.find((f) => f.properties[n] !== null && f.properties[n] !== undefined)?.properties[n] }));
  return {
    features,
    info: {
      name, featureCount: features.length, fields: fields.map((f) => ({ name: f.name, type: f.type === 'undefined' ? 'text' : String(f.type) })),
      geometryTypes: geometryTypes(features), crs: { epsg, name: epsg ? `EPSG:${epsg}` : null, source: epsg ? 'geojson-crs' : 'none' },
      sample: features.slice(0, 5).map((f) => f.properties),
    },
  };
}

/** CSV with one WKT geometry column. The CRS cannot be known from a CSV and must be declared. */
function readCsv(text: string, name: string, wktColumn?: string | null): LayerData {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length && !parsed.data.length) throw badRequest('The CSV file could not be read');
  const rows = parsed.data;
  if (rows.length > LIMITS.maxFeatures) throw badRequest(`More than ${LIMITS.maxFeatures} rows: split the import`);
  const columns = parsed.meta.fields ?? [];
  const candidates = columns.filter((c) => rows.slice(0, 20).some((r) => /^\s*(MULTI)?POLYGON\s*\(/i.test(r[c] ?? '')));
  const geomColumn = wktColumn ?? candidates[0] ?? null;
  if (wktColumn && !columns.includes(wktColumn)) throw badRequest(`Column "${wktColumn}" is not in the file`);
  const features = rows.map((r) => {
    const { [geomColumn ?? '']: wkt, ...rest } = r;
    return { geometry: geomColumn && wkt ? { wkt: String(wkt).trim() } as Record<string, unknown> : null, properties: cleanProperties(rest) };
  });
  return {
    features,
    info: {
      name, featureCount: rows.length, fields: columns.filter((c) => c !== geomColumn).map((c) => ({ name: c, type: 'text' })),
      geometryTypes: geomColumn ? ['WKT'] : ['none'], crs: { epsg: null, name: null, source: 'none' }, wktColumn: geomColumn,
      sample: features.slice(0, 5).map((f) => f.properties),
    },
  };
}

function detectFormat(filename: string, buffer: Uint8Array): { format: SourceFormat | 'zip'; ext: string } {
  const ext = path.extname(filename).toLowerCase();
  if (UNSUPPORTED[ext]) throw badRequest(UNSUPPORTED[ext]);
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (ext === '.zip' || isZip) {
    if (!isZip) throw badRequest('The file is not a ZIP archive');
    return { format: 'zip', ext };
  }
  if (ext === '.geojson' || ext === '.json') return { format: 'geojson', ext };
  if (ext === '.csv') return { format: 'csv_wkt', ext };
  if (ext === '.shp') throw badRequest('Upload the shapefile as a ZIP containing the .shp, .shx, .dbf and .prj files together');
  throw badRequest('Unsupported file type. Accepted: GeoJSON, a zipped shapefile, CSV with a WKT geometry column, or a LAIS ArcMap package');
}

/** Opens an upload: its format, layers and (for packages) manifest. */
export async function openUpload(buffer: Uint8Array, filename: string, options: { wktColumn?: string | null } = {}) {
  if (buffer.length > LIMITS.maxUploadBytes) throw badRequest('The file is larger than 50 MB');
  const { format } = detectFormat(filename, buffer);
  const warnings: string[] = [];
  if (format === 'geojson') {
    const layer = readGeoJson(new TextDecoder().decode(buffer), path.basename(filename, path.extname(filename)));
    return { format: 'geojson' as SourceFormat, layers: [layer], manifest: null, warnings };
  }
  if (format === 'csv_wkt') {
    const layer = readCsv(new TextDecoder().decode(buffer), path.basename(filename, path.extname(filename)), options.wktColumn);
    if (!layer.info.wktColumn) warnings.push('No column with WKT polygons was found. Choose the geometry column, or export polygons with WKT.');
    return { format: 'csv_wkt' as SourceFormat, layers: [layer], manifest: null, warnings };
  }
  const files = unzipSafely(buffer);
  let manifest: Record<string, unknown> | null = null;
  const manifestFile = files.get('manifest.json');
  if (manifestFile) {
    try { manifest = JSON.parse(new TextDecoder().decode(manifestFile)); } catch { throw badRequest('manifest.json is not valid JSON'); }
  }
  const stems = [...files.keys()].filter((n) => n.endsWith('.shp')).map((n) => n.slice(0, -4));
  if (stems.length === 0) {
    const geojson = [...files.keys()].find((n) => n.endsWith('.json') && n !== 'manifest.json');
    if (geojson) return { format: 'geojson' as SourceFormat, layers: [readGeoJson(new TextDecoder().decode(files.get(geojson)!), geojson.replace(/\.json$/, ''))], manifest, warnings };
    throw badRequest('The archive contains no shapefile (.shp) or GeoJSON layer');
  }
  const layers: LayerData[] = [];
  for (const stem of stems) layers.push(await readShapefile(files, stem));
  for (const l of layers) if (l.info.crs.source === 'none') warnings.push(`Layer "${l.info.name}" has no .prj file: its coordinate reference system is unknown and must be declared with a reason.`);
  return { format: (manifest ? 'arcmap_package' : 'shapefile') as SourceFormat, layers, manifest, warnings };
}

export function inspection(opened: Awaited<ReturnType<typeof openUpload>>): Inspection {
  return { format: opened.format, layers: opened.layers.map((l) => l.info), manifest: opened.manifest, warnings: opened.warnings };
}
