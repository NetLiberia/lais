import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { AuthProvider } from '../auth';
import { ToastProvider } from '../components/kit';
import type { Session } from '../api';

type Handler = unknown | ((init: RequestInit | undefined, url: URL) => unknown);

/**
 * Replaces fetch with canned API responses keyed by "METHOD /path" or "/path" (GET). A handler that
 * throws a `{ status, error }` object becomes an error response. Unknown requests fail the test loudly.
 */
export function stubApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, path: path + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${path}`] ?? (method === 'GET' ? routes[path] : undefined);
    if (handler === undefined) throw new Error(`Unexpected request in test: ${method} ${path}`);
    try {
      const value = typeof handler === 'function' ? (handler as (i: RequestInit | undefined, u: URL) => unknown)(init, url) : handler;
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      const { status = 500, error = 'error' } = e as { status?: number; error?: string };
      return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

export function sessionFor(role: string, capabilities: string[], county: { id: number; code: string; name: string } | null = null): Session {
  return {
    authenticated: true,
    state: 'active',
    csrfToken: 'test-csrf',
    user: { id: 'u1', username: `${role}.test`, displayName: `Test ${role}`, mfaEnrolled: false },
    grants: [{ role, countyId: county?.id ?? null, county }],
    capabilities,
    banner: null,
  };
}

/** Renders inside the same providers as the app (router, query client, toasts, auth). */
export function renderApp(ui: ReactElement, { path = '/' }: { path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AuthProvider>{ui}</AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
