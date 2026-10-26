import { badRequest } from '../http.js';

/**
 * Coordinate reference systems accepted for import. The officer must declare one;
 * the system never guesses a missing CRS.
 */
export const ACCEPTED_SRIDS: Record<number, string> = {
  4326: 'WGS 84 geographic (EPSG:4326, longitude/latitude)',
  32629: 'WGS 84 / UTM zone 29N (EPSG:32629, metres)',
};

/**
 * Reads the legacy GeoJSON "crs" member if present.
 * Returns the EPSG code, null when absent, or throws when present but unrecognised.
 */
export function parseCrsMember(crs: unknown): number | null {
  if (crs === undefined || crs === null) return null;
  const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
  if (typeof name !== 'string') throw badRequest('The file has a "crs" member that cannot be interpreted');
  if (/CRS84$/i.test(name)) return 4326;
  const match = /EPSG:{1,2}(\d+)$/i.exec(name);
  if (!match) throw badRequest(`Unrecognised CRS in file: ${name}`);
  return Number(match[1]);
}

export interface SingleFeature {
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
}

/**
 * Extracts exactly one feature for a single-parcel registration case.
 * Accepts a FeatureCollection with one feature, a Feature, or a bare geometry.
 */
export function extractSingleFeature(text: string, declaredSrid: number): SingleFeature {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw badRequest('The file is not valid JSON');
  }
  if (!doc || typeof doc !== 'object') throw badRequest('The file is not a GeoJSON object');

  const fileSrid = parseCrsMember(doc.crs);
  if (fileSrid !== null && fileSrid !== declaredSrid) {
    throw badRequest(`Declared CRS EPSG:${declaredSrid} conflicts with the file's CRS EPSG:${fileSrid}`);
  }

  let feature: any;
  if (doc.type === 'FeatureCollection') {
    if (!Array.isArray(doc.features)) throw badRequest('FeatureCollection has no features array');
    if (doc.features.length !== 1) {
      throw badRequest(
        `A registration case takes exactly one parcel feature; this file has ${doc.features.length}. Multi-parcel batch import is a later project phase.`,
      );
    }
    feature = doc.features[0];
  } else if (doc.type === 'Feature') {
    feature = doc;
  } else if (typeof doc.type === 'string' && 'coordinates' in doc) {
    feature = { type: 'Feature', geometry: doc, properties: {} };
  } else {
    throw badRequest('Unsupported GeoJSON type');
  }

  if (!feature?.geometry || typeof feature.geometry !== 'object') throw badRequest('The feature has no geometry');
  const featureSrid = parseCrsMember(feature.geometry.crs);
  if (featureSrid !== null && featureSrid !== declaredSrid) {
    throw badRequest(`Declared CRS EPSG:${declaredSrid} conflicts with the geometry's CRS EPSG:${featureSrid}`);
  }
  const { crs: _ignored, ...geometry } = feature.geometry;
  const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  return { geometry, properties };
}
