import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, CASE_TYPE_LABELS } from '../../api';
import { Badge, EmptyState, fmtDateTime, Panel, QueryState, ReasonDialog, usePatchParams, useToast } from '../../components/kit';
import type { QueueItem, WorkloadRow } from '../../types';
import { CreateTaskModal, EscalateDialog, fmtDate, qs, useSupervision, type EscalationDefaults, type TaskDefaults } from './common';
import { CaseDrawer } from './WorkQueue';
import { TaskDrawer } from './Tasks';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Staff workload
// ---------------------------------------------------------------------------

interface WorkloadResponse {
  range: { from: string; to: string };
  staff: WorkloadRow[];
  assignments: { id: string; task_no: string; task_type: string; title: string; status: string; priority: string; due_date: string | null; assignee_id: string; case_no: string | null }[];
}

export function WorkloadPage() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { scope, countyQs } = useSupervision();
  const role = params.get('role') ?? '';
  const taskType = params.get('taskType') ?? '';
  const staffId = params.get('staffId') ?? '';
  const from = params.get('from') ?? isoDay(new Date(Date.now() - 29 * 86_400_000));
  const to = params.get('to') ?? isoDay(new Date());
  const query = qs(countyQs, role && `role=${role}`, taskType && `taskType=${taskType}`, staffId && `staffId=${staffId}`, `from=${from}`, `to=${to}`);
  const data = useQuery({ queryKey: ['supervision', 'workload', query], queryFn: () => api<WorkloadResponse>(`/supervision/workload${query}`) });
  const open = params.get('task');

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Staff Workload</h1>
          <p className="muted">Tasks per GIS officer and processor in your scope. These are raw counts: they do not account for task complexity, leave or assignment volume, and are not a measure of individual performance.</p>
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label>Role<select value={role} onChange={(e) => patch({ role: e.target.value })}><option value="">GIS officers and processors</option><option value="gis_officer">GIS officers</option><option value="processor">Processors</option></select></label>
          <label>Task type<select value={taskType} onChange={(e) => patch({ taskType: e.target.value })}><option value="">All</option>{scope?.taskTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
          <label>From<input type="date" value={from} max={to} onChange={(e) => patch({ from: e.target.value })} /></label>
          <label>To<input type="date" value={to} min={from} onChange={(e) => patch({ to: e.target.value })} /></label>
          {staffId && <button className="link" onClick={() => patch({ staffId: '' })}>Show all staff</button>}
        </div>
        <QueryState query={data} isEmpty={(d) => d.staff.length === 0} empty={<EmptyState title="No GIS officers or processors in this scope" />}>
          {(d) => (
            <div className="table-scroll">
              <table className="table">
                <caption className="sr-only">Workload per officer</caption>
                <thead><tr><th>Officer</th><th>Role</th><th>Assigned</th><th>Active</th><th>Blocked</th><th>Overdue</th><th>Returned</th><th>Awaiting response</th><th>Completed (period)</th><th>Avg. hours to complete</th><th>Open by type</th></tr></thead>
                <tbody>
                  {d.staff.map((s) => (
                    <tr key={s.id}>
                      <td><button className="link" onClick={() => patch({ staffId: s.id })}>{s.display_name}</button><div className="tiny muted">{s.username}</div></td>
                      <td className="small">{s.roles.replace(/_/g, ' ')}</td>
                      <td>{s.assigned}</td><td>{s.active}</td><td>{s.blocked}</td>
                      <td>{s.overdue ? <Badge value="error" label={String(s.overdue)} /> : 0}</td>
                      <td>{s.returned}</td><td>{s.awaiting_response}</td><td>{s.completed}</td>
                      <td>{s.avg_completion_hours ?? '—'}</td>
                      <td className="tiny">{Object.entries(s.openByType).map(([k, n]) => `${scope?.taskTypes.find((t) => t.key === k)?.label ?? k}: ${n}`).join('; ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Panel>
      <Panel title="Current assignments" actions={<span className="muted small">Open a task to reassign it (a reason is required)</span>}>
        <QueryState query={data} isEmpty={(d) => d.assignments.length === 0} empty={<EmptyState title="No open assignments" />}>
          {(d) => (
            <table className="table">
              <thead><tr><th>Task</th><th>Assignee</th><th>Application</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead>
              <tbody>
                {d.assignments.map((a) => (
                  <tr key={a.id} className="row-click" tabIndex={0} onClick={() => patch({ task: a.id })} onKeyDown={(e) => e.key === 'Enter' && patch({ task: a.id })}>
                    <td><strong>{a.task_no}</strong> {a.title}</td>
                    <td>{d.staff.find((s) => s.id === a.assignee_id)?.username ?? '—'}</td>
                    <td>{a.case_no ?? '—'}</td><td><Badge value={a.status} /></td><td><Badge value={a.priority} /></td><td className="small">{fmtDate(a.due_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryState>
      </Panel>
      {open && <TaskDrawer id={open} onClose={() => patch({ task: '' })} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overdue work and bottlenecks
// ---------------------------------------------------------------------------

interface OverdueResponse {
  tasks: { id: string; task_no: string; task_type: string; title: string; status: string; priority: string; due_date: string; days_overdue: number;
    county_id: number; county_code: string; case_id: string | null; case_no: string | null; assignee: string | null; days_in_status: string;
    last_follow_up: string | null; blocking_issue: string | null }[];
  cases: (QueueItem & { last_follow_up: string | null })[];
  targetsConfigured: boolean;
  targets: Record<string, number> | null;
  basis: string;
}
interface Bottlenecks {
  informational: boolean; targets: Record<string, number> | null;
  completedStays: { status: string; n: number; avgHours: number | null; medianHours: number | null }[];
  currentlyIn: { stage: string; status: string; n: number; label: string; avg_age_days: number; max_age_days: number; target_days: number | null }[];
}

export function OverduePage() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { countyQs } = useSupervision();
  const qc = useQueryClient();
  const toast = useToast();
  const data = useQuery({ queryKey: ['supervision', 'overdue', countyQs], queryFn: () => api<OverdueResponse>(`/supervision/overdue${qs(countyQs)}`) });
  const bottlenecks = useQuery({ queryKey: ['supervision', 'bottlenecks', countyQs], queryFn: () => api<Bottlenecks>(`/supervision/bottlenecks${qs(countyQs)}`) });
  const [follow, setFollow] = useState<{ kind: 'task' | 'case'; id: string; label: string } | null>(null);
  const [taskFor, setTaskFor] = useState<TaskDefaults | null>(null);
  const [escalate, setEscalate] = useState<EscalationDefaults | null>(null);
  const openCase = params.get('case');
  const openTask = params.get('task');

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Overdue Cases and Bottlenecks</h1>
          <p className="muted">Due dates and stage targets are internal operational settings, not statutory or regulatory deadlines.</p>
        </div>
      </div>
      {data.data && <p className="muted small">Basis: {data.data.basis}.</p>}

      <Panel title="Overdue tasks">
        <QueryState query={data} isEmpty={(d) => d.tasks.length === 0} empty={<EmptyState title="No overdue tasks" />}>
          {(d) => (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Task</th><th>Application</th><th>Responsible</th><th>Due</th><th>Days overdue</th><th>Days in status</th><th>Last follow-up</th><th>Blocking issue</th><th>Actions</th></tr></thead>
                <tbody>
                  {d.tasks.map((t) => (
                    <tr key={t.id}>
                      <td><button className="link" onClick={() => patch({ task: t.id })}><strong>{t.task_no}</strong></button> {t.title}<div className="tiny"><Badge value={t.status} /> <Badge value={t.priority} /></div></td>
                      <td>{t.case_no ?? '—'}</td><td>{t.assignee ?? 'unassigned'}</td><td className="small">{fmtDate(t.due_date)}</td>
                      <td><Badge value="error" label={`${t.days_overdue} d`} /></td><td>{t.days_in_status}</td>
                      <td className="small">{t.last_follow_up ? fmtDateTime(t.last_follow_up) : '—'}</td>
                      <td className="small">{t.blocking_issue ?? '—'}</td>
                      <td className="row wrap">
                        {t.assignee && <button className="link small" onClick={() => setFollow({ kind: 'task', id: t.id, label: t.task_no })}>Follow up</button>}
                        <button className="link small" onClick={() => patch({ task: t.id })}>Reassign…</button>
                        <button className="link small danger" onClick={() => setEscalate({ countyId: t.county_id, caseId: t.case_id ?? undefined, caseNo: t.case_no ?? undefined, taskId: t.id, category: 'processing_delay', title: `Overdue task ${t.task_no}` })}>Escalate</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Panel>

      <Panel title="Overdue applications">
        <QueryState query={data} isEmpty={(d) => d.cases.length === 0} empty={<EmptyState title="No overdue applications">{data.data && !data.data.targetsConfigured && 'No stage targets are configured, so only applications with a due date can be overdue.'}</EmptyState>}>
          {(d) => (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Application</th><th>Stage</th><th>Responsible</th><th>Due</th><th>Days overdue</th><th>In stage since</th><th>Last follow-up</th><th>Actions</th></tr></thead>
                <tbody>
                  {d.cases.map((c) => (
                    <tr key={c.id}>
                      <td><button className="link" onClick={() => patch({ case: c.id })}><strong>{c.case_no}</strong></button><div className="tiny muted">{CASE_TYPE_LABELS[c.case_type]}</div></td>
                      <td><Badge value={c.stage} /></td><td className="small">{c.assignees ?? `opened by ${c.opened_by}`}</td>
                      <td className="small">{fmtDate(c.due_date)}</td><td><Badge value="error" label={`${c.days_overdue} d`} /></td>
                      <td className="small">{fmtDate(c.stage_since)}</td><td className="small">{c.last_follow_up ? fmtDateTime(c.last_follow_up) : '—'}</td>
                      <td className="row wrap">
                        <button className="link small" onClick={() => setFollow({ kind: 'case', id: c.id, label: c.case_no })}>Request update</button>
                        <button className="link small" onClick={() => setTaskFor({ countyId: c.county_id, caseId: c.id, caseNo: c.case_no, taskType: 'application_follow_up', title: `Follow up overdue ${c.case_no}` })}>Assign follow-up</button>
                        <button className="link small danger" onClick={() => setEscalate({ countyId: c.county_id, caseId: c.id, caseNo: c.case_no, category: 'processing_delay', title: `Prolonged delay on ${c.case_no}` })}>Escalate</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Panel>

      <Panel title="Bottlenecks" actions={bottlenecks.data?.informational && <Badge value="unknown" label="Informational: no targets configured" />}>
        <QueryState query={bottlenecks} skeletonLines={4}>
          {(b) => (
            <div className="grid-2">
              <div>
                <h3 className="small">Open applications by stage, and how long they have been there</h3>
                <table className="table">
                  <thead><tr><th>Stage</th><th>Applications</th><th>Average age (days)</th><th>Oldest (days)</th><th>Target (days)</th></tr></thead>
                  <tbody>{b.currentlyIn.map((r) => <tr key={r.stage}><td>{r.label}</td><td>{r.n}</td><td>{r.avg_age_days}</td><td>{r.max_age_days}</td><td>{r.target_days ?? '—'}</td></tr>)}</tbody>
                </table>
              </div>
              <div>
                <h3 className="small">Completed stays in the last 30 days (from the case history)</h3>
                <table className="table">
                  <thead><tr><th>Status</th><th>Stays</th><th>Average hours</th><th>Median hours</th></tr></thead>
                  <tbody>{b.completedStays.map((r) => <tr key={r.status}><td>{r.status.replace('_', ' ')}</td><td>{r.n}</td><td>{r.avgHours ?? '—'}</td><td>{r.medianHours ?? '—'}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </QueryState>
      </Panel>

      {follow && (
        <ReasonDialog open title={`Request a progress update: ${follow.label}`} confirmLabel="Send" description="Sends an in-app notification and records the follow-up."
          onClose={() => setFollow(null)} onConfirm={async (message) => {
            await api(follow.kind === 'task' ? `/tasks/${follow.id}/follow-up` : `/supervision/cases/${follow.id}/follow-up`, { body: { message } });
            await qc.invalidateQueries({ queryKey: ['supervision'] });
            toast('success', 'Follow-up sent');
          }} />
      )}
      <CreateTaskModal open={Boolean(taskFor)} onClose={() => setTaskFor(null)} defaults={taskFor ?? {}} />
      {escalate && <EscalateDialog open onClose={() => setEscalate(null)} defaults={escalate} />}
      {openCase && <CaseDrawer caseId={openCase} onClose={() => patch({ case: '' })} />}
      {openTask && <TaskDrawer id={openTask} onClose={() => patch({ task: '' })} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supervisory activity history
// ---------------------------------------------------------------------------

interface ActivityEvent { chain_seq: string; at: string; actor_username: string | null; action: string; outcome: string; entity_type: string | null; entity_id: string | null; case_id: string | null; case_no: string | null; county_code: string | null; detail: Record<string, unknown> }

export function ActivityPage() {
  const { countyQs } = useSupervision();
  const [mine, setMine] = useState(false);
  const [action, setAction] = useState('');
  const query = qs(countyQs, mine && 'mine=true', action && `action=${action}`, 'limit=100');
  const data = useQuery({ queryKey: ['supervision', 'activity', query], queryFn: () => api<{ events: ActivityEvent[] }>(`/supervision/activity${query}`) });
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Activity History</h1><p className="muted">Supervisory actions, tasks, escalations, reports and registrar decisions in your scope, from the tamper-evident audit trail. Audit records cannot be edited or deleted.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label>Type
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All</option><option value="supervision.">Quality reviews and case supervision</option><option value="task.">Tasks</option>
              <option value="escalation.">Escalations</option><option value="conflict.">Conflict reviews</option><option value="report.">Reports</option><option value="case.">Registrar decisions and submissions</option>
            </select>
          </label>
          <label className="inline"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my actions</label>
        </div>
        <QueryState query={data} isEmpty={(d) => d.events.length === 0} empty={<EmptyState title="No activity yet" />}>
          {(d) => (
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>County</th><th>Outcome</th></tr></thead>
              <tbody>
                {d.events.map((e) => (
                  <tr key={e.chain_seq}>
                    <td className="small">{fmtDateTime(e.at)}</td><td>{e.actor_username ?? 'system'}</td><td><code className="small">{e.action}</code></td>
                    <td className="small">{e.case_no ? <Link to={`/work/cases/${e.case_id}`}>{e.case_no}</Link> : `${e.entity_type ?? ''} ${e.entity_id?.slice(0, 8) ?? ''}`}</td>
                    <td>{e.county_code ?? '—'}</td><td><Badge value={e.outcome === 'success' ? 'active' : 'error'} label={e.outcome} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
