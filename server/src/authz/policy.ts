import { EDITABLE_STATUSES, RIGHTS_CASE_TYPES, SPATIAL_CASE_TYPES, type CaseStatus, type CaseType } from './workflow.js';

/**
 * Role-based access control combined with jurisdiction, record status and
 * separation of duties. Every protected API operation calls authorize() with
 * context loaded from the database, never from the request body.
 *
 * The role names and the matrix below are the proposed technical control model,
 * not a statement of Liberia's legal procedures. They must be mapped to LLA
 * positions and delegated authorities before any official use.
 */
export const ROLES = ['system_admin', 'gis_officer', 'processor', 'registrar', 'supervisor', 'auditor', 'landowner'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that only ever act within an assigned county. */
export const COUNTY_SCOPED_ROLES: readonly Role[] = ['gis_officer', 'processor', 'registrar'];
/** Roles that must never be combined with system_admin on the same account. */
export const OPERATIONAL_ROLES = COUNTY_SCOPED_ROLES;
/** Roles that must enrol in MFA when MFA_ENFORCED=true. */
export const PRIVILEGED_ROLES: readonly Role[] = ['system_admin', 'registrar', 'supervisor', 'auditor'];

export interface RoleGrant {
  role: Role;
  /** null means national scope (only valid for non-operational roles). */
  countyId: number | null;
}

export interface Principal {
  userId: string;
  grants: RoleGrant[];
}

interface Rule {
  roles: readonly Role[];
  /** 'county' rules require a resource county that one of the matching grants covers. */
  scope: 'county' | 'global';
  statuses?: readonly CaseStatus[];
  caseTypes?: readonly CaseType[];
  separation?: 'not_contributor' | 'creator_only';
}

const INTERNAL_READERS: readonly Role[] = ['gis_officer', 'processor', 'registrar', 'supervisor', 'auditor'];
const PREPARERS: readonly Role[] = ['gis_officer', 'processor'];

const RULES = {
  // Case preparation (GIS officers and processors, within their county, while editable)
  'case.create': { roles: PREPARERS, scope: 'county' },
  'case.view': { roles: INTERNAL_READERS, scope: 'county' },
  'case.edit_attributes': { roles: PREPARERS, scope: 'county', statuses: EDITABLE_STATUSES },
  'case.import_geometry': { roles: ['gis_officer'], scope: 'county', statuses: EDITABLE_STATUSES, caseTypes: SPATIAL_CASE_TYPES },
  'case.edit_rights': { roles: ['processor'], scope: 'county', statuses: EDITABLE_STATUSES, caseTypes: RIGHTS_CASE_TYPES },
  'case.upload_document': { roles: PREPARERS, scope: 'county', statuses: EDITABLE_STATUSES },
  'case.verify_document': { roles: ['processor'], scope: 'county', statuses: EDITABLE_STATUSES },
  'case.validate': { roles: PREPARERS, scope: 'county', statuses: EDITABLE_STATUSES },
  'case.submit': { roles: PREPARERS, scope: 'county', statuses: EDITABLE_STATUSES },
  'case.withdraw': { roles: PREPARERS, scope: 'county', statuses: EDITABLE_STATUSES, separation: 'creator_only' },

  // Decisions (registrars, within their county, never on a case they helped prepare)
  'case.acknowledge_finding': { roles: ['registrar'], scope: 'county', statuses: ['under_review'], separation: 'not_contributor' },
  'case.decide': { roles: ['registrar'], scope: 'county', statuses: ['under_review'], separation: 'not_contributor' },
  'case.publish': { roles: ['registrar'], scope: 'county', statuses: ['approved'], separation: 'not_contributor' },

  // Registry records
  'parcel.view_internal': { roles: INTERNAL_READERS, scope: 'county' },
  'parcel.manage_dispute': { roles: ['registrar'], scope: 'county' },
  'document.view_restricted': { roles: INTERNAL_READERS, scope: 'county' },
  'document.view_highly_sensitive': { roles: ['processor', 'registrar'], scope: 'county' },

  // Parties
  'party.search': { roles: ['processor', 'registrar'], scope: 'global' },
  'party.create': { roles: ['processor'], scope: 'global' },
  'party.verify_identity': { roles: ['processor'], scope: 'global' },
  'party.link_user': { roles: ['processor'], scope: 'global' },
  'party.view_sensitive': { roles: ['processor', 'registrar'], scope: 'global' },

  // Oversight and administration. Administrators run the platform; none of these confer legal authority.
  'audit.view_all': { roles: ['supervisor', 'auditor'], scope: 'global' },
  'audit.view_technical': { roles: ['system_admin'], scope: 'global' },
  'user.manage': { roles: ['system_admin'], scope: 'global' },
  'users.read': { roles: ['system_admin', 'supervisor'], scope: 'global' },
  'roles.assign': { roles: ['system_admin'], scope: 'global' },
  'counties.read': { roles: ['system_admin', 'supervisor', 'auditor', 'gis_officer', 'processor', 'registrar'], scope: 'global' },
  'counties.manage': { roles: ['system_admin'], scope: 'global' },
  'dashboard.view': { roles: ['system_admin', 'supervisor'], scope: 'global' },
  'gis.sync.read': { roles: ['system_admin', 'supervisor'], scope: 'global' },
  'system.health': { roles: ['system_admin', 'supervisor'], scope: 'global' },
  'system.configure': { roles: ['system_admin'], scope: 'global' },
  'backups.run': { roles: ['system_admin'], scope: 'global' },
  'reports.export': { roles: ['system_admin', 'supervisor'], scope: 'global' },

  // Document requests from landowners (status rules are enforced by the route and a database trigger)
  'docrequest.view': { roles: ['processor', 'registrar', 'supervisor', 'auditor'], scope: 'county' },
  'docrequest.prepare': { roles: ['processor'], scope: 'county' },
  'docrequest.decide': { roles: ['registrar'], scope: 'county', separation: 'not_contributor' },

  // External users
  'landowner.view_own': { roles: ['landowner'], scope: 'global' },
  'landowner.request_documents': { roles: ['landowner'], scope: 'global' },
} as const satisfies Record<string, Rule>;

export type Action = keyof typeof RULES;
export const ACTIONS = Object.keys(RULES) as Action[];

/** Plain-language meaning of each permission, for the permission matrix shown to administrators. */
export const ACTION_DESCRIPTIONS: Record<Action, string> = {
  'case.create': 'Open a case in an assigned county',
  'case.view': 'View cases in an assigned county',
  'case.edit_attributes': 'Edit case details while the case is a draft or returned',
  'case.import_geometry': 'Import parcel geometry into staging',
  'case.edit_rights': 'Record proposed rights and holders',
  'case.upload_document': 'Attach documents and evidence to a case',
  'case.verify_document': 'Verify a document uploaded by someone else',
  'case.validate': 'Run validation and conflict checks',
  'case.submit': 'Submit a case for review',
  'case.withdraw': 'Withdraw a case they opened',
  'case.acknowledge_finding': 'Acknowledge a validation warning with an investigation note',
  'case.decide': 'Approve, return or reject a case (legal decision)',
  'case.publish': 'Publish an approved case to the register',
  'parcel.view_internal': 'View internal parcel records (rights, history, cases)',
  'parcel.manage_dispute': 'Record and close parcel disputes',
  'document.view_restricted': 'Download restricted documents',
  'document.view_highly_sensitive': 'Download highly sensitive documents',
  'party.search': 'Search party records',
  'party.create': 'Record a new party',
  'party.verify_identity': 'Verify the identity of a party recorded by someone else',
  'party.link_user': 'Link a landowner portal account to a verified party',
  'party.view_sensitive': 'Reveal identity numbers and contact details (logged)',
  'audit.view_all': 'View the full audit trail',
  'audit.view_technical': 'View security and system audit events',
  'user.manage': 'Create staff accounts, change their status, reset passwords',
  'users.read': 'View staff accounts',
  'roles.assign': 'Assign and revoke roles and county assignments for other staff',
  'counties.read': 'View county configuration',
  'counties.manage': 'Configure counties and import administrative boundaries',
  'dashboard.view': 'View system-wide operational statistics',
  'gis.sync.read': 'Monitor GIS import jobs and their validation outcomes',
  'system.health': 'View system health checks',
  'system.configure': 'Change non-legal system settings and document categories',
  'backups.run': 'Start a database backup',
  'reports.export': 'Export administrative reports (no personal data)',
  'docrequest.view': 'View landowner document requests',
  'docrequest.prepare': 'Prepare documents for release to a landowner',
  'docrequest.decide': 'Approve or refuse a document release',
  'landowner.view_own': 'View own registered interests',
  'landowner.request_documents': 'Request copies of documents for own parcels',
};

/** The permission matrix: every action with the roles allowed it and its constraints. */
export function permissionMatrix() {
  return ACTIONS.map((action) => {
    const rule: Rule = RULES[action];
    return {
      action,
      description: ACTION_DESCRIPTIONS[action],
      roles: [...rule.roles],
      scope: rule.scope,
      statuses: rule.statuses ? [...rule.statuses] : null,
      caseTypes: rule.caseTypes ? [...rule.caseTypes] : null,
      separation: rule.separation ?? null,
    };
  });
}

/** Actions the principal can perform somewhere (any county or globally): used to shape the UI only. */
export function capabilities(principal: Principal): Action[] {
  return ACTIONS.filter((a) => {
    const rule: Rule = RULES[a];
    return principal.grants.some((g) => rule.roles.includes(g.role));
  });
}

export interface ResourceContext {
  countyId?: number | null;
  caseStatus?: CaseStatus;
  caseType?: CaseType;
  createdBy?: string;
  /** Users who prepared or changed the case (from the case event history). */
  contributorIds?: readonly string[];
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

const allow: Decision = { allowed: true, reason: 'permitted' };
const deny = (reason: string): Decision => ({ allowed: false, reason });

export function authorize(principal: Principal | null | undefined, action: Action, ctx: ResourceContext = {}): Decision {
  if (!principal) return deny('Authentication required');
  const rule: Rule = RULES[action];

  const grants = principal.grants.filter((g) => rule.roles.includes(g.role));
  if (grants.length === 0) return deny(`This action requires one of these roles: ${rule.roles.join(', ')}`);

  if (rule.scope === 'county') {
    // Fail closed: an unknown jurisdiction is never treated as "any county".
    if (ctx.countyId === undefined || ctx.countyId === null) return deny('The record jurisdiction could not be determined');
    if (!grants.some((g) => g.countyId === null || g.countyId === ctx.countyId)) {
      return deny('This record is outside your assigned jurisdiction');
    }
  }

  if (rule.statuses && (!ctx.caseStatus || !rule.statuses.includes(ctx.caseStatus))) {
    return deny(`Not permitted while the case is ${ctx.caseStatus ?? 'in an unknown state'}`);
  }

  if (rule.caseTypes && (!ctx.caseType || !rule.caseTypes.includes(ctx.caseType))) {
    return deny(`Not permitted for ${ctx.caseType ?? 'this'} cases`);
  }

  if (rule.separation === 'not_contributor') {
    if (!ctx.contributorIds) return deny('Case contributors could not be determined');
    if (ctx.contributorIds.includes(principal.userId)) {
      return deny('Separation of duties: you prepared or contributed to this case, so another authorized officer must decide it');
    }
  }

  if (rule.separation === 'creator_only' && ctx.createdBy !== principal.userId) {
    return deny('Only the officer who opened the case may do this');
  }

  return allow;
}

/**
 * The counties in which the principal may perform a county-scoped action:
 * 'all' for national grants, otherwise the list of assigned county ids (possibly empty).
 */
export function scopeFor(principal: Principal, action: Action): 'all' | number[] {
  const rule: Rule = RULES[action];
  const grants = principal.grants.filter((g) => rule.roles.includes(g.role));
  if (grants.some((g) => g.countyId === null)) return 'all';
  return [...new Set(grants.map((g) => g.countyId as number))];
}

export function hasRole(principal: Principal, role: Role): boolean {
  return principal.grants.some((g) => g.role === role);
}

/** Checks a proposed set of roles for combinations this design forbids on one account. */
export function roleCombinationProblem(roles: readonly Role[]): string | null {
  const set = new Set(roles);
  if (set.has('system_admin') && roles.some((r) => OPERATIONAL_ROLES.includes(r))) {
    return 'Separation of duties: a system administrator account cannot also hold GIS, processor or registrar roles';
  }
  if (set.has('landowner') && roles.some((r) => r !== 'landowner')) {
    return 'Landowner accounts must be separate from internal staff accounts';
  }
  if (set.has('auditor') && roles.some((r) => r !== 'auditor')) {
    return 'Auditor accounts must be independent of operational and administrative roles';
  }
  return null;
}
