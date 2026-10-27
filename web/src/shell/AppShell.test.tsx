import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAuth } from '../auth';
import { renderApp, sessionFor, stubApi } from '../test/render';
import { AppShell } from './AppShell';

const ADMIN_CAPS = ['dashboard.view', 'users.read', 'user.manage', 'roles.assign', 'counties.read', 'counties.manage', 'gis.sync.read',
  'system.health', 'system.configure', 'backups.run', 'reports.export', 'audit.view_technical'];
const GIS_CAPS = ['case.view', 'case.create', 'case.import_geometry', 'counties.read'];
const MONTSERRADO = { id: 1, code: 'MO', name: 'Montserrado' };

function Shell() {
  const { session } = useAuth();
  return session ? <AppShell><p>page content</p></AppShell> : null;
}

const nav = async () => within(await screen.findByRole('navigation', { name: 'Main navigation' }));

describe('AppShell navigation', () => {
  it('shows the administrator the administration pages and no casework', async () => {
    stubApi({ '/auth/session': sessionFor('system_admin', ADMIN_CAPS), '/notifications': { items: [], unread: 0 } });
    renderApp(<Shell />, { path: '/admin' });
    const sidebar = await nav();
    for (const label of ['Dashboard', 'User Management', 'Roles & Permissions', 'County Management', 'GIS Synchronization', 'Settings', 'Audit & Security Logs']) {
      expect(sidebar.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(sidebar.queryByRole('link', { name: 'Cases' })).not.toBeInTheDocument();
    expect(screen.getByText(/System-wide/)).toBeInTheDocument();
  });

  it('shows a GIS officer casework only, scoped to their county', async () => {
    stubApi({ '/auth/session': sessionFor('gis_officer', GIS_CAPS, MONTSERRADO), '/notifications': { items: [], unread: 0 } });
    renderApp(<Shell />, { path: '/work' });
    const sidebar = await nav();
    expect(sidebar.getByRole('link', { name: 'Cases' })).toBeInTheDocument();
    for (const label of ['User Management', 'Settings', 'Dashboard', 'Audit & Security Logs']) {
      expect(sidebar.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/MO/)).toBeInTheDocument();
  });

  it('shows the unread notification count from the API', async () => {
    stubApi({
      '/auth/session': sessionFor('system_admin', ADMIN_CAPS),
      '/notifications': { items: [{ id: 'n1', category: 'account', title: 'Account locked', body: null, link: null, created_at: '2026-10-27T07:00:00Z', read_at: null }], unread: 1 },
    });
    renderApp(<Shell />, { path: '/admin' });
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
  });
});
