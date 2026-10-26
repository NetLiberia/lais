// Thin fetch wrapper. All authorization happens on the server; the UI only reflects
// what the server reports (for example a case's allowedActions).

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public body?: any,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; form?: FormData };

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body, credentials: 'same-origin' });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const details = data?.details;
    let message = typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`;
    if (Array.isArray(details) && details[0]?.message) message += `: ${details.map((d: any) => `${d.path ? `${d.path} ` : ''}${d.message}`).join('; ')}`;
    throw new ApiError(res.status, message, details, data);
  }
  return data as T;
}

export interface Grant {
  role: string;
  countyId: number | null;
  county: { id: number; code: string; name: string } | null;
}

export interface Session {
  authenticated: boolean;
  state?: 'active' | 'mfa_pending' | 'enrollment_required';
  csrfToken?: string;
  user?: { id: string; username: string; displayName: string; mfaEnrolled: boolean };
  grants?: Grant[];
}

export const ROLE_LABELS: Record<string, string> = {
  system_admin: 'System Administrator',
  gis_officer: 'GIS Officer',
  processor: 'LAIS Processor',
  registrar: 'Land Registrar',
  supervisor: 'Supervisor',
  auditor: 'Auditor',
  landowner: 'Landowner',
};

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  validating: 'Validating',
  under_review: 'Under review',
  returned: 'Returned',
  approved: 'Approved',
  rejected: 'Rejected',
  published: 'Published',
  withdrawn: 'Withdrawn',
};

export const CASE_TYPE_LABELS: Record<string, string> = {
  first_registration: 'First registration',
  transfer: 'Transfer',
  subdivision: 'Subdivision',
  consolidation: 'Consolidation',
};

export const human = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');
export const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
