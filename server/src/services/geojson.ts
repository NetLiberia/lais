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

/** How many parcel features each kind of case accepts in one import. */
export const FEATURE_LIMITS: Record<string, { min: number; max: number; label: string }> = {
  first_registration: { min: 1, max: 1, label: 'A registration case takes exactly one parcel feature' },
  subdivision: { min: 2, max: 50, label: 'A subdivision takes between 2 and 50 new parcel features' },
  consolidation: { min: 1, max: 1, label: 'A consolidation takes exactly one merged parcel feature' },
  correction: { min: 1, max: 1, label: 'A correction takes exactly one corrected parcel feature' },
};

/**
 * Extracts the features of an import, in file order.
 * Accepts a FeatureCollection, a Feature, or a bare geometry.
 */
export function extractFeatures(text: string, declaredSrid: number, limits: { min: number; max: number; label: string }): SingleFeature[] {
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

  let features: any[];
  if (doc.type === 'FeatureCollection') {
    if (!Array.isArray(doc.features)) throw badRequest('FeatureCollection has no features array');
    features = doc.features;
  } else if (doc.type === 'Feature') {
    features = [doc];
  } else if (typeof doc.type === 'string' && 'coordinates' in doc) {
    features = [{ type: 'Feature', geometry: doc, properties: {} }];
  } else {
    throw badRequest('Unsupported GeoJSON type');
  }
  if (features.length < limits.min || features.length > limits.max) {
    throw badRequest(`${limits.label}; this file has ${features.length}.`);
  }

  return features.map((feature, i) => {
    if (!feature?.geometry || typeof feature.geometry !== 'object') throw badRequest(`Feature ${i + 1} has no geometry`);
    const featureSrid = parseCrsMember(feature.geometry.crs);
    if (featureSrid !== null && featureSrid !== declaredSrid) {
      throw badRequest(`Declared CRS EPSG:${declaredSrid} conflicts with the CRS of feature ${i + 1} (EPSG:${featureSrid})`);
    }
    const { crs: _ignored, ...geometry } = feature.geometry;
    const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
    return { geometry, properties };
  });
}

/** Single-parcel convenience wrapper. */
export function extractSingleFeature(text: string, declaredSrid: number): SingleFeature {
  return extractFeatures(text, declaredSrid, FEATURE_LIMITS.first_registration)[0];
}
