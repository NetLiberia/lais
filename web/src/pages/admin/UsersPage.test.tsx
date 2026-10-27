import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFor, stubApi } from '../../test/render';
import { UsersPage } from './UsersPage';

const COUNTIES = [
  { id: 1, code: 'MO', name: 'Montserrado', enabled: true },
  { id: 3, code: 'BG', name: 'Bong', enabled: false },
];
const USERS = {
  items: [{
    id: 'u-reg', username: 'reg.mo', display_name: 'Land Registrar, Montserrado', email: 'reg.mo@example.invalid', staff_id: 'SYN-005',
    department: null, status: 'active', last_login_at: null, created_at: '2026-10-27T06:00:00Z', roles: [{ id: 'g1', role: 'registrar', countyCode: 'MO' }],
  }],
  total: 1, page: 1, pageSize: 25,
};
const ADMIN = sessionFor('system_admin', ['users.read', 'user.manage', 'roles.assign', 'reports.export']);

async function openCreateForm() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Create staff account' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Create staff account' }));
  await user.type(dialog.getByLabelText('Full name'), 'Deddeh Testperson');
  await user.type(dialog.getByLabelText('Username'), 'reg2.mo');
  await user.type(dialog.getByLabelText('Authorization reference or reason'), 'SYNTHETIC delegation DI-1');
  return { user, dialog };
}

describe('User management', () => {
  it('lists accounts from the API', async () => {
    stubApi({ '/auth/session': ADMIN, '/admin/users': USERS, '/admin/counties': COUNTIES });
    renderApp(<UsersPage />, { path: '/admin/users' });
    expect(await screen.findByText('reg.mo')).toBeInTheDocument();
    expect(screen.getByText('Land Registrar (MO)')).toBeInTheDocument();
  });

  it('refuses to create a registrar without a county, before contacting the server', async () => {
    const calls = stubApi({ '/auth/session': ADMIN, '/admin/users': USERS, '/admin/counties': COUNTIES });
    renderApp(<UsersPage />, { path: '/admin/users' });
    const { user, dialog } = await openCreateForm();
    await user.selectOptions(dialog.getByLabelText('Role'), 'registrar');
    await user.click(dialog.getByRole('button', { name: /Create and get activation link/ }));

    expect(await dialog.findByText('This role needs an assigned county')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('offers no surveyor role', async () => {
    stubApi({ '/auth/session': ADMIN, '/admin/users': USERS, '/admin/counties': COUNTIES });
    renderApp(<UsersPage />, { path: '/admin/users' });
    const { dialog } = await openCreateForm();
    const options = within(dialog.getByLabelText('Role')).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.some((o) => /survey/i.test(o))).toBe(false);
  });

  it('creates an invited account and shows the activation link once, with no password field anywhere', async () => {
    const calls = stubApi({
      '/auth/session': ADMIN, '/admin/users': USERS, '/admin/counties': COUNTIES,
      'POST /admin/users': { user: { username: 'reg2.mo' }, activation: { path: '/account/complete?token=one-time', expiresAt: '2026-10-30T07:00:00Z' } },
    });
    renderApp(<UsersPage />, { path: '/admin/users' });
    const { user, dialog } = await openCreateForm();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText('Role'), 'registrar');
    await user.selectOptions(dialog.getByLabelText('County'), '1');
    await user.click(dialog.getByRole('button', { name: /Create and get activation link/ }));

    const link = await screen.findByRole('dialog', { name: 'Activation link' });
    expect(within(link).getByText(/account\/complete\?token=one-time/)).toBeInTheDocument();
    expect(within(link).getByText(/only once/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ username: 'reg2.mo', roles: [{ role: 'registrar', countyId: 1 }], reason: 'SYNTHETIC delegation DI-1' });
    expect(JSON.stringify(post.body)).not.toMatch(/password/i);
  });

  it('shows the server refusal inside the form', async () => {
    stubApi({
      '/auth/session': ADMIN, '/admin/users': USERS, '/admin/counties': COUNTIES,
      'POST /admin/users': () => { throw { status: 409, error: 'That username is already in use' }; },
    });
    renderApp(<UsersPage />, { path: '/admin/users' });
    const { user, dialog } = await openCreateForm();
    await user.click(dialog.getByRole('button', { name: /Create and get activation link/ }));
    await user.selectOptions(dialog.getByLabelText('County'), '1');
    await user.click(dialog.getByRole('button', { name: /Create and get activation link/ }));
    expect(await dialog.findByText('That username is already in use')).toBeInTheDocument();
  });

  it('gives a supervisor a read-only view: no create or export without the capability', async () => {
    stubApi({ '/auth/session': sessionFor('supervisor', ['users.read']), '/admin/users': USERS, '/admin/counties': COUNTIES });
    renderApp(<UsersPage />, { path: '/admin/users' });
    expect(await screen.findByText('reg.mo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create staff account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
  });
});
