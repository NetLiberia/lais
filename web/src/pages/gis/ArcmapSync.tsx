import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Download, KeyRound, Stethoscope, XCircle } from 'lucide-react';
import { api } from '../../api';
import { Badge, EmptyState, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, useToast } from '../../components/kit';
import type { SyncDiagnostic, SyncStatus, SyncToken } from '../../types';
import { downloadFile, JobStatusBadge } from './common';

/**
 * ArcMap 10.x synchronization. The adapter (a Python toolbox) exports a package and uploads it with a
 * personal token; the page shows what the server has observed. It cannot see ArcMap, so it never claims
 * a live connection.
 */
export function ArcmapSync() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['gis', 'sync', 'status'], queryFn: () => api<SyncStatus>('/gis/sync/status'), refetchInterval: 30_000 });
  const tokens = useQuery({ queryKey: ['gis', 'sync', 'tokens'], queryFn: () => api<SyncToken[]>('/gis/sync/tokens') });
  const [diag, setDiag] = useState<SyncDiagnostic | null>(null);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(30);
  const [created, setCreated] = useState<(SyncToken & { token: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['gis', 'sync'] });
  const create = useMutation({
    mutationFn: () => api<SyncToken & { token: string }>('/gis/sync/tokens', { body: { label, days } }),
    onSuccess: (t) => { setCreated(t); setLabel(''); refresh(); },
    onError: (e) => setError((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/gis/sync/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('success', 'Token revoked: the adapter can no longer use it'); refresh(); },
    onError: (e) => toast('error', (e as Error).message),
  });
  const runDiagnostic = async () => {
    try { setDiag(await api<SyncDiagnostic>('/gis/sync/diagnostic')); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>ArcMap Synchronization</h1>
          <p className="muted small">The LAIS adapter for ArcMap 10.x exports a polygon layer as a package and uploads it with your personal token. It never connects to the database and never assigns a coordinate system.</p>
        </div>
        <div className="page-actions">
          <button className="secondary" onClick={() => void downloadFile('/gis/sync/adapter.zip', 'lais-arcmap-adapter.zip')}><Download size={16} /> Download adapter</button>
          <button className="secondary" onClick={() => void runDiagnostic()}><Stethoscope size={16} /> Run diagnostic</button>
        </div>
      </div>
      <ErrorBanner error={error} />

      <QueryState query={status}>
        {(s) => (
          <Panel title="Status">
            <p><Badge value={s.state === 'configured' ? 'active' : s.state === 'token_unused' ? 'warning' : 'unconfigured'} label={s.state.replace(/_/g, ' ')} /> {s.explanation}</p>
            <div className="facts small">
              <span>Last contact: <strong>{fmtDateTime(s.lastContact)}</strong></span>
              <span>Last successful sync: <strong>{fmtDateTime(s.last_success)}</strong></span>
              <span>Last failure: <strong>{fmtDateTime(s.last_failure)}</strong></span>
              <span>Syncs in 7 days: <strong>{s.total_7d}</strong> ({s.failed_7d} failed)</span>
              <span>Adapter version on the server: <strong>{s.adapterVersion}</strong></span>
            </div>
          </Panel>
        )}
      </QueryState>

      {diag && (
        <Panel title="Diagnostic">
          <ul className="check-list">{diag.checks.map((c) => <li key={c.check}>{c.ok ? <CheckCircle2 size={16} className="ok-text" /> : <XCircle size={16} className="warn-text" />} <strong>{c.check}</strong>: {c.detail}</li>)}</ul>
          <p className="muted small">Endpoint for the adapter: <code>{window.location.origin}/api/gis/arcmap</code> (set LAIS_URL to <code>{window.location.origin}</code>). Accepted CRS: {diag.acceptedCrs.map((c) => `EPSG:${c}`).join(', ')}.</p>
        </Panel>
      )}

      <Panel title="Sync tokens" actions={<span className="muted small">A token works only for the ArcMap endpoints, carries your own county permissions, and can be revoked at any time.</span>}>
        <QueryState query={tokens} isEmpty={(t) => t.length === 0} empty={<EmptyState title="No tokens yet" icon={<KeyRound size={20} />}>Create one below to configure the adapter.</EmptyState>}>
          {(t) => (
            <table className="table">
              <thead><tr><th>Label</th><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Last used</th><th /></tr></thead>
              <tbody>{t.map((x) => (
                <tr key={x.id}>
                  <td>{x.label}</td><td><code>lais_sync_…{x.token_hint}</code></td><td><Badge value={x.status === 'active' ? 'active' : x.status === 'expired' ? 'superseded' : 'deactivated'} label={x.status} /></td>
                  <td>{fmtDateTime(x.created_at)}</td><td>{fmtDateTime(x.expires_at)}</td><td>{fmtDateTime(x.last_used_at)}</td>
                  <td>{x.status === 'active' && <button className="danger-btn small-btn" onClick={() => revoke.mutate(x.id)}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </QueryState>
        <div className="filter-bar">
          <label>Label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Office workstation ArcMap 10.7" maxLength={80} /></label>
          <label>Valid for
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
          </label>
          <button disabled={label.trim().length < 3 || create.isPending} onClick={() => { setError(null); create.mutate(); }}><KeyRound size={16} /> Create token</button>
        </div>
      </Panel>

      <QueryState query={status}>
        {(s) => (
          <Panel title="Recent ArcMap sync jobs" actions={<Link to="/gis/jobs?kind=arcmap_sync">All sync jobs</Link>}>
            {s.jobs.length === 0 ? <EmptyState title="No sync jobs yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Job</th><th>Case</th><th>Status</th><th>Export</th><th>Records</th><th>Officer</th><th>When</th><th /></tr></thead>
                <tbody>{s.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.job_no}{j.retry_of_job_no && <div className="muted small">retry of {j.retry_of_job_no}</div>}</td><td>{j.case_no}</td><td><JobStatusBadge status={j.status} /></td>
                    <td className="small"><code>{j.export_id ?? '—'}</code><div className="muted">adapter {j.adapter_version ?? '?'}</div></td>
                    <td>{j.records_accepted ?? 0}/{j.records_received ?? 0}</td><td>{j.initiated_by_username}</td><td>{fmtDateTime(j.created_at)}</td>
                    <td><Link to={`/gis/jobs?job=${j.id}`}>Details</Link></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <p className="muted small">To upload a package by hand (for example one exported on a machine without network access), use the <Link to="/gis/import">Data Import Center</Link>: packages are recognised by their manifest.</p>
          </Panel>
        )}
      </QueryState>

      <Modal open={!!created} title="Your new sync token" onClose={() => setCreated(null)} footer={<button onClick={() => setCreated(null)}>I have stored it</button>}>
        <p><strong>Copy it now: it is shown only once.</strong> LAIS stores only a hash.</p>
        <div className="copy-row"><code className="copy-value">{created?.token}</code>
          <button className="icon-btn" aria-label="Copy token" onClick={() => { void navigator.clipboard?.writeText(created?.token ?? ''); toast('info', 'Copied'); }}><Copy size={16} /></button>
        </div>
        <p className="small">Configure the adapter with an environment variable or a file only you can read:</p>
        <pre className="json-block">{`setx LAIS_URL ${window.location.origin}
rem Either: setx LAIS_SYNC_TOKEN <token>
rem Or save the token in %USERPROFILE%\\.lais\\sync_token`}</pre>
        <p className="muted small">Never put the token in a shared folder, a project file or a script. Revoke it here if it may have been exposed.</p>
      </Modal>
    </div>
  );
}
