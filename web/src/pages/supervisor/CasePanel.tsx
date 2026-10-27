import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MessageSquarePlus, Undo2 } from 'lucide-react';
import { api } from '../../api';
import { Badge, ErrorBanner, Modal, QueryState, ReasonDialog, useToast } from '../../components/kit';
import type { Priority, SupervisedCase } from '../../types';
import { CreateTaskModal, EscalateDialog, fmtDate, PRIORITIES, today, useSupervision } from './common';

const DECISION_LABELS = { accepted: 'Quality accepted', returned: 'Returned for correction', info_requested: 'Information requested' } as const;

export interface RecordOption { index: number; label: string }
export interface FindingOption { id: string; code: string; message: string; severity: string; feature_index: number | null }

/** Return for correction: reason, at least one issue category, optional records and findings, instructions. */
export function ReturnDialog({ open, onClose, caseId, caseNo, records = [], findings = [] }: {
  open: boolean; onClose: () => void; caseId: string; caseNo: string; records?: RecordOption[]; findings?: FindingOption[];
}) {
  const { scope } = useSupervision();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ reason: '', categories: [] as string[], features: [] as number[], findingIds: [] as string[], instructions: '', dueDate: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm({ reason: '', categories: [], features: [], findingIds: [], instructions: '', dueDate: '' }); setError(null); } }, [open]);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = async () => {
    if (form.categories.length === 0) return setError('Select at least one issue category');
    if (form.reason.trim().length < 10) return setError('Explain what must be corrected (10+ characters)');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ task: { taskNo: string; assignee: string | null } }>(`/supervision/cases/${caseId}/return`, {
        body: { reason: form.reason.trim(), issueCategories: form.categories, affectedFeatures: form.features, findingIds: form.findingIds,
          instructions: form.instructions.trim() || undefined, dueDate: form.dueDate || undefined },
      });
      await qc.invalidateQueries({ queryKey: ['supervision'] });
      toast('success', `${caseNo} returned. Task ${res.task.taskNo} ${res.task.assignee ? `assigned to ${res.task.assignee}` : 'is unassigned: no eligible officer found'}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Return ${caseNo} for correction`} wide footer={
      <><button className="secondary" onClick={onClose}>Cancel</button><button className="danger-btn" onClick={() => void submit()} disabled={busy}><Undo2 size={16} /> Return for correction</button></>
    }>
      <div className="form-grid">
        <fieldset className="span-2">
          <legend>Issue categories (at least one)</legend>
          <div className="check-grid">
            {scope?.issueCategories.map((c) => (
              <label key={c.code} className="inline"><input type="checkbox" checked={form.categories.includes(c.code)} onChange={() => setForm({ ...form, categories: toggle(form.categories, c.code) })} /> {c.label}</label>
            ))}
          </div>
        </fieldset>
        {records.length > 0 && (
          <fieldset className="span-2">
            <legend>Affected records (optional)</legend>
            <div className="check-grid">
              {records.map((r) => <label key={r.index} className="inline"><input type="checkbox" checked={form.features.includes(r.index)} onChange={() => setForm({ ...form, features: toggle(form.features, r.index) })} /> {r.label}</label>)}
            </div>
          </fieldset>
        )}
        {findings.length > 0 && (
          <fieldset className="span-2">
            <legend>Validation findings to correct (optional)</legend>
            <div className="stack compact">
              {findings.map((f) => (
                <label key={f.id} className="inline small"><input type="checkbox" checked={form.findingIds.includes(f.id)} onChange={() => setForm({ ...form, findingIds: toggle(form.findingIds, f.id) })} />
                  <Badge value={f.severity} /> <code>{f.code}</code> {f.message}</label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="span-2">Reason (sent to the responsible officer and kept in the history)<textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <label className="span-2">Correction instructions<textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></label>
        <label>Correction due (operational target)<input type="date" min={today()} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <p className="span-2 muted small">The case goes back to its preparers with a correction task. The submission, its validation results and this review stay in the history.</p>
        <div className="span-2"><ErrorBanner error={error} /></div>
      </div>
    </Modal>
  );
}

function PriorityDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: SupervisedCase }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ priority: data.priority, dueDate: data.dueDate?.slice(0, 10) ?? '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setForm({ priority: data.priority, dueDate: data.dueDate?.slice(0, 10) ?? '', reason: '' }); setError(null); } }, [open, data]);
  const submit = async () => {
    if (form.reason.trim().length < 5) return setError('Give a reason (5+ characters)');
    try {
      await api(`/supervision/cases/${data.caseId}/priority`, { method: 'PATCH', body: { priority: form.priority, dueDate: form.dueDate || null, reason: form.reason.trim() } });
      await qc.invalidateQueries({ queryKey: ['supervision'] });
      toast('success', 'Priority and due date saved');
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Priority and due date: ${data.caseNo}`} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Save</button></>}>
      <div className="stack">
        <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Due date<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <label>Reason<textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <p className="muted small">An internal operational target, not a legal or statutory deadline.</p>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

type Dialog = null | 'accept' | 'return' | 'info' | 'priority' | 'note' | 'follow' | 'task' | 'escalate';

/** Supervision of one case: status, reviews, tasks, escalations and the actions the server allows. */
export function CaseSupervisionPanel({ caseId, records, findings }: { caseId: string; records?: RecordOption[]; findings?: FindingOption[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ['supervision', 'case', caseId], queryFn: () => api<SupervisedCase>(`/supervision/cases/${caseId}`) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const done = async (message: string) => { await qc.invalidateQueries({ queryKey: ['supervision'] }); toast('success', message); };

  return (
    <QueryState query={query} skeletonLines={6}>
      {(d) => (
        <div className="stack">
          <dl className="facts">
            <dt>Stage</dt><dd><Badge value={d.stage} /> <span className="muted small">(status {d.status.replace('_', ' ')})</span></dd>
            <dt>Quality review</dt><dd>{d.qualityAccepted ? <Badge value="accepted" label="Accepted for current results" /> : d.stage === 'quality_review' ? <Badge value="awaiting_review" /> : '—'}
              <span className="muted small"> · {d.reviewMode} before a registrar decision</span></dd>
            <dt>Responsible officer</dt><dd>{d.responsibleOfficer ? `${d.responsibleOfficer.username} (${d.responsibleOfficer.role.replace('_', ' ')})` : '—'}</dd>
            <dt>Priority</dt><dd><Badge value={d.priority} /> {d.dueDate && <span className="small">due {fmtDate(d.dueDate)}</span>}</dd>
          </dl>

          <div className="row wrap">
            {d.canReview && (
              <button onClick={() => setDialog('accept')} disabled={d.acceptBlockedBy.length > 0} title={d.acceptBlockedBy[0]}>
                <CheckCircle2 size={16} /> Accept quality review
              </button>
            )}
            {d.canReview && <button className="secondary" onClick={() => setDialog('return')}><Undo2 size={16} /> Return for correction</button>}
            {d.canReview && <button className="secondary" onClick={() => setDialog('info')}><MessageSquarePlus size={16} /> Request information</button>}
            {d.canSetPriority && <button className="secondary" onClick={() => setDialog('priority')}>Priority / due date</button>}
            <button className="secondary" onClick={() => setDialog('task')}>Create task</button>
            <button className="secondary" onClick={() => setDialog('follow')}>Request progress update</button>
            <button className="secondary" onClick={() => setDialog('note')}>Add note</button>
            <button className="secondary danger" onClick={() => setDialog('escalate')}><AlertTriangle size={16} /> Escalate</button>
          </div>
          {d.canReview && d.acceptBlockedBy.length > 0 && <p className="small muted">Cannot accept: {d.acceptBlockedBy.join('; ')}.</p>}
          {!d.canReview && <p className="small muted">Review actions are available while the case is submitted and awaiting review.</p>}

          <section>
            <h3 className="small">Supervisory reviews</h3>
            {d.reviews.length === 0 ? <p className="muted small">None yet.</p> : (
              <ul className="timeline">
                {d.reviews.map((r) => (
                  <li key={r.id}>
                    <span className="muted small">{fmtDate(r.created_at)}</span> <strong>{DECISION_LABELS[r.decision]}</strong> by {r.reviewer}
                    {r.issue_categories.length > 0 && <div className="small">Issues: {r.issue_categories.map((c) => c.replace(/_/g, ' ')).join(', ')}{r.affected_features.length > 0 && ` · records ${r.affected_features.map((i) => i + 1).join(', ')}`}</div>}
                    <div className="small">{r.notes}</div>
                    {r.instructions && <div className="small muted">Instructions: {r.instructions}</div>}
                    {r.task_no && <div className="small">Task {r.task_no}: <Badge value={r.task_status ?? 'unknown'} />{r.response && <> · response: {r.response}</>}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="small">Tasks</h3>
            {d.tasks.length === 0 ? <p className="muted small">None.</p> : (
              <ul className="plain small">{d.tasks.map((t) => <li key={t.id}>{t.task_no} {t.title} · <Badge value={t.status} /> {t.assignee ?? 'unassigned'}{t.due_date && ` · due ${fmtDate(t.due_date)}`}</li>)}</ul>
            )}
          </section>

          {d.escalations.length > 0 && (
            <section>
              <h3 className="small">Escalations</h3>
              <ul className="plain small">{d.escalations.map((e) => <li key={e.id}>{e.escalation_no} {e.title} · <Badge value={e.severity} /> <Badge value={e.status} /></li>)}</ul>
            </section>
          )}

          {d.notes.length > 0 && (
            <section>
              <h3 className="small">Supervisory notes and follow-ups</h3>
              <ul className="timeline">{d.notes.map((n, i) => <li key={i}><span className="muted small">{fmtDate(n.at)}</span> {n.actor}: <span className="small">{n.note}</span></li>)}</ul>
            </section>
          )}

          <ReasonDialog open={dialog === 'accept'} title={`Accept quality review: ${d.caseNo}`} confirmLabel="Accept"
            description="Records that the current submission meets quality requirements. It is not a legal approval and publishes nothing; the case goes on to the registrar."
            onClose={() => setDialog(null)} onConfirm={async (notes) => { await api(`/supervision/cases/${caseId}/accept`, { body: { notes } }); await done('Quality review accepted'); }} />
          <ReturnDialog open={dialog === 'return'} onClose={() => setDialog(null)} caseId={caseId} caseNo={d.caseNo} records={records} findings={findings} />
          <ReasonDialog open={dialog === 'info'} title={`Request information: ${d.caseNo}`} confirmLabel="Send request"
            description={`Sent as a task to ${d.responsibleOfficer?.username ?? 'the responsible officer'}; their completion note is the response.`}
            onClose={() => setDialog(null)} onConfirm={async (message) => {
              if (message.length < 10) throw new Error('Explain what you need (10+ characters)');
              await api(`/supervision/cases/${caseId}/request-info`, { body: { message } }); await done('Information requested');
            }} />
          <PriorityDialog open={dialog === 'priority'} onClose={() => setDialog(null)} data={d} />
          <ReasonDialog open={dialog === 'note'} title={`Internal note: ${d.caseNo}`} confirmLabel="Add note" description="Added to the case history. Not shown to applicants."
            onClose={() => setDialog(null)} onConfirm={async (note) => { await api(`/supervision/cases/${caseId}/notes`, { body: { note } }); await done('Note added'); }} />
          <ReasonDialog open={dialog === 'follow'} title={`Request a progress update: ${d.caseNo}`} confirmLabel="Send" description="Notifies the officers currently working on this case."
            onClose={() => setDialog(null)} onConfirm={async (message) => {
              const r = await api<{ notified: string[] }>(`/supervision/cases/${caseId}/follow-up`, { body: { message } }); await done(`Follow-up sent to ${r.notified.join(', ')}`);
            }} />
          <CreateTaskModal open={dialog === 'task'} onClose={() => setDialog(null)} defaults={{ countyId: d.countyId, caseId, caseNo: d.caseNo, taskType: 'application_follow_up', title: `Follow up ${d.caseNo}` }} />
          <EscalateDialog open={dialog === 'escalate'} onClose={() => setDialog(null)} defaults={{ countyId: d.countyId, caseId, caseNo: d.caseNo }} />
        </div>
      )}
    </QueryState>
  );
}
