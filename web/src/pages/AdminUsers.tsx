import { useState, type FormEvent } from 'react';
import { api, ROLE_LABELS } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Section, useAction, useLoad } from '../components/ui';

const COUNTY_ROLES = ['gis_officer', 'processor', 'registrar'];

export function AdminUsers() {
  const { session } = useAuth();
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/users'));
  const counties = useLoad(() => api('/public/counties'));
  const action = useAction();
  const [newUser, setNewUser] = useState({ username: '', displayName: '', temporaryPassword: '' });
  const [grant, setGrant] = useState({ userId: '', role: 'gis_officer', countyId: '', reason: '' });

  const after = async (ok: boolean) => ok && (await reload());

  const create = async (e: FormEvent) => {
    e.preventDefault();
    await after(await action.run(() => api('/admin/users', { body: newUser })));
    setNewUser({ username: '', displayName: '', temporaryPassword: '' });
  };
  const addRole = async (e: FormEvent) => {
    e.preventDefault();
    const countyId = COUNTY_ROLES.includes(grant.role) || (grant.role === 'supervisor' && grant.countyId) ? Number(grant.countyId) : null;
    await after(await action.run(() => api(`/admin/users/${grant.userId}/roles`, { body: { role: grant.role, countyId, reason: grant.reason } })));
  };
  const revoke = async (userId: string, grantId: string) => {
    const reason = window.prompt('Reason for revoking this role:');
    if (reason) await after(await action.run(() => api(`/admin/users/${userId}/roles/${grantId}/revoke`, { body: { reason } })));
  };
  const setStatus = async (userId: string, status: string) => {
    const reason = window.prompt(`Reason for setting the account to ${status}:`);
    if (reason) await after(await action.run(() => api(`/admin/users/${userId}/status`, { body: { status, reason } })));
  };

  return (
    <div className="page">
      <h1>User accounts</h1>
      <p className="muted">Administrators manage accounts and role assignments but cannot approve land records, and cannot change their own account. Every change is audited.</p>
      <ErrorBox error={error ?? action.error} />
      <table className="table">
        <thead><tr><th>User</th><th>Status</th><th>MFA</th><th>Roles</th><th /></tr></thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id} className={u.status !== 'active' ? 'muted' : ''}>
              <td><strong>{u.username}</strong><div className="small">{u.display_name}</div></td>
              <td>{u.status}</td>
              <td>{u.mfa_enrolled ? 'yes' : 'no'}</td>
              <td>
                {u.roles.map((r: any) => (
                  <div key={r.id} className="small">
                    {ROLE_LABELS[r.role]}{r.countyCode && ` (${r.countyCode})`}
                    {u.id !== session?.user?.id && <button className="link" onClick={() => void revoke(u.id, r.id)}>revoke</button>}
                  </div>
                ))}
              </td>
              <td>
                {u.id !== session?.user?.id && (u.status === 'active'
                  ? <button className="link danger" onClick={() => void setStatus(u.id, 'suspended')}>Suspend</button>
                  : <button className="link" onClick={() => void setStatus(u.id, 'active')}>Reactivate</button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid-2">
        <Section title="Create account">
          <form onSubmit={create} className="stack">
            <label>Username<input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required /></label>
            <label>Display name<input value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} required /></label>
            <label>Temporary password (12+)<input type="password" value={newUser.temporaryPassword} minLength={12} onChange={(e) => setNewUser({ ...newUser, temporaryPassword: e.target.value })} required /></label>
            <button type="submit">Create</button>
          </form>
        </Section>
        <Section title="Assign a role">
          <form onSubmit={addRole} className="stack">
            <label>User
              <select value={grant.userId} onChange={(e) => setGrant({ ...grant, userId: e.target.value })} required>
                <option value="">Choose…</option>
                {data?.filter((u) => u.id !== session?.user?.id).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </label>
            <label>Role
              <select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>
                {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {(COUNTY_ROLES.includes(grant.role) || grant.role === 'supervisor') && (
              <label>County {grant.role === 'supervisor' && '(blank = national)'}
                <select value={grant.countyId} onChange={(e) => setGrant({ ...grant, countyId: e.target.value })} required={grant.role !== 'supervisor'}>
                  <option value="">{grant.role === 'supervisor' ? 'National' : 'Choose…'}</option>
                  {counties.data?.features.map((f: any) => <option key={f.properties.id} value={f.properties.id}>{f.properties.name}</option>)}
                </select>
              </label>
            )}
            <label>Authorization reference / reason<input value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} required minLength={5} /></label>
            <button type="submit">Assign</button>
          </form>
        </Section>
      </div>
    </div>
  );
}
