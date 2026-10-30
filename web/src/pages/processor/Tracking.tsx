import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, EmptyState, ErrorBanner, fmtDateTime, Modal, Pagination, Panel, QueryState, useToast } from '../../components/kit';
import type { ActivityRow, DecisionTrackingRow, GisQueueRow, Paged, ReturnedApplication } from '../../types';
import { human, qs } from './common';

/** The processor's GIS handoffs and their tasks. Processors follow GIS work; they never change geometry. */
export function GisQueuePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['processor', 'gis-queue'], queryFn: () => api<GisQueueRow[]>('/processor/gis-queue') });
  const [answer, setAnswer] = useState<GisQueueRow | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reply = async () => {
    if (!answer) return;
    setError(null);
    try { await api(`/tasks/${answer.task_id}/comments`, { body: { note } }); toast('success', 'Answer sent to the GIS officer'); setAnswer(null); setNote(''); void qc.invalidateQueries({ queryKey: ['processor'] }); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>GIS Processing Queue</h1><p className="muted small">Applications handed off to GIS officers and the state of their GIS tasks. Answer clarification requests here; the spatial work is the GIS officer's.</p></div></div>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No handoffs yet">Hand an administratively complete application to GIS from its workspace.</EmptyState>}>
        {(rows) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Handoff</th><th>Application</th><th>GIS task</th><th>Task status</th><th>GIS officer</th><th>Geometry</th><th>Clarification</th><th>Handed off</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.handoff_no}<div className="muted small">{human(r.task_type)}</div></td>
                  <td><button className="link" onClick={() => navigate(`/processor/applications/${r.case_id}?tab=gis`)}>{r.case_no}</button><div className="muted small">{human(r.case_status)}</div></td>
                  <td>{r.task_no}<div className="muted small">{r.priority}{r.due_date ? ` · due ${r.due_date.slice(0, 10)}` : ''}</div></td>
                  <td><Badge value={r.task_status} /></td><td>{r.gis_officer ?? <em className="muted">county queue</em>}</td>
                  <td className="small">{r.version_no ? `version ${r.version_no}` : '—'}{r.error_count !== null && <div className="muted">{r.error_count} error(s), {r.warning_count} warning(s)</div>}</td>
                  <td className="small">{r.last_clarification ? <>{r.last_clarification} <button className="link" onClick={() => setAnswer(r)}>Answer</button></> : '—'}</td>
                  <td className="small">{fmtDateTime(r.created_at)}<div className="muted">{r.processor}</div></td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        )}
      </QueryState>
      <Modal open={!!answer} title={answer ? `Answer ${answer.task_no}` : ''} onClose={() => setAnswer(null)}
        footer={<><button className="secondary" onClick={() => setAnswer(null)}>Cancel</button><button disabled={note.trim().length < 2} onClick={() => void reply()}>Send answer</button></>}>
        <ErrorBanner error={error} />
        <p className="small"><strong>Question:</strong> {answer?.last_clarification}</p>
        <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Answer" />
      </Modal>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = { validation: 'Automated validation', supervisor: 'Supervisor quality review', registrar: 'Land Registrar', gis_officer: 'GIS officer (clarification)', other: 'Other' };

export function ReturnedPage() {
  const list = useQuery({ queryKey: ['processor', 'returned'], queryFn: () => api<ReturnedApplication[]>('/processor/returned') });
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Returned Applications</h1><p className="muted small">Applications returned for administrative correction, and GIS officers' clarification requests. Correct the details or documents (earlier values and versions are kept), answer, and resubmit. Geometry and registrar decisions are not changed here.</p></div></div>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="Nothing returned" />}>
        {(rows) => (
          <div className="stack">{rows.map((r, i) => (
            <Panel key={`${r.id}-${i}`} title={<>{r.case_no} <Badge value={r.source === 'gis_officer' ? 'info_requested' : 'returned'} label={SOURCE_LABELS[r.source]} /></>}
              actions={<Link className="button" to={`/processor/applications/${r.id}${r.source === 'gis_officer' ? '?tab=gis' : ''}`}>Open and correct</Link>}>
              <p className="small">Applicant {r.applicant_name} ({r.applicant_no}) · returned {fmtDateTime(r.returned_at)}{r.returned_by && ` by ${r.returned_by}`} · responsible: {r.processor ?? '—'}{r.due_date && ` · due ${r.due_date.slice(0, 10)}`}</p>
              {r.reason && <p><strong>Reason:</strong> {r.reason}</p>}
              {r.instructions && <p><strong>Required correction:</strong> {r.instructions}</p>}
              {r.issue_categories && r.issue_categories.length > 0 && <div className="chip-row">{r.issue_categories.map((c) => <span key={c} className="chip">{human(c)}</span>)}</div>}
              <p className="muted small">{r.documents} current document(s){r.task_no && ` · GIS task ${r.task_no}`}</p>
            </Panel>
          ))}</div>
        )}
      </QueryState>
    </div>
  );
}

export function DecisionsPage() {
  const list = useQuery({ queryKey: ['processor', 'decisions'], queryFn: () => api<{ items: DecisionTrackingRow[]; labels: Record<string, string>; notice: string }>('/processor/decisions') });
  const [filter, setFilter] = useState('');
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Registrar Decision Tracking</h1><p className="muted small">Read-only. Every status and date comes from the registrar's own records; processors follow up but cannot make or change a decision.</p></div></div>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No submitted applications yet" />}>
        {(d) => (
          <Panel actions={<label className="inline">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All</option>{Object.entries(d.labels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Application</th><th>County</th><th>Parcel</th><th>Submitted</th><th>Status</th><th>Decision date</th><th>Registrar</th><th>Decision summary</th><th>Supervisor</th></tr></thead>
              <tbody>{d.items.filter((r) => !filter || r.tracking_status === filter).map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/processor/applications/${r.id}?tab=registrar`}>{r.case_no}</Link></td><td>{r.county_code}</td><td>{r.parcel_upi ?? r.declared_parcel_ref ?? '—'}</td>
                  <td>{fmtDateTime(r.submitted_at)}</td><td><Badge value={r.tracking_status === 'approved' ? 'approved' : r.tracking_status === 'rejected' ? 'rejected' : r.tracking_status.startsWith('returned') ? 'returned' : 'under_review'} label={d.labels[r.tracking_status] ?? human(r.tracking_status)} /></td>
                  <td>{fmtDateTime(r.decided_at)}</td><td>{r.registrar ?? '—'}</td><td className="small">{r.decision_summary ?? '—'}</td>
                  <td className="small">{r.supervisor_decision ? `${human(r.supervisor_decision)} ${fmtDateTime(r.supervisor_at)}` : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        )}
      </QueryState>
    </div>
  );
}

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const actor = params.get('actor') ?? 'all';
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = qs(params.get('q') && `q=${encodeURIComponent(params.get('q')!)}`, `actor=${actor}`, `page=${page}`, 'pageSize=50');
  const list = useQuery({ queryKey: ['processor', 'activity', query], queryFn: () => api<Paged<ActivityRow>>(`/processor/activity${query}`), placeholderData: keepPreviousData });
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page') p.delete('page'); setParams(p); };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Application History</h1><p className="muted small">Recent workflow events across the applications in your counties, from the stored history. Each application's full timeline is in its workspace.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set('q', q.trim() || null); }}><label>Application or event <input value={q} onChange={(e) => setQ(e.target.value)} /></label><button type="submit">Search</button></form>
          <div className="segmented" role="group" aria-label="Whose events">
            <button className={actor === 'all' ? 'active' : ''} onClick={() => set('actor', null)}>Everyone</button>
            <button className={actor === 'me' ? 'active' : ''} onClick={() => set('actor', 'me')}>Mine</button>
          </div>
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No events" />}>
        {(d) => (
          <Panel>
            <table className="table"><thead><tr><th>When</th><th>Application</th><th>Event</th><th>Status</th><th>By</th><th>Detail</th></tr></thead>
              <tbody>{d.items.map((e) => (
                <tr key={e.id}><td>{fmtDateTime(e.at)}</td><td><Link to={`/processor/applications/${e.case_id}?tab=timeline`}>{e.case_no}</Link></td><td>{human(e.action)}</td>
                  <td className="small">{e.from_status || e.to_status ? `${human(e.from_status)} → ${human(e.to_status)}` : '—'}</td><td>{e.actor ?? 'system'}</td><td className="small">{e.note ?? '—'}</td></tr>
              ))}</tbody></table>
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => set('page', String(p))} />
          </Panel>
        )}
      </QueryState>
    </div>
  );
}
