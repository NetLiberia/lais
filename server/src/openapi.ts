import type { Router } from 'express';
import { z, type ZodType } from 'zod';

/**
 * OpenAPI 3.1 description of the LAIS API, generated at start-up from the mounted routers so the
 * list of operations always matches the code. Summaries are kept here; a test fails when a route
 * has no summary or a summary names a route that no longer exists.
 *
 * Request bodies and query parameters come from the same Zod schemas the handlers validate with:
 * each route module registers its schemas with documentBody() / documentQuery(). A test fails when a
 * write route is not accounted for (JSON body, upload, or NO_BODY). Responses are described in
 * outline only; their TypeScript shapes are in web/src/types.ts.
 */

const BODIES = new Map<string, ZodType>();
const QUERIES = new Map<string, ZodType>();

/** Publishes `schema` as the request body of the given routes (`'POST /admin/users'`), and returns it unchanged. */
export function documentBody<T extends ZodType>(keys: string | string[], schema: T): T {
  for (const key of [keys].flat()) BODIES.set(key, schema);
  return schema;
}

/** Publishes `schema` (a z.object) as the query parameters of the given routes, and returns it unchanged. */
export function documentQuery<T extends ZodType>(keys: string | string[], schema: T): T {
  for (const key of [keys].flat()) QUERIES.set(key, schema);
  return schema;
}

export const documentedBodies = () => [...BODIES.keys()];
export const documentedQueries = () => [...QUERIES.keys()];

/** Write routes that take no request body. */
export const NO_BODY = new Set([
  'POST /auth/logout', 'POST /auth/mfa/enroll/start',
  'POST /cases/{id}/rights/copy-from-source', 'DELETE /cases/{id}/rights/{rightId}',
  'POST /cases/{id}/validate', 'POST /cases/{id}/submit', 'POST /cases/{id}/publish',
  'POST /notifications/{id}/read', 'POST /notifications/read-all', 'POST /me/document-requests/{id}/withdraw',
]);

/** The schema as JSON Schema describing what a client sends (before coercion and defaults). */
function jsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

function queryParameters(schema: ZodType) {
  const s = jsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(s.properties ?? {}).map(([name, prop]) => ({ name, in: 'query', required: s.required?.includes(name) ?? false, schema: prop }));
}

function requestBody(key: string, multipart: boolean) {
  const schema = BODIES.get(key);
  if (multipart) {
    const fields = schema ? jsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] } : {};
    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { ...fields.properties, file: { type: 'string', format: 'binary' } },
            required: [...(fields.required ?? []), 'file'],
          },
        },
      },
    };
  }
  return schema ? { required: true, content: { 'application/json': { schema: jsonSchema(schema) } } } : undefined;
}

export const SUMMARIES: Record<string, string> = {
  // Public portal
  'GET /public/counties': 'Configured county boundaries (GeoJSON). Counties without an imported boundary are omitted.',
  'GET /public/parcels': 'Published parcels in a bounding box (GeoJSON, public fields only).',
  'GET /public/parcels/{upi}': 'One published parcel by UPI (public fields only).',
  // Authentication
  'POST /auth/login': 'Sign in with username and password. Sets the session cookie; returns the session and CSRF token.',
  'POST /auth/token/inspect': 'Check a one-time activation or password-reset link without using it.',
  'POST /auth/token/complete': 'Use a one-time link to set a password. The link stops working afterwards.',
  'GET /auth/session': 'The current session: user, role grants, capabilities, CSRF token and system banner.',
  'POST /auth/logout': 'End the current session.',
  'POST /auth/mfa/verify': 'Complete sign-in with a TOTP code.',
  'POST /auth/mfa/enroll/start': 'Start enrolling an authenticator app.',
  'POST /auth/mfa/enroll/confirm': 'Confirm authenticator enrolment with a code.',
  'POST /auth/password': 'Change your own password (current password required).',
  // Cases
  'GET /cases': 'List cases in your county scope, with filters.',
  'POST /cases': 'Open a case (first registration, subdivision, correction, legacy migration or confirmation). The county must be enabled.',
  'GET /cases/{id}': 'Case detail: staging geometry, validation findings, rights, documents and history.',
  'PATCH /cases/{id}': 'Update draft case details.',
  'POST /cases/{id}/geometry': 'Upload parcel geometry (GeoJSON, EPSG:4326 or 32629) to staging; it is validated, never published directly.',
  'POST /cases/{id}/features/{index}/exclusion': 'Exclude or restore one feature of a legacy migration batch, with a reason.',
  'GET /cases/{id}/migration-report.csv': 'Reconciliation report of a legacy migration batch (CSV).',
  'POST /cases/{id}/rights': 'Record a right or interest on the case.',
  'POST /cases/{id}/rights/copy-from-source': 'Copy the rights of the source parcel into the case.',
  'DELETE /cases/{id}/rights/{rightId}': 'Remove a right from a draft case.',
  'POST /cases/{id}/documents': 'Upload a supporting document (multipart). The category must exist and be active.',
  'POST /cases/{id}/documents/{docId}/verify': 'Verify a document (a second processor, never the uploader).',
  'POST /cases/{id}/validate': 'Run spatial and completeness validation.',
  'POST /cases/{id}/submit': 'Submit the case for a registrar decision.',
  'POST /cases/{id}/withdraw': 'Withdraw a case.',
  'POST /cases/{id}/findings/{findingId}/acknowledge': 'Registrar acknowledges a validation finding with a note.',
  'POST /cases/{id}/decision': 'Registrar decision (approve, reject, return) for a case in their county.',
  'POST /cases/{id}/publish': 'Publish an approved case to the authoritative register.',
  // Documents and document requests
  'GET /documents/{id}/file': 'Download a case document (access-checked and audited).',
  'GET /document-requests': 'List landowner document requests in your scope.',
  'GET /document-requests/{id}': 'Document request detail.',
  'POST /document-requests/{id}/prepare': 'Prepare documents for release (processor).',
  'POST /document-requests/{id}/decide': 'Approve or refuse release of prepared documents (registrar).',
  // Parcels and parties
  'GET /parcels/{upi}': 'Internal parcel record: geometry, rights, history and disputes.',
  'POST /parcels/{upi}/disputes': 'Record a dispute on a parcel.',
  'POST /parcels/{upi}/disputes/{disputeId}/close': 'Close a dispute with a resolution note.',
  'GET /parties': 'Search parties (masked identifiers).',
  'POST /parties': 'Create a party.',
  'GET /parties/{id}/sensitive': 'Reveal a party\'s sensitive identifiers (audited; needs a reason).',
  'POST /parties/{id}/verify-identity': 'Record identity verification for a party.',
  'POST /parties/{id}/link-user': 'Link a party to a landowner account.',
  // Administration: accounts
  'GET /admin/users': 'List staff and landowner accounts with search, filters, sorting and paging. Never returns secrets.',
  'GET /admin/users/{id}': 'Account detail with role grants and recent account activity.',
  'POST /admin/users': 'Create an invited staff account and issue a one-time activation link. No password is set by the administrator.',
  'PATCH /admin/users/{id}': 'Update profile fields, with a reason.',
  'POST /admin/users/{id}/status': 'Suspend, deactivate or reactivate an account, with a reason. Not yourself; never the last administrator.',
  'POST /admin/users/{id}/password-reset': 'Start a password reset: the current password stops working and a one-time link is issued.',
  'POST /admin/users/{id}/activation-link': 'Issue a new activation link for an invited account (earlier links are revoked).',
  'POST /admin/users/{id}/roles': 'Grant a role (with county where required), with a reason. Not to yourself.',
  'POST /admin/users/{id}/roles/{grantId}/revoke': 'Revoke a role grant, with a reason. Not your own.',
  'GET /admin/permissions': 'The role-permission matrix as enforced by the server (read-only).',
  // Administration: operations
  'GET /admin/dashboard/summary': 'Dashboard counts, computed live from the database.',
  'GET /admin/dashboard/charts': 'Dashboard chart series for a date range and optional county.',
  'GET /admin/dashboard/activity': 'Recent administrative and workflow events from the audit trail.',
  'GET /admin/health': 'System health from live checks (database, PostGIS, queue, storage, backup, security, audit chain).',
  'GET /admin/overview/applications': 'Read-only overview of cases across counties.',
  'GET /admin/overview/parcels': 'Read-only overview of parcels and staging.',
  'GET /admin/overview/conflicts': 'Read-only overview of spatial conflict findings.',
  'GET /admin/gis-jobs': 'GIS import jobs (staging batches) with validation outcomes.',
  'GET /admin/gis-jobs/{id}': 'One GIS import job with its spatial findings.',
  'GET /admin/counties': 'All 15 counties with boundary source, verification status and enablement.',
  'GET /admin/counties/{id}/boundary': 'A county boundary (GeoJSON).',
  'PATCH /admin/counties/{id}': 'Enable or disable a county for operations, with a reason. Needs a boundary.',
  'POST /admin/counties/{id}/boundary': 'Import a provisional county boundary (multipart GeoJSON), with source and reason.',
  'POST /admin/counties/{id}/verify-boundary': 'Mark a provisional boundary as verified, recording who verified it and against what.',
  'GET /admin/settings': 'System settings on the allow-list.',
  'PUT /admin/settings/{key}': 'Change one allow-listed setting, with a reason.',
  'GET /admin/document-categories': 'Document categories, including inactive ones.',
  'POST /admin/document-categories': 'Add a document category, with a reason.',
  'PATCH /admin/document-categories/{code}': 'Activate or deactivate a category, with a reason. System categories stay active.',
  'GET /admin/backups': 'Database backup history.',
  'POST /admin/backups': 'Run a database backup now (pg_dump custom format), with a reason.',
  'GET /admin/reports': 'Available CSV reports.',
  'GET /admin/reports/{name}.csv': 'Download a report as CSV (audited).',
  // Other
  'GET /notifications': 'Your notifications and the unread count.',
  'POST /notifications/{id}/read': 'Mark one notification as read.',
  'POST /notifications/read-all': 'Mark all your notifications as read.',
  'GET /search': 'Global staff search across parcels, cases, staff and counties, limited to your scope.',
  'GET /document-categories': 'Active document categories for uploads.',
  'GET /audit': 'Audit events. Supervisors and auditors see everything; administrators see security and system events only.',
  'GET /audit/verify': 'Verify the audit hash chain (supervisors and auditors).',
  'GET /me/parcels': 'Landowner: parcels linked to you.',
  'POST /me/document-requests': 'Landowner: request copies of documents for your parcel.',
  'GET /me/document-requests': 'Landowner: your document requests.',
  'POST /me/document-requests/{id}/withdraw': 'Landowner: withdraw a pending request.',
  'GET /me/document-requests/{id}/documents/{docId}/file': 'Landowner: download a document released to you, while the release lasts.',
};

/** Routes that take multipart/form-data uploads. */
export const MULTIPART = new Set(['POST /cases/{id}/geometry', 'POST /cases/{id}/documents', 'POST /admin/counties/{id}/boundary']);
/** Auth routes that work without a session. */
const NO_SESSION = new Set(['POST /auth/login', 'POST /auth/token/inspect', 'POST /auth/token/complete', 'GET /auth/session']);

export interface Mount { path: string; router: Router; access: 'public' | 'internal'; tag: string }

/** Lists every route of the mounted routers as `METHOD /path` with OpenAPI-style `{param}` segments. */
export function listRoutes(mounts: Mount[]) {
  const routes: { key: string; method: string; path: string; mount: Mount }[] = [];
  for (const mount of mounts) {
    for (const layer of (mount.router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
      if (!layer.route) continue;
      const sub = layer.route.path === '/' ? '' : layer.route.path;
      const path = (mount.path + sub).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
        routes.push({ key: `${method.toUpperCase()} ${path}`, method, path, mount });
      }
    }
  }
  return routes;
}

export function buildOpenApi(mounts: Mount[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of listRoutes(mounts)) {
    const needsSession = r.mount.access === 'internal' || (r.mount.path === '/auth' && !NO_SESSION.has(r.key));
    const writes = r.method !== 'get';
    const query = QUERIES.get(r.key);
    const params = [
      ...[...r.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(query ? queryParameters(query) : []),
    ];
    const body = writes ? requestBody(r.key, MULTIPART.has(r.key)) : undefined;
    const responses: Record<string, unknown> = {
      200: { description: 'Success' },
      400: { $ref: '#/components/responses/Invalid' },
    };
    if (needsSession) {
      responses[401] = { $ref: '#/components/responses/Unauthenticated' };
      responses[403] = { $ref: '#/components/responses/Forbidden' };
    }
    if (writes) responses[409] = { $ref: '#/components/responses/Conflict' };
    if (r.mount.access === 'public' || NO_SESSION.has(r.key)) responses[429] = { description: 'Rate limited' };
    paths[r.path] ??= {};
    paths[r.path][r.method] = {
      tags: [r.mount.tag],
      summary: SUMMARIES[r.key] ?? '(no summary)',
      operationId: r.key.replace(/[^A-Za-z0-9]+/g, '_').replace(/_$/, ''),
      ...(params.length ? { parameters: params } : {}),
      ...(body ? { requestBody: body } : {}),
      security: needsSession ? (writes ? [{ session: [], csrf: [] }] : [{ session: [] }]) : [],
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'LAIS-Liberia API',
      version: '0.9.0',
      description: 'Research prototype on synthetic data. Every permission and county restriction is enforced by the server; '
        + 'the role-permission matrix is available at GET /api/admin/permissions. Request bodies and query parameters are '
        + 'generated from the Zod schemas the server validates with, so a request matching them passes input validation. '
        + 'Responses are described in outline only.',
    },
    servers: [{ url: '/api' }],
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'lais_sid', description: 'Server-side session (HttpOnly, SameSite=Strict).' },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required on every state-changing request; returned by GET /auth/session.' },
      },
      responses: {
        Invalid: { description: 'Invalid request: { error, details: [{ path, message }] }' },
        Unauthenticated: { description: 'No active session' },
        Forbidden: { description: 'Not permitted for your role or county (the denial is audited)' },
        Conflict: { description: 'Not allowed in the current state, or a duplicate' },
      },
    },
  };
}
