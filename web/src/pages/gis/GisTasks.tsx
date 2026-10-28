import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';
import { Badge, EmptyState, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, useToast } from '../../components/kit';
import type { GisTask } from '../../types';

/**
 * The GIS officer's tasks: acknowledge, start, add a note, block, ask for clarification, complete.
 * A task that stands for preparing a case cannot be completed until the case has been (re)submitted;
 * the server enforces that and explains it.
 */
type Action = { task: GisTask; kind: 'note' | 'block' | 'clarify' | 'complete' };

export function GisTasks() {
  const qc = useQueryClient();
  const toast = useToast();
  const tasks = useQuery({ queryKey: ['gis', 'tasks'], queryFn: () => api<{ mine: GisTask[]; claimable: GisTask[] }>('/gis/tasks') });
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const done = (msg: string) => { toast('success', msg); void qc.invalidateQueries({ queryKey: ['gis'] }); };
  const simple = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: object }) => api(`/tasks/${id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => done('Task updated'),
    onError: (e) => toast('error', (e as Error).message),
  });
  const submitAction = useMutation({
    mutationFn: async ({ task, kind }: Action) => {
      if (kind === 'note') return api(`/tasks/${task.id}/comments`, { method: 'POST', body: { note: text } });
      if (kind === 'clarify') return api(`/tasks/${task.id}/clarification`, { method: 'POST', body: { question: text } });
      return api(`/tasks/${task.id}/status`, { method: 'POST', body: { to: kind === 'block' ? 'blocked' : 'completed', note: text } });
    },
    onSuccess: () => { setAction(null); setText(''); done('Task updated'); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The change could not be saved'),
  });

  const open = (task: GisTask, kind: Action['kind']) => { setAction({ task, kind }); setText(''); setError(null); };
  const titles = { note: 'Add a note', block: 'Mark as blocked', clarify: 'Request clarification', complete: 'Complete task' };

  const row = (t: GisTask, claimable = false) => (
    <tr key={t.id}>
      <td><strong>{t.task_no}</strong><br /><span className="small">{t.title}</span>{t.description && <div className="muted small">{t.description}</div>}</td>
      <td>{t.case_id ? <Link to={`/work/cases/${t.case_id}`}>{t.case_no}</Link> : '—'}{t.case_status && <div className="muted small">{t.case_status}</div>}</td>
      <td><Badge value={t.status} />{t.overdue && <> <Badge value="urgent" label="overdue" /></>}</td>
      <td><Badge value={t.priority} /></td>
      <td>{t.due_date?.slice(0, 10) ?? '—'}</td>
      <td className="small">{t.created_by_username}{t.acknowledged_at && <div className="muted">Acknowledged {fmtDateTime(t.acknowledged_at)}</div>}
        {t.last_clarification && <div className="muted">Asked: “{t.last_clarification}”</div>}</td>
      <td>
        <div className="chip-row">
          {claimable && <button className="small-btn" onClick={() => simple.mutate({ id: t.id, path: 'claim' })}>Claim</button>}
          {!claimable && ['assigned', 'returned'].includes(t.status) && !t.acknowledged_at && <button className="secondary small-btn" onClick={() => simple.mutate({ id: t.id, path: 'acknowledge' })}>Acknowledge</button>}
          {!claimable && ['assigned', 'returned', 'blocked'].includes(t.status) && <button className="small-btn" onClick={() => simple.mutate({ id: t.id, path: 'status', body: { to: 'in_progress' } })}>{t.status === 'blocked' ? 'Resume' : 'Begin'}</button>}
          {!claimable && t.status === 'in_progress' && <button className="secondary small-btn" onClick={() => open(t, 'block')}>Block</button>}
          {!claimable && ['assigned', 'in_progress', 'returned', 'blocked'].includes(t.status) && (
            <>
              <button className="secondary small-btn" onClick={() => open(t, 'note')}>Note</button>
              <button className="secondary small-btn" onClick={() => open(t, 'clarify')}>Ask</button>
            </>
          )}
          {!claimable && ['assigned', 'in_progress', 'returned'].includes(t.status) && <button className="small-btn" onClick={() => open(t, 'complete')}>Complete</button>}
          {!claimable && t.case_id && ['assigned', 'in_progress', 'returned'].includes(t.status) && <Link className="small" to={`/gis/submit?case=${t.case_id}`}>Submit case</Link>}
        </div>
      </td>
    </tr>
  );
  const head = <thead><tr><th>Task</th><th>Case</th><th>Status</th><th>Priority</th><th>Due</th><th>From</th><th>Actions</th></tr></thead>;

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>My GIS Tasks</h1><p className="muted small">A task is a work item: it never grants a permission. Preparation tasks complete only after the case has been submitted.</p></div></div>
      <QueryState query={tasks}>
        {(d) => (
          <>
            <Panel title={`Assigned to me (${d.mine.length})`}>
              {d.mine.length === 0 ? <EmptyState title="No tasks assigned to you" /> : <div className="table-wrap"><table className="table">{head}<tbody>{d.mine.map((t) => row(t))}</tbody></table></div>}
            </Panel>
            <Panel title={`Unassigned GIS tasks you can claim (${d.claimable.length})`}>
              {d.claimable.length === 0 ? <EmptyState title="Nothing to claim" /> : <div className="table-wrap"><table className="table">{head}<tbody>{d.claimable.map((t) => row(t, true))}</tbody></table></div>}
            </Panel>
          </>
        )}
      </QueryState>
      <Modal open={!!action} title={action ? `${titles[action.kind]}: ${action.task.task_no}` : ''} onClose={() => setAction(null)}
        footer={<><button className="secondary" onClick={() => setAction(null)}>Cancel</button><button disabled={text.trim().length < 5 || submitAction.isPending} onClick={() => action && submitAction.mutate(action)}>Save</button></>}>
        <ErrorBanner error={error} />
        <label>{action?.kind === 'clarify' ? 'Your question to the supervisor' : action?.kind === 'complete' ? 'What was done' : action?.kind === 'block' ? 'Why it is blocked' : 'Note'}
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="At least 5 characters" />
        </label>
      </Modal>
    </div>
  );
}
