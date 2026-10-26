export const CASE_STATUSES = [
  'draft',
  'validating',
  'under_review',
  'returned',
  'approved',
  'rejected',
  'published',
  'withdrawn',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_TYPES = ['first_registration', 'transfer', 'subdivision', 'consolidation', 'correction'] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/** Case types that accept imported geometry (a correction may optionally replace the boundary). */
export const SPATIAL_CASE_TYPES: readonly CaseType[] = ['first_registration', 'subdivision', 'consolidation', 'correction'];
/** Case types that propose rights. A correction never changes rights; those go through a transfer. */
export const RIGHTS_CASE_TYPES: readonly CaseType[] = ['first_registration', 'transfer', 'subdivision', 'consolidation'];
/** Case types that retire existing parcels and create new ones. */
export const RESHAPING_CASE_TYPES: readonly CaseType[] = ['subdivision', 'consolidation'];

/**
 * Permitted status transitions. The database trigger lais.enforce_case_transition()
 * holds the same list so a direct UPDATE cannot skip a step; a unit test checks they match.
 */
export const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  draft: ['validating', 'withdrawn'],
  validating: ['under_review', 'returned'],
  under_review: ['approved', 'rejected', 'returned'],
  returned: ['validating', 'withdrawn'],
  approved: ['published', 'under_review'],
  rejected: [],
  published: [],
  withdrawn: [],
};

export const EDITABLE_STATUSES: readonly CaseStatus[] = ['draft', 'returned'];
export const OPEN_STATUSES: readonly CaseStatus[] = ['draft', 'validating', 'under_review', 'returned', 'approved'];

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal case status transition ${from} -> ${to}`);
}
