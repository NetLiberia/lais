/**
 * Attributes expected on each feature of a legacy migration file. Field names are what a GIS officer
 * would set in ArcGIS Pro / QGIS before export; the mapping from a real legacy register to these
 * fields must be agreed with the records' custodian.
 */
export const LEGACY_FIELDS = {
  legacy_ref: 'Identifier in the legacy register (required, unique within the county)',
  land_category: 'public, government, customary or private (required)',
  land_use: 'Recorded land use (optional)',
  surveyed_area_m2: 'Area stated in the legacy record, in square metres (optional)',
  holder_names: 'Holder name(s) as written in the legacy record, separated by ";" (optional)',
  holder_type: 'person, organization, community or government (applies to all holders; default person)',
} as const;

const CATEGORIES = ['public', 'government', 'customary', 'private'];
const HOLDER_TYPES = ['person', 'organization', 'community', 'government'];

export interface LegacyRecord {
  legacyRef: string | null;
  landCategory: string | null;
  landUse: string | null;
  surveyedAreaM2: number | null;
  holders: string[];
  holderType: string;
  /** Attribute problems; any problem blocks the feature until it is fixed or excluded. */
  problems: string[];
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export function parseLegacyProperties(props: Record<string, unknown>): LegacyRecord {
  const problems: string[] = [];

  const legacyRef = text(props.legacy_ref);
  if (!legacyRef) problems.push('legacy_ref is missing');
  else if (legacyRef.length > 60) problems.push('legacy_ref is longer than 60 characters');

  const rawCategory = text(props.land_category)?.toLowerCase() ?? null;
  const landCategory = rawCategory && CATEGORIES.includes(rawCategory) ? rawCategory : null;
  if (!rawCategory) problems.push('land_category is missing');
  else if (!landCategory) problems.push(`land_category "${rawCategory}" is not one of ${CATEGORIES.join(', ')}`);

  const landUse = text(props.land_use)?.slice(0, 100) ?? null;

  let surveyedAreaM2: number | null = null;
  const rawArea = text(props.surveyed_area_m2);
  if (rawArea !== null) {
    const n = Number(rawArea);
    if (!Number.isFinite(n) || n <= 0) problems.push(`surveyed_area_m2 "${rawArea}" is not a positive number`);
    else surveyedAreaM2 = Math.round(n * 100) / 100;
  }

  const holders = (text(props.holder_names) ?? '').split(';').map((h) => h.trim()).filter(Boolean);
  if (holders.some((h) => h.length > 200)) problems.push('a holder name is longer than 200 characters');
  if (holders.length > 20) problems.push('more than 20 holders');

  const rawType = text(props.holder_type)?.toLowerCase() ?? 'person';
  const holderType = HOLDER_TYPES.includes(rawType) ? rawType : 'person';
  if (!HOLDER_TYPES.includes(rawType)) problems.push(`holder_type "${rawType}" is not one of ${HOLDER_TYPES.join(', ')}`);

  return { legacyRef, landCategory, landUse, surveyedAreaM2, holders, holderType, problems };
}
