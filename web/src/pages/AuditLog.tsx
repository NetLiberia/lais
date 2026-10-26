import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { ErrorBox, useAction, useLoad } from '../components/ui';

export function AuditLog() {
  const [filters, setFilters] = useState({ action: '', outcome: '', actor: '' });
  const [applied, setApplied] = useState(filters);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const { data, error } = useLoad(() => api(`/audit${qs ? `?${qs}` : ''}`), [qs]);
  const verify = useAction();
  const [chain, setChain] = useState<any>(null);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Audit trail</h1>
        {data?.scope === 'all' && (
          <button className="secondary" onClick={() => void verify.run(async () => setChain(await api('/audit/verify')))}>Verify hash chain</button>
        )}
      </div>
      {data?.scope === 'technical' && <div className="alert info">System administrators see technical events (sign-ins and account administration) only.</div>}
      {chain && (
        <div className={`alert ${chain.intact ? 'ok' : 'error'}`}>
          {chain.intact ? `Chain intact: ${chain.checked} events verified.` : `Chain broken at event #${chain.firstBadSeq} (${chain.checked} checked). Investigate immediately.`}
        </div>
      )}
      <ErrorBox error={error ?? verify.error} />
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}>
        <input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="Action prefix, e.g. case. or authz.denied" />
        <select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">Any outcome</option><option value="success">success</option><option value="denied">denied</option><option value="failure">failure</option>
        </select>
        <input value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} placeholder="Username" />
        <button type="submit">Filter</button>
      </form>
      <table className="table audit">
        <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Outcome</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>
          {data?.events.map((e: any) => (
            <tr key={e.chain_seq} className={`o-${e.outcome}`}>
              <td>{e.chain_seq}</td>
              <td className="small">{fmtDate(e.at)}</td>
              <td>{e.actor_username ?? '—'}</td>
              <td><code>{e.action}</code></td>
              <td>{e.outcome}</td>
              <td className="small">{e.case_id ? <Link to={`/work/cases/${e.case_id}`}>case</Link> : e.entity_type}{e.county_id ? ` · county ${e.county_id}` : ''}</td>
              <td className="small"><code>{JSON.stringify(e.detail)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
