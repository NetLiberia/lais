import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api, CASE_TYPE_LABELS } from '../../api';
import { Badge, DataTable, Drawer, EmptyState, fmtDateTime, Pagination, Panel, QueryState, type Column } from '../../components/kit';

interface Job {
  id: string; source_filename: string; declared_srid: number; received: number; accepted: number; rejected: number; published_parcels: number;
  started_at: string; validated_at: string | null; errors: number; warnings: number; status: string; case_no: string; case_type: string;
  county_code: string; county_name: string; uploaded_by: string;
}
interface JobDetail {
  job: { id: string; source_filename: string; declared_srid: number; file_sha256: string; received: number; started_at: string; batch_status: string; case_no: string; case_type: string; county_name: string; uploaded_by: string };
  features: { feature_index: number; structural_ok: boolean; structural_message: string | null; excluded: boolean; exclusion_reason: string | null; legacy_ref: string | null; published: boolean }[];
  runs: { run_at: string; purpose: string; error_count: number; warning_count: number }[];
  findings: { code: string; severity: string; message: string; feature_index: number | null; acknowledged: boolean }[];
}

const STATUSES = ['awaiting_validation', 'failed_validation', 'passed_validation', 'published', 'superseded'];

function JobDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['admin', 'gis-job', id], queryFn: () => api<JobDetail>(`/admin/gis-jobs/${id}`) });
  return (
    <Drawer open title="Import job" subtitle={detail.data && `${detail.data.job.source_filename} · ${detail.data.job.case_no}`} onClose={onClose}>
      <QueryState query={detail}>
        {(d) => (
          <div className="stack">
            <dl className="facts">
              <dt>Case</dt><dd>{d.job.case_no} ({CASE_TYPE_LABELS[d.job.case_type] ?? d.job.case_type}), {d.job.county_name}</dd>
              <dt>Uploaded by</dt><dd>{d.job.uploaded_by}, {fmtDateTime(d.job.started_at)}</dd>
              <dt>Declared CRS</dt><dd>EPSG:{d.job.declared_srid}</dd>
              <dt>File SHA-256</dt><dd><code className="tiny">{d.job.file_sha256}</code></dd>
              <dt>Features</dt><dd>{d.job.received} received · {d.features.filter((f) => f.structural_ok && !f.excluded).length} accepted · {d.features.filter((f) => f.published).length} published</dd>
            </dl>
            <Panel title="Validation runs">
              {d.runs.length === 0 ? <EmptyState title="Not validated yet" /> : (
                <ul className="plain small">{d.runs.map((r) => <li key={r.run_at}>{fmtDateTime(r.run_at)} · {r.purpose} · {r.error_count} error(s), {r.warning_count} warning(s)</li>)}</ul>
              )}
            </Panel>
            <Panel title="Spatial and data findings (latest run)">
              {d.findings.length === 0 ? <EmptyState title="No spatial findings" /> : (
                <ul className="findings">
                  {d.findings.map((f, i) => (
                    <li key={i} className={f.severity}>
                      <Badge value={f.severity === 'error' ? 'error' : 'warning'} label={f.severity} /> <code className="small">{f.code}</code>
                      {f.feature_index !== null && <span className="muted small"> · feature {f.feature_index + 1}</span>}
                      {f.acknowledged && <span className="ok-text small"> · acknowledged</span>}
                      <div className="small">{f.message}</div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted tiny">Findings about parties, rights and documents are not shown here; county officers see them on the case.</p>
            </Panel>
            {d.features.length > 1 && (
              <Panel title="Features">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>#</th><th>Legacy ref</th><th>Geometry</th><th>Outcome</th></tr></thead>
                    <tbody>{d.features.map((f) => (
                      <tr key={f.feature_index}>
                        <td>{f.feature_index + 1}</td><td>{f.legacy_ref ?? '—'}</td>
                        <td>{f.structural_ok ? 'valid' : <span className="danger small">{f.structural_message}</span>}</td>
                        <td className="small">{f.published ? 'published' : f.excluded ? `excluded: ${f.exclusion_reason}` : 'pending'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </Panel>
            )}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

export function GisSyncPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  const jobs = useQuery({
    queryKey: ['admin', 'gis-jobs', status, page, pageSize],
    queryFn: () => api<{ items: Job[]; total: number }>(`/admin/gis-jobs?page=${page}&pageSize=${pageSize}${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const columns: Column<Job>[] = [
    { key: 'started', header: 'Started', render: (j) => <span className="small">{fmtDateTime(j.started_at)}</span> },
    { key: 'source', header: 'Source file', render: (j) => <><span className="small">{j.source_filename}</span><div className="muted tiny">EPSG:{j.declared_srid} · {j.uploaded_by}</div></> },
    { key: 'case', header: 'Case', render: (j) => <>{j.case_no}<div className="muted tiny">{CASE_TYPE_LABELS[j.case_type] ?? j.case_type}</div></> },
    { key: 'county', header: 'County', render: (j) => j.county_code },
    { key: 'received', header: 'Received', render: (j) => j.received },
    { key: 'accepted', header: 'Accepted', render: (j) => j.accepted },
    { key: 'rejected', header: 'Rejected', render: (j) => j.rejected },
    { key: 'errors', header: 'Validation', render: (j) => j.validated_at ? <span className="small">{j.errors} error(s), {j.warnings} warning(s)</span> : <span className="muted small">not run</span> },
    { key: 'status', header: 'Status', render: (j) => <Badge value={j.status} /> },
    { key: 'done', header: 'Validated', render: (j) => <span className="small">{fmtDateTime(j.validated_at)}</span>, className: 'hide-sm' },
  ];
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>GIS Synchronization</h1><p className="muted">Imports from ArcGIS / QGIS into staging, their validation outcomes and publication. Nothing reaches the published layer without validation and a registrar's approval.</p></div></div>
      <div className="alert info small">
        <Info size={16} aria-hidden />
        <span>
          Data enters LAIS as GeoJSON exported from ArcMap, ArcGIS Pro or QGIS and imported by a GIS officer on a case. A direct ArcMap/ArcSDE connection is <strong>not implemented or verified</strong> (see the GIS synchronization guide).
          Imports and validation run immediately, so there are no queued technical failures to retry. A failed validation is fixed by the GIS officer correcting the data and re-importing, never by an administrator overriding it.
        </span>
      </div>
      <Panel>
        <div className="filter-bar">
          <label>Status<select value={status} onChange={(e) => set({ status: e.target.value, page: '' })}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
          {status && <button className="link" onClick={() => set({ status: '', page: '' })}>Clear filter</button>}
        </div>
        <QueryState query={jobs} isEmpty={(d) => d.total === 0} empty={<EmptyState title="No import jobs recorded">Jobs appear when GIS officers import geometry into cases.</EmptyState>}>
          {(d) => (
            <>
              <DataTable caption="GIS import jobs" columns={columns} rows={d.items} rowKey={(j) => j.id} onRowClick={(j) => set({ job: j.id })} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => set({ page: String(p) })} onPageSize={(s) => set({ pageSize: String(s), page: '' })} />
            </>
          )}
        </QueryState>
      </Panel>
      {params.get('job') && <JobDrawer id={params.get('job')!} onClose={() => set({ job: '' })} />}
    </div>
  );
}
