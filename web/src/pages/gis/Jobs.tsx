import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../api';
import { Drawer, EmptyState, ErrorBanner, fmtDateTime, Pagination, Panel, QueryState, useToast } from '../../components/kit';
import type { GisJobDetail, GisJobList, ImportResult, JobStatus } from '../../types';
import { downloadFile, fmtBytes, JOB_KIND_LABELS, JOB_STATUS_LABELS, JobStatusBadge, qs } from './common';

const STATUSES = Object.keys(JOB_STATUS_LABELS) as JobStatus[];

/** GIS processing jobs: imports, ArcMap syncs and attribute corrections, with diagnostics and retry. */
export function GisJobs() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const kind = params.get('kind') ?? '';
  const page = Number(params.get('page') ?? 1);
  const jobId = params.get('job');
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page' && k !== 'job') p.delete('page'); setParams(p); };
  const list = useQuery({
    queryKey: ['gis', 'jobs', status, kind, page],
    queryFn: () => api<GisJobList>(`/gis/jobs${qs(status && `status=${status}`, kind && `kind=${kind}`, `page=${page}`, 'pageSize=25')}`),
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : 30_000),
  });

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>GIS Processing Jobs</h1><p className="muted small">Each job either stages a complete new version or nothing at all. Failed jobs keep their reason; a retry is a new job linked to the old one.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <div className="segmented" role="group" aria-label="Status">
            <button className={status === '' ? 'active' : ''} onClick={() => set('status', null)}>All</button>
            {STATUSES.map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => set('status', s)}>{JOB_STATUS_LABELS[s]} {list.data?.counts[s] ? `(${list.data.counts[s]})` : ''}</button>)}
          </div>
          <label className="inline">Kind
            <select value={kind} onChange={(e) => set('kind', e.target.value || null)}>
              <option value="">All</option>{Object.entries(JOB_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No jobs match" />}>
        {(d) => (
          <Panel>
            <div className="table-wrap"><table className="table data-table">
              <thead><tr><th>Job</th><th>Kind</th><th>Case</th><th>Source</th><th>CRS</th><th>Records</th><th>Status</th><th>Officer</th><th>Started</th><th>Duration</th></tr></thead>
              <tbody>{d.items.map((j) => (
                <tr key={j.id} className="row-click" tabIndex={0} onClick={() => set('job', j.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('job', j.id); }}>
                  <td>{j.job_no}</td><td>{JOB_KIND_LABELS[j.kind]}</td><td>{j.case_no}</td><td className="small">{j.source_name}</td>
                  <td>{j.source_crs_declared ? `EPSG:${j.source_crs_declared}` : '—'}{j.source_crs_detected === null && j.source_crs_declared && <div className="muted small">declared</div>}</td>
                  <td>{j.records_accepted ?? 0}/{j.records_received ?? 0}{j.records_rejected ? <div className="muted small">{j.records_rejected} rejected</div> : null}</td>
                  <td><JobStatusBadge status={j.status} /></td><td>{j.initiated_by_username}</td><td>{fmtDateTime(j.started_at ?? j.created_at)}</td><td>{j.duration_s ? `${j.duration_s} s` : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => set('page', String(p))} />
          </Panel>
        )}
      </QueryState>
      {jobId && <JobDrawer id={jobId} onClose={() => set('job', null)} onOpen={(id) => set('job', id)} />}
    </div>
  );
}

function JobDrawer({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const job = useQuery({ queryKey: ['gis', 'job', id], queryFn: () => api<GisJobDetail>(`/gis/jobs/${id}`), refetchInterval: (q) => (['queued', 'running'].includes(q.state.data?.status ?? '') ? 2000 : false) });
  const retry = async () => {
    try {
      const r = await api<ImportResult>(`/gis/jobs/${id}/retry`, { method: 'POST' });
      toast(r.job?.status === 'failed' ? 'error' : 'success', `Retry ${r.jobNo}: ${r.job ? JOB_STATUS_LABELS[r.job.status] : 'queued'}`);
      void qc.invalidateQueries({ queryKey: ['gis'] });
      onOpen(r.jobId);
    } catch (e) { toast('error', (e as Error).message); }
  };
  const cancel = async () => {
    try { await api(`/gis/jobs/${id}/cancel`, { method: 'POST' }); void qc.invalidateQueries({ queryKey: ['gis'] }); } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <Drawer open title={job.data ? `${job.data.job_no}` : 'Job'} subtitle={job.data && <JobStatusBadge status={job.data.status} />} onClose={onClose}>
      <QueryState query={job}>
        {(j) => (
          <div className="stack">
            {j.error_summary && <ErrorBanner error={j.error_summary} />}
            <dl className="facts small">
              <dt>Kind</dt><dd>{JOB_KIND_LABELS[j.kind]}</dd>
              <dt>Case</dt><dd><Link to={`/work/cases/${j.case_id}`}>{j.case_no}</Link> ({j.county_code})</dd>
              <dt>Source</dt><dd>{j.source_name} · {j.source_format}{j.source_layer ? ` · layer ${j.source_layer}` : ''} · {fmtBytes(j.source_size_bytes)}</dd>
              <dt>File hash</dt><dd><code>{j.source_sha256?.slice(0, 24) ?? '—'}…</code></dd>
              <dt>CRS</dt><dd>{j.source_crs_detected ? `EPSG:${j.source_crs_detected} (file metadata)` : j.source_crs_declared ? `EPSG:${j.source_crs_declared} declared: ${j.crs_exception_reason}` : 'unknown'} → stored as EPSG:{j.target_crs}</dd>
              {j.export_id && <><dt>ArcMap export</dt><dd><code>{j.export_id}</code> · adapter {j.adapter_version} · {j.source_dataset}</dd></>}
              <dt>Field mapping</dt><dd><code>{Object.keys(j.field_mapping ?? {}).length ? JSON.stringify(j.field_mapping) : 'none'}</code></dd>
              <dt>Records</dt><dd>{j.records_received ?? 0} received · {j.records_accepted ?? 0} accepted · {j.records_rejected ?? 0} rejected · {j.records_unchanged ?? 0} unchanged</dd>
              <dt>Version</dt><dd>{j.version_no ? <Link to={`/gis/versions?case=${j.case_id}`}>Version {j.version_no}</Link> : 'none staged'}</dd>
              <dt>Purpose</dt><dd>{j.purpose ?? '—'}</dd>
              <dt>Officer</dt><dd>{j.initiated_by_username}</dd>
              <dt>Timing</dt><dd>created {fmtDateTime(j.created_at)} · finished {fmtDateTime(j.finished_at)} · {j.duration_s ?? '—'} s</dd>
              {j.retry_of_job_no && <><dt>Retry of</dt><dd><button className="link" onClick={() => onOpen(j.retry_of!)}>{j.retry_of_job_no}</button></dd></>}
            </dl>
            <h3>Diagnostic</h3>
            <ul className="check-list">{j.diagnostic.map((d) => <li key={d.step}>{d.ok ? <CheckCircle2 size={16} className="ok-text" /> : <XCircle size={16} className="warn-text" />} <strong>{d.step}</strong>: {d.detail}</li>)}</ul>
            {j.rejections.length > 0 && <><h3>Rejected records ({j.rejections.length})</h3><ul className="small">{j.rejections.slice(0, 30).map((r) => <li key={r.record}>Record {r.record}: {r.reason}</li>)}</ul></>}
            {j.warnings.length > 0 && <><h3>Warnings ({j.warnings.length})</h3><ul className="small">{j.warnings.slice(0, 30).map((w) => <li key={w}>{w}</li>)}</ul></>}
            <div className="chip-row">
              <button className="secondary" onClick={() => void downloadFile(`/gis/jobs/${j.id}/report.csv`, `${j.job_no}-report.csv`)}>Error report (CSV)</button>
              {j.canRetry && <button onClick={() => void retry()}>Retry</button>}
              {j.status === 'queued' && <button className="danger-btn" onClick={() => void cancel()}>Cancel</button>}
            </div>
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}
