import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { api, ROLE_LABELS } from '../../api';
import { Panel, QueryState } from '../../components/kit';

interface Permission { action: string; description: string; roles: string[]; scope: 'county' | 'global'; statuses: string[] | null; caseTypes: string[] | null; separation: string | null }
interface Matrix { roles: { role: string; activeUsers: number; countyScoped: boolean }[]; permissions: Permission[] }

const GROUPS: [string, RegExp][] = [
  ['Cases and decisions', /^case\./], ['Registry records', /^(parcel|document)\./], ['Parties', /^party\./],
  ['Document requests', /^docrequest\./], ['Administration', /^(user|users|roles|counties|dashboard|gis|system|backups|reports)\./],
  ['Audit', /^audit\./], ['Landowner portal', /^landowner\./],
];

/** Read-only view of the permission matrix enforced by the server. Changing it is a reviewed code change, not a setting. */
export function RolesPage() {
  const matrix = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api<Matrix>('/admin/permissions') });
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const perms = (matrix.data?.permissions ?? []).filter((p) => !filter || `${p.action} ${p.description}`.toLowerCase().includes(filter.toLowerCase()));
    return GROUPS.map(([name, re]) => ({ name, perms: perms.filter((p) => re.test(p.action)) })).filter((g) => g.perms.length);
  }, [matrix.data, filter]);

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Roles & Permissions</h1>
          <p className="muted">
            What each role may do, exactly as the server enforces it on every request. Permissions are defined in reviewed code, not editable here,
            so nobody, including an administrator, can grant themselves legal authority. Assign roles to people under User Management.
          </p>
        </div>
      </div>
      <QueryState query={matrix}>
        {(m) => (
          <>
            <div className="role-cards">
              {m.roles.map((r) => (
                <div key={r.role} className="role-card">
                  <strong>{ROLE_LABELS[r.role] ?? r.role}</strong>
                  <span className="muted small">{r.activeUsers} active account(s)</span>
                  <span className="tiny muted">{r.countyScoped ? 'Acts only in assigned counties' : 'National scope'}</span>
                </div>
              ))}
            </div>
            <Panel title="Permission matrix" actions={<input type="search" aria-label="Filter permissions" placeholder="Filter permissions" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
              <div className="table-wrap">
                <table className="table matrix">
                  <caption className="sr-only">Permissions by role</caption>
                  <thead>
                    <tr><th>Permission</th>{m.roles.map((r) => <th key={r.role} className="matrix-role">{ROLE_LABELS[r.role] ?? r.role}</th>)}<th>Conditions</th></tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g.name}>
                      <tr className="matrix-group"><th colSpan={m.roles.length + 2} scope="colgroup">{g.name}</th></tr>
                      {g.perms.map((p) => (
                        <tr key={p.action}>
                          <th scope="row"><code className="small">{p.action}</code><div className="muted tiny">{p.description}</div></th>
                          {m.roles.map((r) => (
                            <td key={r.role} className="matrix-cell">
                              {p.roles.includes(r.role)
                                ? <><Check size={16} className="ok-text" aria-hidden /><span className="sr-only">allowed</span></>
                                : <><Minus size={16} className="muted" aria-hidden /><span className="sr-only">not allowed</span></>}
                            </td>
                          ))}
                          <td className="tiny muted">
                            {[p.scope === 'county' ? 'own county only' : null, p.statuses ? `case status: ${p.statuses.join(', ').replace(/_/g, ' ')}` : null,
                              p.caseTypes ? `case types: ${p.caseTypes.join(', ').replace(/_/g, ' ')}` : null,
                              p.separation === 'not_contributor' ? 'not on cases they prepared' : p.separation === 'creator_only' ? 'creator only' : null].filter(Boolean).join(' · ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}
