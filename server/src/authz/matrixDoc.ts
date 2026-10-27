import { permissionMatrix, ROLES, type Role } from './policy.js';

const ROLE_HEADINGS: Record<Role, string> = {
  system_admin: 'Admin',
  gis_officer: 'GIS',
  processor: 'Processor',
  registrar: 'Registrar',
  supervisor: 'Supervisor',
  auditor: 'Auditor',
  landowner: 'Landowner',
};

/**
 * Renders docs/permission-matrix.md from the rules the server enforces. Regenerate with
 * `npm run docs:permissions`; a unit test fails when the committed file differs from the code.
 */
export function renderPermissionMatrix(): string {
  const rows = permissionMatrix();
  const lines = [
    '# Permission matrix',
    '',
    '<!-- Generated from server/src/authz/policy.ts by `npm run docs:permissions`. Do not edit by hand. -->',
    '',
    'Every row is a server-side rule: the API refuses the action (403, audited) for any role without a ✓, whatever the interface shows.',
    'The same matrix is served read-only at `GET /api/admin/permissions` and shown on the Roles & Permissions page.',
    '',
    '- **county** scope: the role must be granted for the county of the record. A registrar in Montserrado cannot decide a Margibi case.',
    '- **global** scope: applies nationally.',
    '- **Separation**: `not_contributor` means the person may not act on a case they helped prepare; `creator_only` means only the person who opened it.',
    '- Surveyors have no accounts. The administrator holds no land-record authority: no ✓ on any decision, publication or rights action.',
    '',
    `| Action | Description | ${ROLES.map((r) => ROLE_HEADINGS[r]).join(' | ')} | Scope | Conditions |`,
    `|---|---|${ROLES.map(() => ':-:').join('|')}|---|---|`,
  ];
  for (const r of rows) {
    const conditions = [
      r.statuses && `status: ${r.statuses.join(', ')}`,
      r.caseTypes && `case types: ${r.caseTypes.join(', ')}`,
      r.separation && `separation: ${r.separation}`,
    ].filter(Boolean).join('; ');
    const cells = ROLES.map((role) => (r.roles.includes(role) ? '✓' : ''));
    lines.push(`| \`${r.action}\` | ${r.description.replace(/\|/g, '\\|')} | ${cells.join(' | ')} | ${r.scope} | ${conditions || '—'} |`);
  }
  return lines.join('\n') + '\n';
}
