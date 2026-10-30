import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Drawer, EmptyState, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, useToast } from '../../components/kit';
import type { ApplicationDoc, DocumentCategory, InfoRequestDetail, InfoRequestRow } from '../../types';
import { human, qs } from './common';

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', response_received: 'Response received', partially_satisfied: 'Partially satisfied', satisfied: 'Satisfied', closed: 'Closed',
};
const STATUS_TONES: Record<string, string> = { pending: 'awaiting_review', response_received: 'info_requested', partially_satisfied: 'warning', satisfied: 'passed', closed: 'closed' };
export const DELIVERY_LABELS: Record<string, string> = {
  not_sent_no_provider: 'Not sent: no e-mail/SMS provider is configured', awaiting_manual_delivery: 'To be delivered by staff', delivered_manually: 'Delivered by staff (recorded)',
};
export const RequestStatusBadge = ({ r }: { r: Pick<InfoRequestRow, 'status' | 'overdue'> }) => (
  <>{<Badge value={STATUS_TONES[r.status]} label={REQUEST_STATUS_LABELS[r.status]} />}{r.overdue && <> <Badge value="urgent" label="overdue" /></>}</>
);

export function CreateInfoRequestModal({ open, caseId, onClose }: { open: boolean; caseId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useQuery({ queryKey: ['document-categories'], queryFn: () => api<DocumentCategory[]>('/document-categories'), enabled: open, staleTime: 300_000 });
  const [form, setForm] = useState({ category: 'missing_document', items: '', docCategories: [] as string[], explanation: '', dueDate: '', channel: 'in_person', internalNote: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setForm({ category: 'missing_document', items: '', docCategories: [], explanation: '', dueDate: '', channel: 'in_person', internalNote: '' }); setError(null); } }, [open]);
  const send = async () => {
    setError(null);
    try {
      const r = await api<{ requestNo: string; deliveryStatus: string }>(`/applications/${caseId}/info-requests`, {
        body: { ...form, dueDate: form.dueDate || undefined, internalNote: form.internalNote || undefined },
      });
      toast(r.deliveryStatus === 'not_sent_no_provider' ? 'info' : 'success', `${r.requestNo} recorded. ${DELIVERY_LABELS[r.deliveryStatus]}.`);
      void qc.invalidateQueries({ queryKey: ['processor'] });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open={open} title="Request additional information" onClose={onClose}
      footer={<><button className="secondary" onClick={onClose}>Cancel</button><button disabled={form.items.trim().length < 3 || form.explanation.trim().length < 10} onClick={() => void send()}>Record request</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <label>Request category
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option value="missing_document">Missing document</option><option value="missing_information">Missing information</option>
            <option value="clarification">Clarification</option><option value="replacement_document">Replacement document</option><option value="other">Other</option>
          </select>
        </label>
        <label>Communication channel
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            <option value="in_person">In person at the office</option><option value="phone">Telephone</option><option value="letter">Letter</option>
            <option value="email">E-mail (not sent: no provider)</option><option value="sms">SMS (not sent: no provider)</option>
          </select>
        </label>
        <label className="span-2">What is missing <input value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} maxLength={1000} placeholder="e.g. Signed survey plan" /></label>
        <label>Related document categories
          <select multiple value={form.docCategories} onChange={(e) => setForm({ ...form, docCategories: [...e.target.selectedOptions].map((o) => o.value) })} size={4}>
            {categories.data?.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </label>
        <label>Submission deadline (optional) <input type="date" value={form.dueDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
      </div>
      <label>Explanation for the applicant <textarea rows={3} value={form.explanation} onChange={(e) => setForm({ ...form, explanation: e.target.value })} /></label>
      <label>Internal note (staff only) <textarea rows={2} value={form.internalNote} onChange={(e) => setForm({ ...form, internalNote: e.target.value })} /></label>
      {['email', 'sms'].includes(form.channel) && <p className="warn-text small">No e-mail or SMS provider is configured. The request is recorded, but nothing is sent: contact the applicant another way and record the delivery.</p>}
    </Modal>
  );
}

export function InfoRequestDrawer({ id, onClose, documents }: { id: string; onClose: () => void; documents?: ApplicationDoc[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['processor', 'info-request', id], queryFn: () => api<InfoRequestDetail>(`/info-requests/${id}`) });
  const caseDocs = useQuery({
    queryKey: ['processor', 'info-request-docs', detail.data?.case_id], enabled: !documents && !!detail.data?.case_id,
    queryFn: () => api<{ documents: ApplicationDoc[] }>(`/applications/${detail.data!.case_id}`).then((w) => w.documents),
  });
  const docs = (documents ?? caseDocs.data ?? []).filter((d) => d.review_status !== 'superseded');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('in_person');
  const [linked, setLinked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body: object, done: string) => {
    setError(null);
    try { await api(`/info-requests/${id}/${path}`, { body }); toast('success', done); setNote(''); setLinked([]); void qc.invalidateQueries({ queryKey: ['processor'] }); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Drawer open title={detail.data?.request_no ?? 'Information request'} subtitle={detail.data && <RequestStatusBadge r={detail.data} />} onClose={onClose}>
      <QueryState query={detail}>
        {(r) => {
          const open = ['pending', 'response_received', 'partially_satisfied'].includes(r.status);
          return (
            <div className="stack small">
              <dl className="facts">
                <dt>Application</dt><dd><Link to={`/processor/applications/${r.case_id}`}>{r.case_no}</Link></dd>
                <dt>Category</dt><dd>{human(r.category)}</dd>
                <dt>Requested</dt><dd>{r.items}</dd>
                <dt>Explanation</dt><dd>{r.explanation}</dd>
                <dt>Channel</dt><dd>{human(r.channel)} · {DELIVERY_LABELS[r.delivery_status]}{r.delivered_note ? ` (${r.delivered_note})` : ''}</dd>
                <dt>Deadline</dt><dd>{r.due_date?.slice(0, 10) ?? 'none'}</dd>
                {r.internal_note && <><dt>Internal note</dt><dd>{r.internal_note}</dd></>}
              </dl>
              <h3>History</h3>
              <ul className="timeline">{r.events.map((e, i) => <li key={i}><strong>{human(e.action)}</strong> · {e.actor} · {fmtDateTime(e.at)}{e.note && <div>{e.note}</div>}{e.document_nos && <div className="muted">Documents: {e.document_nos.join(', ')}</div>}</li>)}</ul>
              <ErrorBanner error={error} />
              <label>Note <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              {r.delivery_status !== 'delivered_manually' && open && (
                <button className="secondary" disabled={note.trim().length < 5} onClick={() => void act('delivered', { note }, 'Delivery recorded')}>Record that we delivered it (in person, letter, phone)</button>
              )}
              {open && (
                <fieldset className="role-fieldset">
                  <legend>Record the applicant's response</legend>
                  <label>Received by
                    <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                      <option value="in_person">In person</option><option value="phone">Telephone</option><option value="letter">Letter</option><option value="email">E-mail</option><option value="sms">SMS</option><option value="other">Other</option>
                    </select>
                  </label>
                  {docs.length > 0 && <div className="check-grid">{docs.map((d) => (
                    <label key={d.id} className="check"><input type="checkbox" checked={linked.includes(d.id)} onChange={(e) => setLinked(e.target.checked ? [...linked, d.id] : linked.filter((x) => x !== d.id))} /> {d.document_no} {d.doc_label}</label>
                  ))}</div>}
                  <p className="muted">Upload new documents on the application first, then link them here.</p>
                  <button disabled={note.trim().length < 5} onClick={() => void act('responses', { note, channel, documentIds: linked }, 'Response recorded')}>Record response</button>
                </fieldset>
              )}
              <div className="chip-row">
                {r.status === 'response_received' && <button className="secondary" disabled={note.trim().length < 5} onClick={() => void act('status', { to: 'partially_satisfied', note }, 'Marked partially satisfied')}>Partially satisfied</button>}
                {['response_received', 'partially_satisfied'].includes(r.status) && <button onClick={() => void act('status', { to: 'satisfied', note: note || undefined }, 'Marked satisfied')}>Satisfied</button>}
                {open && <button className="danger-btn" disabled={note.trim().length < 5} onClick={() => void act('status', { to: 'closed', note }, 'Request closed')}>Close (no longer needed)</button>}
                {r.status !== 'pending' && <button className="secondary" disabled={note.trim().length < 5} onClick={() => void act('status', { to: 'reopened', note }, 'Request reopened')}>Reopen</button>}
              </div>
            </div>
          );
        }}
      </QueryState>
    </Drawer>
  );
}

export function InfoRequestsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const openId = params.get('open');
  const list = useQuery({ queryKey: ['processor', 'info-requests', status], queryFn: () => api<InfoRequestRow[]>(`/info-requests${qs(status !== 'all' && `status=${status}`)}`) });
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Additional Information Requests</h1><p className="muted small">Requests to applicants and their responses. Nothing is sent automatically: no e-mail or SMS provider is configured.</p></div></div>
      <Panel>
        <div className="segmented" role="group" aria-label="Status">
          {[['open', 'Open'], ['pending', 'Pending'], ['response_received', 'Responses received'], ['partially_satisfied', 'Partially satisfied'], ['overdue', 'Overdue'], ['satisfied', 'Satisfied'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={status === k ? 'active' : ''} onClick={() => set('status', k)}>{l}</button>
          ))}
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No requests" />}>
        {(rows) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Request</th><th>Application</th><th>Applicant</th><th>Requested</th><th>Channel</th><th>Status</th><th>Due</th><th>By</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} className="row-click" tabIndex={0} onClick={() => set('open', r.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('open', r.id); }}>
                  <td>{r.request_no}</td><td>{r.case_no}</td><td>{r.applicant_name ?? '—'}</td><td className="small">{r.items}</td>
                  <td className="small">{human(r.channel)}<div className="muted">{DELIVERY_LABELS[r.delivery_status]}</div></td>
                  <td><RequestStatusBadge r={r} /></td><td>{r.due_date?.slice(0, 10) ?? '—'}</td><td>{r.requested_by}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        )}
      </QueryState>
      {openId && <InfoRequestDrawer id={openId} onClose={() => set('open', null)} />}
    </div>
  );
}
