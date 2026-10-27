import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, CASE_TYPE_LABELS, downloadFile } from '../../api';
import {
  Badge, DataTable, Drawer, EmptyState, ErrorBanner, Modal, Pagination, Panel, QueryState, usePatchParams, useToast, type Column,
} from '../../components/kit';
import type { CaseDetailResponse, Paged, Priority, QueueItem } from '../../types';
import { CaseSupervisionPanel } from './CasePanel';
import { AssigneeSelect, fmtDate, PRIORITIES, qs, useSupervision } from './common';

const FILTERS = ['q', 'stage', 'type', 'priority', 'assigneeId', 'from', 'to', 'overdue'];

export function WorkQueue() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { scope, countyId, countyQs } = useSupervision();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const get = (k: string) => params.get(k) ?? '';
  const page = Number(get('page') || 1);
  const pageSize = Number(get('pageSize') || 25);
  const sort = get('sort') || 'activity';
  const dir = (get('dir') || 'desc') as 'asc' | 'desc';
  const query = qs(countyQs, ...FILTERS.map((k) => get(k) && `${k}=${encodeURIComponent(get(k))}`), `sort=${sort}`, `dir=${dir}`, `page=${page}`, `pageSize=${pageSize}`);
  const list = useQuery({ queryKey: ['supervision', 'queue', query], queryFn: () => api<Paged<QueueItem> & { targetsConfigured: boolean }>(`/supervision/applications${query}`), placeholderData: keepPreviousData });
  const open = get('case');
  const anyFilter = FILTERS.some((k) => get(k));
  const set = (p: Record<string, string>) => patch(p, { resetPage: true });

  const exportCsv = () => void downloadFile(`/supervision/reports/application_status.csv${qs(countyQs, get('from') && `from=${get('from')}`, get('to') && `to=${get('to')}`, get('stage') && `stage=${get('stage')}`)}`, 'lais-application-status.csv')
    .catch((e) => toast('error', e instanceof Error ? e.message : 'Export failed'));

  const columns: Column<QueueItem>[] = [
    { key: 'select', header: <span className="sr-only">Select</span>, render: (c) => (
      <input type="checkbox" aria-label={`Select ${c.case_no}`} checked={selected.includes(c.id)}
        onClick={(e) => e.stopPropagation()} onChange={() => setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
    ) },
    { key: 'case_no', header: 'Application', sortable: true, render: (c) => <><strong>{c.case_no}</strong><div className="muted tiny">{c.upi ?? 'no parcel id yet'}</div></> },
    { key: 'county', header: 'County', render: (c) => c.county_code, className: 'hide-sm' },
    { key: 'type', header: 'Type', render: (c) => <span className="small">{CASE_TYPE_LABELS[c.case_type]}</span> },
    { key: 'stage', header: 'Stage', sortable: true, render: (c) => <Badge value={c.stage} label={scope?.stages.find((s) => s.key === c.stage)?.label} /> },
    { key: 'holders', header: 'Applicant ref.', render: (c) => <span className="small muted">{c.proposed_holders ? `${c.proposed_holders} proposed holder(s)` : '—'}</span>, className: 'hide-sm' },
    { key: 'assignees', header: 'Assigned', render: (c) => <span className="small">{c.assignees ?? <span className="muted">opened by {c.opened_by}</span>}</span> },
    { key: 'submitted', header: 'Submitted', sortable: true, render: (c) => <span className="small">{fmtDate(c.submitted_at)}</span>, className: 'hide-sm' },
    { key: 'activity', header: 'Last activity', sortable: true, render: (c) => <span className="small">{fmtDate(c.last_activity)}</span> },
    { key: 'due', header: 'Due', sortable: true, render: (c) => <span className="small">{fmtDate(c.due_date)}</span> },
    { key: 'overdue', header: 'Days overdue', sortable: true, render: (c) => (c.days_overdue && c.days_overdue > 0 ? <Badge value="error" label={`${c.days_overdue} d`} /> : '—') },
    { key: 'priority', header: 'Priority', sortable: true, render: (c) => <Badge value={c.priority} /> },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Application Work Queue</h1><p className="muted">Every application in your scope. Open one to see its history, documents, GIS status and the actions you may take.</p></div>
        <div className="page-actions"><button className="secondary" onClick={exportCsv}><Download size={16} /> Export (CSV)</button></div>
      </div>
      <Panel>
        <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); set({ q: search }); }}>
          <label className="grow">Search<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => search !== get('q') && set({ q: search })} placeholder="Application or parcel id" /></label>
          <label>Stage<select value={get('stage')} onChange={(e) => set({ stage: e.target.value })}><option value="">All</option>{scope?.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label>Type<select value={get('type')} onChange={(e) => set({ type: e.target.value })}><option value="">All</option>{Object.entries(CASE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Priority<select value={get('priority')} onChange={(e) => set({ priority: e.target.value })}><option value="">All</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          {countyId ? <AssigneeSelect countyId={countyId} value={get('assigneeId')} onChange={(id) => set({ assigneeId: id })} label="Assigned staff" />
            : <label>Assigned staff<select disabled><option>Choose a county in the scope selector</option></select></label>}
          <label>Opened from<input type="date" value={get('from')} onChange={(e) => set({ from: e.target.value })} /></label>
          <label>to<input type="date" value={get('to')} onChange={(e) => set({ to: e.target.value })} /></label>
          <label className="inline"><input type="checkbox" checked={get('overdue') === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : '' })} /> Overdue only</label>
          {anyFilter && <button type="button" className="link" onClick={() => { setSearch(''); patch(Object.fromEntries(FILTERS.map((k) => [k, ''])), { resetPage: true }); }}>Clear filters</button>}
        </form>
        {list.data && !list.data.targetsConfigured && <p className="muted small">Overdue is based on due dates only: no operational stage targets are configured.</p>}
        {selected.length > 0 && (
          <div className="bulk-bar" role="region" aria-label="Selected applications">
            <strong>{selected.length} selected</strong>
            <button className="secondary" onClick={() => setBulk(true)}>Set priority / due date</button>
            <button className="link" onClick={() => setSelected([])}>Clear selection</button>
          </div>
        )}
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No applications match">{anyFilter && 'Try clearing the filters.'}</EmptyState>}>
          {(d) => (
            <>
              <DataTable caption="Applications" columns={columns} rows={d.items} rowKey={(c) => c.id} sort={{ key: sort, dir }}
                onSort={(k) => patch((cur) => ({ sort: k, dir: cur.get('sort') === k && (cur.get('dir') ?? 'desc') === 'desc' ? 'asc' : 'desc' }), { resetPage: true })}
                onRowClick={(c) => patch({ case: c.id })} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => patch({ page: p })} onPageSize={(s) => patch({ pageSize: s }, { resetPage: true })} />
            </>
          )}
        </QueryState>
      </Panel>
      {open && <CaseDrawer caseId={open} onClose={() => patch({ case: '' })} />}
      <BulkPriority open={bulk} ids={selected} onClose={(cleared) => { setBulk(false); if (cleared) setSelected([]); }} />
    </div>
  );
}

function BulkPriority({ open, ids, onClose }: { open: boolean; ids: string[]; onClose: (cleared: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ priority: 'normal' as Priority, dueDate: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (form.reason.trim().length < 5) return setError('Give a reason (5+ characters)');
    setBusy(true);
    const failures: string[] = [];
    for (const id of ids) {
      try { await api(`/supervision/cases/${id}/priority`, { method: 'PATCH', body: { priority: form.priority, dueDate: form.dueDate || undefined, reason: form.reason.trim() } }); }
      catch (e) { failures.push((e as Error).message); }
    }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['supervision'] });
    if (failures.length) {
      setError(`${ids.length - failures.length} updated, ${failures.length} refused: ${[...new Set(failures)].join('; ')}`);
    } else {
      toast('success', `${ids.length} application(s) updated`);
      onClose(true);
    }
  };
  return (
    <Modal open={open} onClose={() => onClose(false)} title={`Set priority for ${ids.length} application(s)`} footer={<><button className="secondary" onClick={() => onClose(false)}>Cancel</button><button onClick={() => void submit()} disabled={busy}>Apply</button></>}>
      <div className="stack">
        <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Due date (leave empty to keep each one)<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <label>Reason<textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <p className="muted small">Each application is updated separately and recorded in its history. Closed applications are refused.</p>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

/** Drawer for one application: supervision panel, GIS status, documents and history. */
export function CaseDrawer({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['supervision', 'case-detail', caseId], queryFn: () => api<CaseDetailResponse>(`/cases/${caseId}`) });
  const d = detail.data;
  return (
    <Drawer open title={d ? d.case.case_no : 'Application'} subtitle={d && `${CASE_TYPE_LABELS[d.case.case_type]} · ${d.case.county.name}`} onClose={onClose}>
      <ErrorBanner error={detail.error ? (detail.error as Error).message : null} />
      <div className="stack">
        <div className="row wrap small">
          <Link to={`/work/cases/${caseId}`}>Open the full case record</Link>
          {d?.staged && <Link to={`/supervisor/gis-review/${caseId}`}>Open GIS quality review</Link>}
        </div>
        <CaseSupervisionPanel caseId={caseId}
          records={d?.staged?.features.map((f) => ({ index: f.index, label: `Record ${f.index + 1}${f.properties.legacy_ref ? ` (${f.properties.legacy_ref})` : ''}` }))}
          findings={d?.validation?.findings.map((f) => ({ id: f.id, code: f.code, message: f.message, severity: f.severity, feature_index: f.feature_index }))} />
        {d && (
          <>
            <section>
              <h3 className="small">GIS status</h3>
              {d.staged ? (
                <p className="small">{d.staged.features.length} record(s) from {d.staged.source_filename} (EPSG:{d.staged.declared_srid}) by {d.staged.uploaded_by}.
                  {d.validation ? ` Latest validation: ${d.validation.run.error_count} error(s), ${d.validation.run.warning_count} warning(s).` : ' Not validated yet.'}</p>
              ) : <p className="small muted">No geometry submitted.</p>}
            </section>
            <section>
              <h3 className="small">Documents</h3>
              {d.documents.length === 0 ? <p className="small muted">None.</p> : (
                <ul className="plain small">
                  {d.documents.map((doc) => (
                    <li key={doc.id}>{doc.doc_type.replace(/_/g, ' ')} {doc.reference_no ?? ''} · <Badge value={doc.verification_status} />{' '}
                      {doc.canDownload ? <a href={`/api/documents/${doc.id}/file`}>Download</a> : <span className="muted">not available to your role</span>}</li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="small">Workflow history</h3>
              <ol className="timeline">
                {d.events.map((e) => <li key={e.id}><span className="muted small">{fmtDate(e.at)}</span> <strong>{e.actor ?? 'system'}</strong> {e.action.replace(/_/g, ' ')}{e.to_status && <> → <Badge value={e.to_status} /></>}{e.note && <span className="muted small"> · {e.note}</span>}</li>)}
              </ol>
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
