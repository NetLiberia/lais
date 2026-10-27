import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Maximize2 } from 'lucide-react';
import { api, CASE_TYPE_LABELS } from '../../api';
import { Badge, DataTable, EmptyState, ErrorBanner, Pagination, Panel, QueryState, usePatchParams, type Column } from '../../components/kit';
import { ReviewMap } from '../../components/ReviewMap';
import type { GisQueueItem, GisReviewDetail, Paged } from '../../types';
import { CaseSupervisionPanel } from './CasePanel';
import { fmtDate, qs, useSupervision } from './common';

const REVIEW_STATUS_LABELS: Record<string, string> = {
  awaiting_review: 'Awaiting quality review', accepted: 'Quality accepted', returned: 'Returned by supervisor',
  returned_by_validation: 'Returned by validation', not_submitted: 'Not yet submitted', decided: 'Decided or published',
};
const GROUP_LABELS: Record<string, string> = {
  geometry: 'Geometry validation', spatial_conflicts: 'Spatial conflict evidence', boundary: 'County-boundary validation',
  identifiers: 'Parcel identifier consistency', attributes: 'Attribute validation', completeness: 'Data completeness', other: 'Other checks',
};

export function GisReviewQueue() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const navigate = useNavigate();
  const { countyQs } = useSupervision();
  const status = params.get('status') ?? 'awaiting_review';
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const q = params.get('q') ?? '';
  const query = qs(countyQs, status !== 'all' && `status=${status}`, q && `q=${encodeURIComponent(q)}`, `page=${page}`, `pageSize=${pageSize}`);
  const list = useQuery({ queryKey: ['supervision', 'gis-reviews', query], queryFn: () => api<Paged<GisQueueItem>>(`/supervision/gis-reviews${query}`), placeholderData: keepPreviousData });

  const columns: Column<GisQueueItem>[] = [
    { key: 'ref', header: 'Submission', render: (s) => <><strong>{s.case_no}</strong><div className="muted tiny">{CASE_TYPE_LABELS[s.case_type]}</div></> },
    { key: 'job', header: 'Import job', render: (s) => <><span className="small">{s.source_filename}</span><div className="muted tiny">{s.batch_id.slice(0, 8)}</div></>, className: 'hide-sm' },
    { key: 'county', header: 'County', render: (s) => s.county_code },
    { key: 'officer', header: 'GIS officer', render: (s) => s.gis_officer },
    { key: 'submitted', header: 'Submitted', render: (s) => <span className="small">{fmtDate(s.submitted_at ?? s.imported_at)}</span> },
    { key: 'records', header: 'Records', render: (s) => s.feature_count },
    { key: 'valid', header: 'Valid', render: (s) => s.valid_records },
    { key: 'invalid', header: 'Invalid', render: (s) => (s.invalid_records ? <Badge value="error" label={String(s.invalid_records)} /> : 0) },
    { key: 'warnings', header: 'Warnings', render: (s) => s.warning_count ?? '—' },
    { key: 'conflicts', header: 'Potential conflicts', render: (s) => (s.potential_conflicts ? <Badge value="warning" label={String(s.potential_conflicts)} /> : 0) },
    { key: 'validation', header: 'Validation', render: (s) => <Badge value={s.validation_status} /> },
    { key: 'review', header: 'Review status', render: (s) => <Badge value={s.review_status} label={REVIEW_STATUS_LABELS[s.review_status]} /> },
  ];

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>GIS Quality Review</h1><p className="muted">GIS submissions prepared by GIS officers. Accepting a submission records its quality; it does not register or publish any parcel.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label>Review status
            <select value={status} onChange={(e) => patch({ status: e.target.value }, { resetPage: true })}>
              <option value="all">All</option>
              {Object.entries(REVIEW_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="grow">Search<input type="search" defaultValue={q} placeholder="Application or file name" onKeyDown={(e) => e.key === 'Enter' && patch({ q: (e.target as HTMLInputElement).value }, { resetPage: true })} /></label>
        </div>
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No submissions with this status" />}>
          {(d) => (
            <>
              <DataTable caption="GIS submissions" columns={columns} rows={d.items} rowKey={(s) => s.batch_id} onRowClick={(s) => navigate(`/supervisor/gis-review/${s.case_id}`)} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => patch({ page: p })} onPageSize={(s) => patch({ pageSize: s }, { resetPage: true })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

export function GisReviewDetailPage() {
  const { caseId } = useParams();
  const detail = useQuery({ queryKey: ['supervision', 'gis-review', caseId], queryFn: () => api<GisReviewDetail>(`/supervision/gis-reviews/${caseId}`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const d = detail.data;

  const layers = useMemo(() => {
    if (!d) return null;
    return {
      working: d.records.filter((r) => r.geometry).map((r) => ({
        id: String(r.feature_index), geometry: r.geometry, invalid: !r.structural_ok || r.errors > 0,
        popup: `Record ${r.feature_index + 1} · ${r.area_m2 ? `${Number(r.area_m2).toLocaleString()} m²` : 'no area'} · ${r.errors} error(s), ${r.warnings} warning(s)`,
      })),
      references: d.references.map((p) => ({ id: p.id, geometry: p.geometry, popup: `Published parcel ${p.upi} (${p.status})` })),
      overlaps: d.overlaps.map((o) => ({ id: o.finding_id, geometry: o.geometry, popup: `Overlap of record ${o.feature_index + 1} with ${o.upi}: ${Number(o.area_m2).toLocaleString()} m²` })),
      county: d.county.geometry ? { geometry: d.county.geometry, label: `${d.county.name} boundary (${d.county.boundary_status})` } : null,
    };
  }, [d]);

  if (detail.error) return <div className="page-v2"><ErrorBanner error={(detail.error as Error).message} onRetry={() => void detail.refetch()} /></div>;
  if (!d || !layers) return <div className="page-v2"><QueryState query={detail}>{() => null}</QueryState></div>;
  const rec = selected !== null ? d.records.find((r) => String(r.feature_index) === selected) : undefined;
  const findings = d.validation?.findings ?? [];
  const shown = onlyProblems ? d.records.filter((r) => !r.structural_ok || r.errors || r.warnings) : d.records;

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>GIS review: {d.case.caseNo}</h1>
          <p className="muted">{CASE_TYPE_LABELS[d.case.caseType]} · status {d.case.status.replace('_', ' ')} · <Link to="/supervisor/gis-review">Back to the queue</Link> · <Link to={`/work/cases/${d.case.id}`}>Full case record</Link></p>
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <Panel title="Submission">
            {d.submission ? (
              <dl className="facts">
                <dt>Source dataset</dt><dd>{d.submission.source_filename}</dd>
                <dt>File SHA-256</dt><dd><code className="tiny">{d.submission.file_sha256}</code></dd>
                <dt>Imported</dt><dd>{fmtDate(d.submission.created_at)} by {d.submission.uploaded_by}</dd>
                <dt>Source CRS</dt><dd>{d.submission.sourceCrs} (declared by the officer)</dd>
                <dt>Target CRS</dt><dd>{d.submission.targetCrs}</dd>
                <dt>Records</dt><dd>{d.submission.feature_count}</dd>
              </dl>
            ) : <p className="muted">No geometry submitted for this case.</p>}
          </Panel>

          <Panel title="Validation summary">
            {d.validation ? (
              <>
                <p className="small muted">Run {fmtDate(d.validation.run.run_at)} ({d.validation.run.purpose}): {d.validation.run.error_count} blocking error(s), {d.validation.run.warning_count} warning(s). Warnings are signals for investigation, not violations.</p>
                <table className="table">
                  <thead><tr><th>Check</th><th>Errors</th><th>Warnings</th></tr></thead>
                  <tbody>{d.validation.summary.map((s) => <tr key={s.group}><td>{GROUP_LABELS[s.group]}</td><td>{s.errors ? <Badge value="error" label={String(s.errors)} /> : 0}</td><td>{s.warnings ? <Badge value="warning" label={String(s.warnings)} /> : 0}</td></tr>)}</tbody>
                </table>
                {d.county.boundary_status !== 'verified' && <p className="small muted">The {d.county.name} boundary is {d.county.boundary_status}; boundary results are indicative only.</p>}
              </>
            ) : <p className="muted">Not validated yet.</p>}
          </Panel>

          <Panel title="Findings" actions={<span className="muted small">{findings.length} finding(s)</span>}>
            {findings.length === 0 ? <p className="muted small">No findings.</p> : (
              <ul className="findings">
                {findings.map((f) => (
                  <li key={f.id} className={f.severity}>
                    <Badge value={f.severity} label={f.severity === 'error' ? 'blocking error' : 'warning'} /> <code className="small">{f.code}</code> <span className="muted tiny">{GROUP_LABELS[f.group]}</span>
                    <div className="small">{f.message}</div>
                    {f.feature_index !== null && <button className="link small" onClick={() => setSelected(String(f.feature_index))}>Show record {f.feature_index + 1} on the map</button>}
                    {f.acknowledged_by_username && <div className="small ok-text">Acknowledged by registrar {f.acknowledged_by_username}: {f.acknowledgement_note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Map preview" actions={<button className="link small" onClick={() => setFitToken((n) => n + 1)}><Maximize2 size={14} /> Fit to submission</button>}>
            <ReviewMap working={layers.working} references={layers.references} overlaps={layers.overlaps} county={layers.county}
              selectedId={selected} onSelect={setSelected} fitToken={fitToken} height={420} />
          </Panel>
          {rec && (
            <Panel title={`Record ${rec.feature_index + 1}`} actions={<button className="link small" onClick={() => setSelected(null)}>Close</button>}>
              <dl className="facts">
                <dt>Geometry</dt><dd>{rec.geometry_type ?? '—'} {rec.structural_ok ? '' : <Badge value="error" label={`invalid: ${rec.structural_message}`} />}</dd>
                <dt>Calculated area</dt><dd>{rec.area_m2 ? `${Number(rec.area_m2).toLocaleString()} m² (geodesic)` : '—'}</dd>
                <dt>Findings</dt><dd>{rec.errors} error(s), {rec.warnings} warning(s)</dd>
                {rec.excluded && <><dt>Excluded</dt><dd>{rec.exclusion_reason}</dd></>}
                {Object.entries(rec.properties).map(([k, v]) => <span key={k} className="contents"><dt>{k}</dt><dd>{String(v)}</dd></span>)}
              </dl>
              <p className="muted tiny">Attributes that may hold personal data (names, contacts, identity numbers) are not shown here.</p>
            </Panel>
          )}
          <Panel title="Quality review actions">
            <CaseSupervisionPanel caseId={d.case.id}
              records={d.records.map((r) => ({ index: r.feature_index, label: `Record ${r.feature_index + 1}${r.errors ? ` (${r.errors} error)` : ''}` }))}
              findings={findings.map((f) => ({ id: f.id, code: f.code, message: f.message, severity: f.severity, feature_index: f.feature_index }))} />
          </Panel>
        </div>
      </div>

      <Panel title="Record-level results" actions={<label className="inline small"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only records with findings</label>}>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>#</th><th>Geometry</th><th>Area m²</th><th>Errors</th><th>Warnings</th><th>Attributes</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.feature_index} className={r.excluded ? 'muted' : ''}>
                  <td>{r.feature_index + 1}</td>
                  <td>{r.structural_ok ? (r.geometry_type ?? 'valid') : <span className="danger">invalid: {r.structural_message}</span>}</td>
                  <td>{r.area_m2 ? Number(r.area_m2).toLocaleString() : '—'}</td>
                  <td>{r.errors}</td><td>{r.warnings}</td>
                  <td className="small">{Object.entries(r.properties).map(([k, v]) => `${k}: ${String(v)}`).join('; ') || '—'}</td>
                  <td><button className="link small" onClick={() => setSelected(String(r.feature_index))}>Zoom to</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Submission and correction history">
          <ol className="timeline">
            {d.history.map((b) => (
              <li key={b.id}>
                <span className="muted small">{fmtDate(b.created_at)}</span> <strong>{b.source_filename}</strong> by {b.uploaded_by} · {b.feature_count} record(s) <Badge value={b.status} />
                <ul className="plain tiny">{b.runs.map((r) => <li key={r.id}>{fmtDate(r.runAt)} {r.purpose}: {r.errors} error(s), {r.warnings} warning(s)</li>)}</ul>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title="Officer and reviewer notes (case history)">
          <ol className="timeline">
            {d.events.filter((e) => e.note).map((e, i) => <li key={i}><span className="muted small">{fmtDate(e.at)}</span> <strong>{e.actor ?? 'system'}</strong> {e.action.replace(/_/g, ' ')}: <span className="small">{e.note}</span></li>)}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
