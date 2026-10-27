import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, DataTable, Drawer, EmptyState, ErrorBanner, Modal, Pagination, Panel, QueryState, usePatchParams, useToast, type Column } from '../../components/kit';
import { ReviewMap } from '../../components/ReviewMap';
import type { ConflictDetail, ConflictRow, Paged } from '../../types';
import { AssigneeSelect, EscalateDialog, fmtDate, qs, today, useSupervision } from './common';

export const CONFLICT_STATUS_LABELS: Record<string, string> = {
  new: 'Newly detected', investigating: 'Under investigation', awaiting_correction: 'Awaiting correction', escalated: 'Escalated',
  resolved: 'Resolved after authorized review', closed: 'Closed with documented disposition',
};

export function ConflictReview() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { countyQs } = useSupervision();
  const status = params.get('status') ?? 'unresolved';
  const category = params.get('category') ?? '';
  const severity = params.get('severity') ?? '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const query = qs(countyQs, `status=${status}`, category && `category=${category}`, severity && `severity=${severity}`, q && `q=${encodeURIComponent(q)}`, `page=${page}`, `pageSize=${pageSize}`);
  const list = useQuery({
    queryKey: ['supervision', 'conflicts', query],
    queryFn: () => api<Paged<ConflictRow> & { categories: { category: string; label: string }[] }>(`/supervision/conflicts${query}`),
    placeholderData: keepPreviousData,
  });
  const open = params.get('conflict');

  const columns: Column<ConflictRow>[] = [
    { key: 'ref', header: 'Conflict', render: (c) => <><strong>{c.case_no}</strong><div className="muted tiny">{c.code}</div></> },
    { key: 'category', header: 'Category', render: (c) => c.category_label },
    { key: 'county', header: 'County', render: (c) => c.county_code, className: 'hide-sm' },
    { key: 'parcels', header: 'Affected parcels', render: (c) => <span className="small">{[c.case_parcel_upi ?? c.proposed_upi ?? (c.feature_index !== null ? `record ${c.feature_index + 1}` : null), c.related_upi, c.related_case_no].filter(Boolean).join(' ↔ ') || '—'}</span> },
    { key: 'detected', header: 'Detected', render: (c) => <span className="small">{fmtDate(c.detected_at)}</span> },
    { key: 'method', header: 'Method', render: (c) => <span className="tiny muted">Automated rule v{c.rule_version}</span>, className: 'hide-sm' },
    { key: 'severity', header: 'Severity', render: (c) => <Badge value={c.severity} label={c.severity === 'error' ? 'blocking' : 'warning'} /> },
    { key: 'status', header: 'Review status', render: (c) => <Badge value={c.review_status} label={CONFLICT_STATUS_LABELS[c.review_status]} /> },
    { key: 'investigator', header: 'Investigator', render: (c) => c.investigator ?? '—' },
    { key: 'updated', header: 'Last update', render: (c) => <span className="small">{fmtDate(c.last_update)}</span>, className: 'hide-sm' },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Spatial Conflict Review</h1>
          <p className="muted">Conflicts are technical signals from automated checks, to be investigated. A conflict is not proof of fraud or of who owns land. Shared boundaries are not overlaps: only intersections larger than the configured tolerance are flagged.</p>
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label>Status
            <select value={status} onChange={(e) => patch({ status: e.target.value }, { resetPage: true })}>
              <option value="unresolved">Unresolved (all open statuses)</option>
              {Object.entries(CONFLICT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Category
            <select value={category} onChange={(e) => patch({ category: e.target.value }, { resetPage: true })}>
              <option value="">All</option>
              {list.data?.categories.filter((c, i, a) => a.findIndex((x) => x.category === c.category) === i).map((c) => <option key={c.category} value={c.category}>{c.label}</option>)}
            </select>
          </label>
          <label>Severity
            <select value={severity} onChange={(e) => patch({ severity: e.target.value }, { resetPage: true })}>
              <option value="">All</option><option value="error">Blocking error</option><option value="warning">Warning</option>
            </select>
          </label>
          <label className="grow">Search<input type="search" defaultValue={q} placeholder="Application or parcel id" onKeyDown={(e) => e.key === 'Enter' && patch({ q: (e.target as HTMLInputElement).value }, { resetPage: true })} /></label>
        </div>
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No conflicts with this status" />}>
          {(d) => (
            <>
              <DataTable caption="Spatial conflicts" columns={columns} rows={d.items} rowKey={(c) => c.id} onRowClick={(c) => patch({ conflict: c.id })} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => patch({ page: p })} onPageSize={(s) => patch({ pageSize: s }, { resetPage: true })} />
            </>
          )}
        </QueryState>
      </Panel>
      {open && <ConflictDrawer id={open} onClose={() => patch({ conflict: '' })} />}
    </div>
  );
}

type Action = 'note' | 'investigation_assigned' | 'gis_check_requested';

function ConflictActionDialog({ action, conflict, onClose }: { action: Action | null; conflict: ConflictRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ note: '', assigneeId: '', dueDate: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (action) { setForm({ note: '', assigneeId: '', dueDate: '' }); setError(null); } }, [action]);
  if (!action) return null;
  const needsAssignee = action !== 'note';
  const title = action === 'note' ? 'Add a review note' : action === 'investigation_assigned' ? 'Assign an investigation' : 'Request further GIS checks';
  const submit = async () => {
    if (form.note.trim().length < 5) return setError('Write a note (5+ characters)');
    if (needsAssignee && !form.assigneeId) return setError('Choose who should do the work');
    try {
      await api(`/supervision/conflicts/${conflict.id}/actions`, { body: { action, note: form.note.trim(), assigneeId: form.assigneeId || undefined, dueDate: form.dueDate || undefined } });
      await qc.invalidateQueries({ queryKey: ['supervision'] });
      toast('success', action === 'note' ? 'Note recorded' : 'Task created and assigned');
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title={title} onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Save</button></>}>
      <div className="stack">
        <label>{needsAssignee ? 'What should be checked?' : 'Note'}<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        {needsAssignee && (
          <>
            <AssigneeSelect countyId={conflict.county_id} taskType={action === 'gis_check_requested' ? 'gis_validation_correction' : 'conflict_investigation'} value={form.assigneeId} onChange={(id) => setForm({ ...form, assigneeId: id })} required />
            <label>Due date<input type="date" min={today()} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
          </>
        )}
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

export function ConflictDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['supervision', 'conflict', id], queryFn: () => api<ConflictDetail>(`/supervision/conflicts/${id}`) });
  const [action, setAction] = useState<Action | null>(null);
  const [escalate, setEscalate] = useState(false);
  const d = detail.data;
  const c = d?.conflict;
  const open = c && ['new', 'investigating', 'awaiting_correction', 'escalated'].includes(c.review_status);
  const navigate = useNavigate();
  // Recorded measurements, minus the overlap area already shown as the measured intersection.
  const measures = c?.detail ? Object.entries(c.detail).filter(([k]) => /_m2$|_m$|hausdorff/.test(k) && !(k === 'overlap_m2' && d?.evidence?.intersection_m2)) : [];

  return (
    <Drawer open title={c ? `${c.category_label}: ${c.case_no}` : 'Conflict'} subtitle={c && <Badge value={c.review_status} label={CONFLICT_STATUS_LABELS[c.review_status]} />} onClose={onClose}>
      <QueryState query={detail} skeletonLines={8}>
        {(x) => (
          <div className="stack">
            <p className="small">{x.conflict.message}</p>
            <p className="muted small">A technical signal for investigation, not a legal finding about ownership or fraud.</p>
            {x.evidence?.feature && (
              <ReviewMap height={300}
                working={[{ id: 'f', geometry: x.evidence.feature, popup: `Submitted geometry of ${x.conflict.case_no}` }]}
                references={x.evidence.related_parcel ? [{ id: 'p', geometry: x.evidence.related_parcel, popup: `Published parcel ${x.conflict.related_upi ?? ''}` }] : []}
                overlaps={x.evidence.intersection && Number(x.evidence.intersection_m2) > 0 ? [{ id: 'i', geometry: x.evidence.intersection, popup: `Intersection ${x.evidence.intersection_m2} m²` }] : []} />
            )}
            <dl className="facts">
              <dt>Rule</dt><dd><code>{x.conflict.code}</code> (version {x.conflict.rule_version})</dd>
              <dt>Detection method</dt><dd className="small">{x.conflict.method}</dd>
              <dt>Severity</dt><dd>{x.conflict.severity === 'error' ? 'Blocking error' : 'Warning'}</dd>
              <dt>Related records</dt><dd className="small">
                <Link to={`/supervisor/gis-review/${x.conflict.case_id}`}>{x.conflict.case_no}</Link>
                {x.conflict.related_upi && <> · parcel <Link to={`/work/parcels/${x.conflict.related_upi}`}>{x.conflict.related_upi}</Link></>}
                {x.conflict.related_case_no && <> · open case {x.conflict.related_case_no}</>}
              </dd>
              {x.evidence?.intersection_m2 && <><dt>Measured intersection</dt><dd>{Number(x.evidence.intersection_m2).toLocaleString()} m² of {Number(x.evidence.feature_m2).toLocaleString()} m² (geodesic)</dd></>}
              {measures.map(([k, v]) => <span key={k} className="contents"><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof v === 'number' ? v.toFixed(2) : String(v)}</dd></span>)}
              <dt>First detected</dt><dd>{fmtDate(x.conflict.detected_at)}</dd>
              {x.conflict.acknowledged_at && <><dt>Registrar review</dt><dd>{x.conflict.acknowledged_by}: {x.conflict.acknowledgement_note}</dd></>}
            </dl>

            <div className="row wrap">
              <button className="secondary" onClick={() => setAction('note')}>Add review note</button>
              {open && <button className="secondary" onClick={() => setAction('investigation_assigned')}>Assign investigation</button>}
              {open && <button className="secondary" onClick={() => setAction('gis_check_requested')}>Request GIS checks</button>}
              {open && x.conflict.case_status === 'under_review' && <button className="secondary" onClick={() => navigate(`/supervisor/gis-review/${x.conflict.case_id}`)}>Return submission for correction…</button>}
              {open && <button className="secondary danger" onClick={() => setEscalate(true)}>Escalate</button>}
            </div>
            {!open && <p className="small muted">This conflict is {CONFLICT_STATUS_LABELS[x.conflict.review_status].toLowerCase()}. Notes can still be added; the evidence and history are kept.</p>}

            <section>
              <h3 className="small">Review history</h3>
              {x.events.length === 0 ? <p className="muted small">No supervisory action yet.</p> : (
                <ul className="timeline">{x.events.map((e) => <li key={e.id}><span className="muted small">{fmtDate(e.at)}</span> {e.actor}: {e.action.replace(/_/g, ' ')} · <span className="small">{e.note}</span>{e.task_no && <span className="small"> (task {e.task_no})</span>}{e.escalation_no && <span className="small"> ({e.escalation_no})</span>}</li>)}</ul>
              )}
            </section>
            {x.tasks.length > 0 && (
              <section>
                <h3 className="small">Correction and investigation progress</h3>
                <ul className="plain small">{x.tasks.map((t) => <li key={t.id}>{t.task_no} {t.task_type.replace(/_/g, ' ')} · <Badge value={t.status} /> {t.assignee ?? 'unassigned'}{t.completion_note && ` · ${t.completion_note}`}</li>)}</ul>
              </section>
            )}
            {x.escalations.length > 0 && (
              <section>
                <h3 className="small">Escalations</h3>
                <ul className="plain small">{x.escalations.map((e) => <li key={e.id}>{e.escalation_no} <Badge value={e.severity} /> <Badge value={e.status} />{e.closure_reason && ` · ${e.closure_reason}`}</li>)}</ul>
              </section>
            )}
            <section>
              <h3 className="small">Detected in validation runs</h3>
              <ul className="plain tiny">{x.occurrences.map((o) => <li key={o.id}>{fmtDate(o.run_at)} ({o.purpose}) · {o.severity}</li>)}</ul>
            </section>
            {c && <ConflictActionDialog action={action} conflict={c} onClose={() => setAction(null)} />}
            {c && <EscalateDialog open={escalate} onClose={() => setEscalate(false)} defaults={{ countyId: c.county_id, caseId: c.case_id, caseNo: c.case_no, findingId: c.id, category: 'spatial_conflict', title: `${c.category_label} on ${c.case_no}` }} />}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}
