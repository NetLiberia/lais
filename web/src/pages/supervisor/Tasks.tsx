import { useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List, Plus } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import {
  Badge, DataTable, Drawer, EmptyState, ErrorBanner, Modal, Pagination, Panel, QueryState, ReasonDialog, usePatchParams, useToast, type Column,
} from '../../components/kit';
import type { Paged, Priority, TaskDetail, TaskRow, TaskStatus } from '../../types';
import { AssigneeSelect, CreateTaskModal, EscalateDialog, fmtDate, PRIORITIES, qs, useSupervision } from './common';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'unassigned', label: 'Unassigned' }, { status: 'assigned', label: 'Assigned' }, { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' }, { status: 'returned', label: 'Returned' }, { status: 'completed', label: 'Completed' },
];
const NEEDS_NOTE: TaskStatus[] = ['blocked', 'completed', 'returned', 'cancelled'];
const MOVE_LABELS: Record<string, string> = {
  in_progress: 'Start / resume', blocked: 'Mark blocked', completed: 'Mark completed', returned: 'Return for more work', cancelled: 'Cancel task',
};

/** Tasks: supervisors see their counties (table and board); everyone else sees the tasks assigned to them. */
export function TasksPage({ mode }: { mode: 'scope' | 'mine' }) {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { scope, countyQs } = useSupervision();
  const { can } = useAuth();
  const manage = mode === 'scope' && can('task.manage');
  const [view, setView] = useState<'table' | 'board'>(() => (params.get('view') === 'board' ? 'board' : 'table'));
  const [creating, setCreating] = useState(false);
  const status = params.get('status') ?? (mode === 'mine' ? 'open' : '');
  const type = params.get('type') ?? '';
  const priority = params.get('priority') ?? '';
  const q = params.get('q') ?? '';
  const overdue = params.get('overdue') === 'true';
  const page = Number(params.get('page') ?? 1);
  const pageSize = view === 'board' ? 200 : Number(params.get('pageSize') ?? 25);
  const query = qs(`view=${mode}`, mode === 'scope' && countyQs, view === 'table' && status && `status=${status}`, type && `type=${type}`,
    priority && `priority=${priority}`, q && `q=${encodeURIComponent(q)}`, overdue && 'overdue=true', `page=${view === 'board' ? 1 : page}`, `pageSize=${pageSize}`);
  const list = useQuery({ queryKey: ['tasks', query], queryFn: () => api<Paged<TaskRow>>(`/tasks${query}`), placeholderData: keepPreviousData });
  const openId = params.get('task');

  const columns: Column<TaskRow>[] = [
    { key: 'task', header: 'Task', render: (t) => <><strong>{t.task_no}</strong> {t.title}<div className="muted tiny">{scope?.taskTypes.find((x) => x.key === t.task_type)?.label ?? t.task_type.replace(/_/g, ' ')}</div></> },
    { key: 'case', header: 'Application', render: (t) => t.case_no ?? '—' },
    { key: 'county', header: 'County', render: (t) => t.county_code, className: 'hide-sm' },
    { key: 'assignee', header: 'Assignee', render: (t) => t.assignee ?? <Badge value="unassigned" /> },
    { key: 'status', header: 'Status', render: (t) => <Badge value={t.status} /> },
    { key: 'priority', header: 'Priority', render: (t) => <Badge value={t.priority} /> },
    { key: 'due', header: 'Due', render: (t) => <span className="small">{fmtDate(t.due_date)}{t.overdue && <> <Badge value="error" label={`${t.days_overdue} d overdue`} /></>}</span> },
    { key: 'updated', header: 'Updated', render: (t) => <span className="small">{fmtDate(t.updated_at)}</span>, className: 'hide-sm' },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>{mode === 'mine' ? 'My tasks' : 'Task Assignment'}</h1>
          <p className="muted">{mode === 'mine' ? 'Work assigned to you. Start, block, comment on and complete it here.' : 'Operational tasks in your scope. A task is a work item only: it never gives the assignee extra permissions.'}</p>
        </div>
        <div className="page-actions">
          {mode === 'scope' && (
            <div className="segmented" role="group" aria-label="View">
              <button className={view === 'table' ? 'active' : 'secondary'} aria-pressed={view === 'table'} onClick={() => { setView('table'); patch({ view: '' }); }}><List size={16} /> Table</button>
              <button className={view === 'board' ? 'active' : 'secondary'} aria-pressed={view === 'board'} onClick={() => { setView('board'); patch({ view: 'board' }); }}><LayoutGrid size={16} /> Board</button>
            </div>
          )}
          {manage && <button onClick={() => setCreating(true)}><Plus size={16} /> Create task</button>}
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label className="grow">Search<input type="search" defaultValue={q} placeholder="Task, title or application" onKeyDown={(e) => e.key === 'Enter' && patch({ q: (e.target as HTMLInputElement).value }, { resetPage: true })} /></label>
          {view === 'table' && (
            <label>Status<select value={status} onChange={(e) => patch({ status: e.target.value }, { resetPage: true })}>
              <option value="">All</option><option value="open">All open</option>{[...COLUMNS.map((c) => c.status), 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select></label>
          )}
          <label>Type<select value={type} onChange={(e) => patch({ type: e.target.value }, { resetPage: true })}><option value="">All</option>{scope?.taskTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={(e) => patch({ priority: e.target.value }, { resetPage: true })}><option value="">All</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="inline"><input type="checkbox" checked={overdue} onChange={(e) => patch({ overdue: e.target.checked ? 'true' : '' }, { resetPage: true })} /> Overdue only</label>
        </div>
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title={mode === 'mine' ? 'No tasks assigned to you' : 'No tasks match'} />}>
          {(d) => view === 'board' ? <Board tasks={d.items} onOpen={(id) => patch({ task: id })} /> : (
            <>
              <DataTable caption="Tasks" columns={columns} rows={d.items} rowKey={(t) => t.id} onRowClick={(t) => patch({ task: t.id })} />
              <Pagination page={page} pageSize={pageSize} total={d.total} onPage={(p) => patch({ page: p })} onPageSize={(s) => patch({ pageSize: s }, { resetPage: true })} />
            </>
          )}
        </QueryState>
      </Panel>
      {openId && <TaskDrawer id={openId} onClose={() => patch({ task: '' })} />}
      <CreateTaskModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/**
 * Kanban board. Dropping a card asks the server for that move; the card only moves when the server
 * accepts. Moves the server would refuse are offered nowhere, and each card has a keyboard "move" menu.
 */
function Board({ tasks, onOpen }: { tasks: TaskRow[]; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [drag, setDrag] = useState<TaskRow | null>(null);
  const [pending, setPending] = useState<{ task: TaskRow; to: TaskStatus } | null>(null);
  const move = async (task: TaskRow, to: TaskStatus, note?: string) => {
    await api(`/tasks/${task.id}/status`, { body: { to, note } });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    toast('success', `${task.task_no} moved to ${to.replace('_', ' ')}`);
  };
  const drop = (to: TaskStatus) => (e: DragEvent) => {
    e.preventDefault();
    const task = drag;
    setDrag(null);
    if (!task || task.status === to) return;
    if (to === 'unassigned' || (to === 'assigned' && task.status === 'unassigned')) { onOpen(task.id); toast('info', 'Assign the task from its detail panel'); return; }
    if (NEEDS_NOTE.includes(to)) setPending({ task, to });
    else void move(task, to).catch((err) => toast('error', (err as Error).message));
  };
  return (
    <>
      <div className="kanban" role="list" aria-label="Task board">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section key={col.status} className="kanban-col" role="listitem" aria-label={`${col.label}, ${items.length} task(s)`}
              onDragOver={(e) => e.preventDefault()} onDrop={drop(col.status)}>
              <h3>{col.label} <span className="muted">{items.length}</span></h3>
              {items.map((t) => (
                <article key={t.id} className={`kanban-card ${t.overdue ? 'overdue' : ''}`} draggable onDragStart={() => setDrag(t)} onDragEnd={() => setDrag(null)}>
                  <button className="link" onClick={() => onOpen(t.id)}><strong>{t.task_no}</strong></button> <Badge value={t.priority} />
                  <div className="small">{t.title}</div>
                  <div className="tiny muted">{t.assignee ?? 'unassigned'}{t.case_no && ` · ${t.case_no}`}{t.due_date && ` · due ${fmtDate(t.due_date)}`}</div>
                </article>
              ))}
            </section>
          );
        })}
      </div>
      <p className="muted small">Drag a card to change its status, or open it to see the moves you may make. Every move is checked by the server and recorded.</p>
      {pending && (
        <ReasonDialog open title={`${MOVE_LABELS[pending.to] ?? pending.to}: ${pending.task.task_no}`} confirmLabel="Confirm"
          description={pending.to === 'completed' ? 'Describe what was done.' : pending.to === 'blocked' ? 'What is blocking the work?' : 'Explain why.'}
          onClose={() => setPending(null)} onConfirm={(note) => move(pending.task, pending.to, note)} />
      )}
    </>
  );
}

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['tasks', 'detail', id], queryFn: () => api<TaskDetail>(`/tasks/${id}`) });
  const [dialog, setDialog] = useState<null | 'assign' | 'edit' | 'comment' | 'follow' | 'escalate' | TaskStatus>(null);
  const refresh = async (msg: string) => { await qc.invalidateQueries({ queryKey: ['tasks'] }); await qc.invalidateQueries({ queryKey: ['supervision'] }); toast('success', msg); };
  const d = detail.data;
  return (
    <Drawer open title={d ? `${d.task.task_no}: ${d.task.title}` : 'Task'} subtitle={d && <><Badge value={d.task.status} /> <Badge value={d.task.priority} /></>} onClose={onClose}>
      <QueryState query={detail} skeletonLines={8}>
        {(x) => (
          <div className="stack">
            <dl className="facts">
              <dt>Type</dt><dd>{x.task.type_label}</dd>
              <dt>County</dt><dd>{x.task.county_name}</dd>
              {x.task.case_no && <><dt>Application</dt><dd><Link to={`/work/cases/${x.task.case_id}`}>{x.task.case_no}</Link></dd></>}
              {x.task.source_filename && <><dt>GIS submission</dt><dd>{x.task.source_filename}</dd></>}
              {x.task.finding_code && <><dt>Conflict</dt><dd><code>{x.task.finding_code}</code> {x.task.finding_message}</dd></>}
              <dt>Assignee</dt><dd>{x.task.assignee ?? 'unassigned'}</dd>
              <dt>Created</dt><dd>{fmtDate(x.task.created_at)} by {x.task.created_by_username}</dd>
              <dt>Due</dt><dd>{fmtDate(x.task.due_date)} {x.task.overdue && <Badge value="error" label="overdue" />}</dd>
              {x.task.reference && <><dt>Reference</dt><dd>{x.task.reference}</dd></>}
            </dl>
            {x.task.description && <p className="small">{x.task.description}</p>}
            {x.task.instructions && <p className="small"><strong>Instructions:</strong> {x.task.instructions}</p>}
            {x.task.completion_note && <p className="small ok-text"><strong>Completion note:</strong> {x.task.completion_note}</p>}
            {x.task.cancel_reason && <p className="small"><strong>Cancelled:</strong> {x.task.cancel_reason}</p>}

            <div className="row wrap">
              {x.permitted.moves.map((m) => (
                <button key={m} className={m === 'cancelled' ? 'secondary danger' : m === 'completed' ? '' : 'secondary'}
                  onClick={() => (m === 'in_progress'
                    ? void api(`/tasks/${id}/status`, { body: { to: m } }).then(() => refresh('Task started')).catch((e) => toast('error', (e as Error).message))
                    : setDialog(m))}>
                  {MOVE_LABELS[m] ?? m}
                </button>
              ))}
              {x.permitted.assign && <button className="secondary" onClick={() => setDialog('assign')}>{x.task.assignee ? 'Reassign' : 'Assign'}</button>}
              {x.permitted.edit && <button className="secondary" onClick={() => setDialog('edit')}>Priority / due date</button>}
              {x.permitted.followUp && <button className="secondary" onClick={() => setDialog('follow')}>Send follow-up</button>}
              {x.permitted.comment && <button className="secondary" onClick={() => setDialog('comment')}>Comment</button>}
              {x.permitted.edit && <button className="secondary danger" onClick={() => setDialog('escalate')}>Escalate</button>}
            </div>

            <section>
              <h3 className="small">History</h3>
              <ol className="timeline">
                {x.events.map((e) => (
                  <li key={e.id}><span className="muted small">{fmtDate(e.at)}</span> <strong>{e.actor}</strong> {e.action.replace(/_/g, ' ')}
                    {e.from_value && e.to_value && ['status_changed', 'priority_changed', 'due_date_changed'].includes(e.action) && <span className="small"> {e.from_value} → {e.to_value}</span>}
                    {e.note && <div className="small">{e.note}</div>}{e.reference && <div className="tiny muted">Ref: {e.reference}</div>}</li>
                ))}
              </ol>
            </section>

            {dialog && NEEDS_NOTE.includes(dialog as TaskStatus) && (
              <ReasonDialog open title={`${MOVE_LABELS[dialog]}: ${x.task.task_no}`} confirmLabel="Confirm" danger={dialog === 'cancelled'}
                description={dialog === 'completed' ? 'Describe what was done (kept as the completion note).' : dialog === 'cancelled' ? 'Tasks are never deleted; the cancellation and its reason stay in the history.' : 'Explain why.'}
                onClose={() => setDialog(null)} onConfirm={async (note) => { await api(`/tasks/${id}/status`, { body: { to: dialog, note } }); await refresh('Task updated'); }} />
            )}
            <AssignDialog open={dialog === 'assign'} task={x} onClose={() => setDialog(null)} onDone={() => refresh('Task assigned')} />
            <EditDialog open={dialog === 'edit'} task={x} onClose={() => setDialog(null)} onDone={() => refresh('Task updated')} />
            <ReasonDialog open={dialog === 'follow'} title={`Follow up ${x.task.task_no}`} confirmLabel="Send" description={`Notifies ${x.task.assignee}.`}
              onClose={() => setDialog(null)} onConfirm={async (message) => { await api(`/tasks/${id}/follow-up`, { body: { message } }); await refresh('Follow-up sent'); }} />
            <ReasonDialog open={dialog === 'comment'} title={`Comment on ${x.task.task_no}`} confirmLabel="Add comment" description="Visible to the assignee and supervisors of this county."
              onClose={() => setDialog(null)} onConfirm={async (note) => { await api(`/tasks/${id}/comments`, { body: { note } }); await refresh('Comment added'); }} />
            <EscalateDialog open={dialog === 'escalate'} onClose={() => setDialog(null)}
              defaults={{ countyId: x.task.county_id, caseId: x.task.case_id ?? undefined, caseNo: x.task.case_no ?? undefined, taskId: x.task.id, category: x.task.overdue ? 'processing_delay' : 'workflow_exception', title: `${x.task.overdue ? 'Overdue' : 'Blocked'} task ${x.task.task_no}` }} />
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

function AssignDialog({ open, task, onClose, onDone }: { open: boolean; task: TaskDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [assigneeId, setAssigneeId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  const reassign = Boolean(task.task.assignee_id);
  const submit = async () => {
    if (!assigneeId) return setError('Choose someone');
    if (reassign && reason.trim().length < 5) return setError('Give a reason for reassigning (5+ characters)');
    try { await api(`/tasks/${task.task.id}/assign`, { body: { assigneeId, reason: reason.trim() || undefined } }); await onDone(); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title={reassign ? `Reassign ${task.task.task_no}` : `Assign ${task.task.task_no}`} onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Save</button></>}>
      <div className="stack">
        <AssigneeSelect countyId={task.task.county_id} taskType={task.task.task_type} value={assigneeId} onChange={setAssigneeId} required />
        <label>Reason{reassign ? ' (required, kept in the history)' : ' (optional)'}<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

function EditDialog({ open, task, onClose, onDone }: { open: boolean; task: TaskDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ priority: task.task.priority, dueDate: task.task.due_date?.slice(0, 10) ?? '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  const submit = async () => {
    if (form.reason.trim().length < 5) return setError('Give a reason (5+ characters)');
    try { await api(`/tasks/${task.task.id}`, { method: 'PATCH', body: { priority: form.priority, dueDate: form.dueDate || null, reason: form.reason.trim() } }); await onDone(); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title={`Priority and due date: ${task.task.task_no}`} onClose={onClose} footer={<><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()}>Save</button></>}>
      <div className="stack">
        <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Due date<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <label>Reason<textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}
