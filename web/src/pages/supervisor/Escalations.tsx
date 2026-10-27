import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Badge, DataTable, Drawer, EmptyState, ErrorBanner, Modal, Pagination, Panel, QueryState, ReasonDialog, usePatchParams, useToast, type Column } from '../../components/kit';
import type { EscalationDetail, EscalationRow, Paged } from '../../types';
import { AssigneeSelect, ESCALATION_CATEGORIES, EscalateDialog, fmtDate, qs, today } from './common';

const roleLabel = (role: string, level: string) => `${level === 'national' ? 'National ' : 'County '}${role.replace('_', ' ')}`;

export function EscalationsPage() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { session, can } = useAuth();
  const status = params.get('status') ?? 'active';
  const category = params.get('category') ?? '';
  const severity = params.get('severity') ?? '';
  const responsible = params.get('responsible') ?? 'any';
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const query = qs(`status=${status}`, category && `category=${category}`, severity && `severity=${severity}`, `responsible=${responsible}`, `page=${page}`, `pageSize=${pageSize}`);
  const list = useQuery({ queryKey: ['escalations', query], queryFn: () => api<Paged<EscalationRow>>(`/escalations${query}`), placeholderData: keepPreviousData });
  const open = params.get('escalation');
  const counties = [...new Map((session?.grants ?? []).filter((g) => g.county && ['supervisor', 'registrar', 'gis_officer', 'processor'].includes(g.role)).map((g) => [g.county!.id, g.county!])).values()];
  const [raiseCounty, setRaiseCounty] = useState<number | null>(null);
  const [choose, setChoose] = useState(false);

  const columns: Column<EscalationRow>[] = [
    { key: 'ref', header: 'Escalation', render: (e) => <><strong>{e.escalation_no}</strong> {e.title}<div className="tiny muted">{ESCALATION_CATEGORIES[e.category]}</div></> },
    { key: 'severity', header: 'Severity', render: (e) => <Badge value={e.severity} /> },
    { key: 'status', header: 'Status', render: (e) => <Badge value={e.status} /> },
    { key: 'responsible', header: 'Responsible', render: (e) => <span className="small">{roleLabel(e.responsible_role, e.responsible_level)}{e.responsible && <> · <strong>you</strong></>}{e.assignee && ` · ${e.assignee}`}</span> },
    { key: 'county', header: 'County', render: (e) => e.county_code },
    { key: 'related', header: 'Related', render: (e) => <span className="small">{[e.case_no, e.upi].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'from', header: 'Raised by', render: (e) => <span className="small">{e.created_by}</span>, className: 'hide-sm' },
    { key: 'created', header: 'Raised', render: (e) => <span className="small">{fmtDate(e.created_at)}</span> },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Escalations</h1><p className="muted">Problems routed to the role that can act on them. Closing an escalation records an operational disposition; it never changes a land record and cannot settle an ownership dispute.</p></div>
        {can('escalation.create') && counties.length > 0 && (
          <div className="page-actions"><button onClick={() => (counties.length === 1 ? setRaiseCounty(counties[0].id) : setChoose(true))}><Plus size={16} /> Raise escalation</button></div>
        )}
      </div>
      <Panel>
        <div className="filter-bar">
          <label>Status<select value={status} onChange={(e) => patch({ status: e.target.value }, { resetPage: true })}>
            <option value="active">Open, acknowledged or investigating</option>{['open', 'acknowledged', 'investigating', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
          <label>Category<select value={category} onChange={(e) => patch({ category: e.target.value }, { resetPage: true })}><option value="">All</option>{Object.entries(ESCALATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Severity<select value={severity} onChange={(e) => patch({ severity: e.target.value }, { resetPage: true })}><option value="">All</option>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label className="inline"><input type="checkbox" checked={responsible === 'me'} onChange={(e) => patch({ responsible: e.target.checked ? 'me' : '' }, { resetPage: true })} /> Only ones I must act on</label>
        </div>
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No escalations" />}>
          {(d) => (
            <>
              <DataTable caption="Escalations" columns={columns} rows={d.items} rowKey={(e) => e.id} onRowClick={(e) => patch({ escalation: e.id })} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => patch({ page: p })} onPageSize={(s) => patch({ pageSize: s }, { resetPage: true })} />
            </>
          )}
        </QueryState>
      </Panel>
      {open && <EscalationDrawer id={open} onClose={() => patch({ escalation: '' })} />}
      {choose && (
        <Modal open title="Which county?" onClose={() => setChoose(false)}>
          <div className="stack">{counties.map((c) => <button key={c.id} className="secondary" onClick={() => { setChoose(false); setRaiseCounty(c.id); }}>{c.name}</button>)}</div>
        </Modal>
      )}
      {raiseCounty && <EscalateDialog open onClose={() => setRaiseCounty(null)} defaults={{ countyId: raiseCounty }} />}
    </div>
  );
}

type Dialog = null | 'acknowledge' | 'assign' | 'investigate' | 'escalate' | 'comment' | 'close';

function EscalationDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['escalations', 'detail', id], queryFn: () => api<EscalationDetail>(`/escalations/${id}`) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const done = async (msg: string) => { await qc.invalidateQueries({ queryKey: ['escalations'] }); await qc.invalidateQueries({ queryKey: ['supervision'] }); toast('success', msg); };
  const post = (path: string, body: object) => api(`/escalations/${id}/${path}`, { body });
  const d = detail.data;
  return (
    <Drawer open title={d ? `${d.escalation.escalation_no}: ${d.escalation.title}` : 'Escalation'} subtitle={d && <><Badge value={d.escalation.severity} /> <Badge value={d.escalation.status} /></>} onClose={onClose}>
      <QueryState query={detail} skeletonLines={8}>
        {(x) => (
          <div className="stack">
            <dl className="facts">
              <dt>Category</dt><dd>{ESCALATION_CATEGORIES[x.escalation.category]}</dd>
              <dt>County</dt><dd>{x.escalation.county_name}</dd>
              <dt>Responsible</dt><dd>{roleLabel(x.escalation.responsible_role, x.escalation.responsible_level)}{x.escalation.assignee && ` · assigned to ${x.escalation.assignee}`}</dd>
              <dt>Raised</dt><dd>{fmtDate(x.escalation.created_at)} by {x.escalation.created_by_username}</dd>
              {x.escalation.case_no && <><dt>Application</dt><dd><Link to={`/work/cases/${x.escalation.case_id}`}>{x.escalation.case_no}</Link></dd></>}
              {x.escalation.upi && <><dt>Parcel</dt><dd>{x.escalation.upi}</dd></>}
              {x.escalation.task_no && <><dt>Task</dt><dd>{x.escalation.task_no} ({x.escalation.task_status})</dd></>}
              {x.escalation.closed_at && <><dt>Closed</dt><dd>{fmtDate(x.escalation.closed_at)} by {x.escalation.closed_by_username}: {x.escalation.closure_reason}</dd></>}
            </dl>
            <p className="small">{x.escalation.description}</p>
            {x.escalation.evidence.length > 0 && (
              <section><h3 className="small">Evidence</h3><ul className="plain small">{x.escalation.evidence.map((e, i) => <li key={i}><Badge value="info" label={e.type} /> {e.reference}{e.note && <span className="muted"> · {e.note}</span>}</li>)}</ul></section>
            )}
            <div className="row wrap">
              {x.permitted.acknowledge && <button onClick={() => setDialog('acknowledge')}>Acknowledge</button>}
              {x.permitted.assign && <button className="secondary" onClick={() => setDialog('assign')}>Assign</button>}
              {x.permitted.investigate && <button className="secondary" onClick={() => setDialog('investigate')}>Request investigation</button>}
              {x.permitted.escalate && <button className="secondary" onClick={() => setDialog('escalate')}>Escalate further</button>}
              {x.permitted.comment && <button className="secondary" onClick={() => setDialog('comment')}>Comment</button>}
              {x.permitted.close && <button className="secondary danger" onClick={() => setDialog('close')}>Close</button>}
            </div>
            {x.escalation.status !== 'closed' && !x.permitted.acknowledge && !x.permitted.close && <p className="small muted">Only the responsible role can acknowledge and close this escalation.</p>}
            <section>
              <h3 className="small">History</h3>
              <ol className="timeline">{x.events.map((e) => <li key={e.id}><span className="muted small">{fmtDate(e.at)}</span> <strong>{e.actor}</strong> {e.action.replace(/_/g, ' ')}{e.to_status && e.to_status !== e.from_status && <> → <Badge value={e.to_status} /></>}{e.note && <div className="small">{e.note}</div>}</li>)}</ol>
            </section>

            <ReasonDialog open={dialog === 'acknowledge'} title={`Acknowledge ${x.escalation.escalation_no}`} confirmLabel="Acknowledge" description="Confirms you have taken responsibility for it."
              onClose={() => setDialog(null)} onConfirm={async (note) => { await post('acknowledge', { note }); await done('Escalation acknowledged'); }} />
            <ReasonDialog open={dialog === 'comment'} title="Comment" confirmLabel="Add comment" description="Added to the escalation history."
              onClose={() => setDialog(null)} onConfirm={async (note) => { await post('comments', { note }); await done('Comment added'); }} />
            <ReasonDialog open={dialog === 'close'} title={`Close ${x.escalation.escalation_no}`} confirmLabel="Close escalation" danger
              description="State the disposition (10+ characters). Linked tasks must be finished first. Closing changes no land record."
              onClose={() => setDialog(null)} onConfirm={async (reason) => { if (reason.length < 10) throw new Error('Give a closure reason of at least 10 characters'); await post('close', { reason }); await done('Escalation closed'); }} />
            {dialog === 'escalate' && <EscalateFurther detail={x} onClose={() => setDialog(null)} onDone={() => done('Escalation routed')} />}
            {dialog === 'investigate' && <Investigate detail={x} onClose={() => setDialog(null)} onDone={() => done('Investigation requested')} />}
            {dialog === 'assign' && <AssignEscalation detail={x} onClose={() => setDialog(null)} onDone={() => done('Escalation assigned')} />}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

function EscalateFurther({ detail, onClose, onDone }: { detail: EscalationDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [target, setTarget] = useState(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (reason.trim().length < 10) return setError('Explain why (10+ characters)');
    try { await api(`/escalations/${detail.escalation.id}/escalate`, { body: { target: detail.permitted.targets[target], reason: reason.trim() } }); await onDone(); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title="Escalate to another role" onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Escalate</button></>}>
      <div className="stack">
        <label>Route to<select value={target} onChange={(e) => setTarget(Number(e.target.value))}>{detail.permitted.targets.map((t, i) => <option key={i} value={i}>{roleLabel(t.role, t.level)}</option>)}</select></label>
        <label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="muted small">The new owner must acknowledge it again.</p>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

function Investigate({ detail, onClose, onDone }: { detail: EscalationDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ note: '', assigneeId: '', dueDate: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (form.note.trim().length < 5) return setError('Describe what to investigate');
    try { await api(`/escalations/${detail.escalation.id}/investigate`, { body: { note: form.note.trim(), assigneeId: form.assigneeId || undefined, dueDate: form.dueDate || undefined } }); await onDone(); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title="Request further investigation" onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Request</button></>}>
      <div className="stack">
        <label>What should be investigated?<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <AssigneeSelect countyId={detail.escalation.county_id} taskType={detail.escalation.finding_code ? 'conflict_investigation' : 'application_follow_up'} value={form.assigneeId} onChange={(id) => setForm({ ...form, assigneeId: id })} label="As a task for (optional)" />
        <label>Due date<input type="date" min={today()} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

function AssignEscalation({ detail, onClose, onDone }: { detail: EscalationDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const people = useQuery({
    queryKey: ['escalations', 'assignees', detail.escalation.id],
    queryFn: () => api<{ id: string; username: string; display_name: string }[]>(`/escalations/${detail.escalation.id}/assignees`),
  });
  const [assigneeId, setAssigneeId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      await api(`/escalations/${detail.escalation.id}/assign`, { body: { assigneeId, note: note.trim() || undefined } });
      await onDone();
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title="Assign to a named person" onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()} disabled={!assigneeId}>Assign</button></>}>
      <div className="stack">
        <label>{roleLabel(detail.escalation.responsible_role, detail.escalation.responsible_level)}
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Choose…</option>
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.username})</option>)}
          </select>
        </label>
        <label>Note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <ErrorBanner error={error ?? (people.error ? (people.error as Error).message : null)} />
      </div>
    </Modal>
  );
}
