import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock, AlertOctagon, CheckCircle2, ClipboardList, FilePlus2, GitBranch, Hand, Hourglass, ListChecks, OctagonX, RefreshCw, Undo2, Upload, XCircle,
} from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, fmtDateTime, Panel, QueryState, StatCard } from '../../components/kit';
import type { GisSummary } from '../../types';
import { JOB_KIND_LABELS, JobStatusBadge, SyncIndicator } from './common';

export function GisDashboard() {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const summary = useQuery({ queryKey: ['gis', 'summary'], queryFn: () => api<GisSummary>('/gis/summary'), refetchInterval: 30_000 });
  const counties = (session?.grants ?? []).filter((g) => g.role === 'gis_officer' || g.role === 'supervisor').map((g) => g.county?.name ?? 'All counties');

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>GIS Officer Dashboard</h1>
          <p className="muted">
            Welcome, {session?.user?.displayName}. Scope: <strong>{[...new Set(counties)].join(', ') || '…'}</strong>
          </p>
          <p className="muted small">
            You prepare spatial data in staging. Supervisors review it and the county Land Registrar decides and publishes; nothing here changes the register.
          </p>
        </div>
        <div className="page-actions">
          <SyncIndicator />
          {can('case.import_geometry') && <Link className="button" to="/gis/import"><Upload size={16} /> Import data</Link>}
          <button className="secondary" onClick={() => void summary.refetch()} disabled={summary.isFetching}>
            <RefreshCw size={16} className={summary.isFetching ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <QueryState query={summary} skeletonLines={4}>
        {(s) => {
          const k = s.kpis;
          return (
            <>
              <div className="stat-grid stat-grid-5">
                <StatCard label="My open tasks" value={k.my_open_tasks} icon={<ListChecks size={18} />} description="Assigned to you and not completed" onClick={() => navigate('/gis/tasks')} />
                <StatCard label="My overdue tasks" value={k.my_overdue_tasks} icon={<AlarmClock size={18} />} tone={k.my_overdue_tasks ? 'danger' : 'ok'} description="Past their operational due date" onClick={() => navigate('/gis/tasks')} />
                <StatCard label="Tasks you can claim" value={k.claimable_tasks} icon={<Hand size={18} />} description="Unassigned GIS tasks in your counties" onClick={() => navigate('/gis/tasks')} />
                <StatCard label="Cases in preparation" value={k.cases_in_preparation} icon={<FilePlus2 size={18} />} description="Spatial drafts not yet submitted" onClick={() => navigate('/gis/versions')} />
                <StatCard label="Returned for correction" value={k.returned_cases} icon={<Undo2 size={18} />} tone={k.returned_cases ? 'warn' : undefined} description="By validation, a supervisor or a registrar" onClick={() => navigate('/gis/returned')} />
                <StatCard label="Cases with blocking errors" value={k.cases_with_blocking_errors} icon={<OctagonX size={18} />} tone={k.cases_with_blocking_errors ? 'danger' : 'ok'} description="Latest validation found errors that block submission" onClick={() => navigate('/gis/validation?severity=error')} />
                <StatCard label="Open spatial conflicts" value={k.open_conflicts} icon={<AlertOctagon size={18} />} tone={k.open_conflicts ? 'warn' : 'ok'} description="Technical signals awaiting investigation" onClick={() => navigate('/gis/conflicts')} />
                <StatCard label="Awaiting supervisor review" value={k.awaiting_review} icon={<Hourglass size={18} />} description="Submitted spatial cases under review" onClick={() => navigate('/gis/submissions?status=awaiting_supervisor')} />
                <StatCard label="Accepted (30 days)" value={k.accepted_30d} icon={<CheckCircle2 size={18} />} tone="ok" description="Quality reviews that accepted GIS work" onClick={() => navigate('/gis/submissions?status=accepted_by_supervisor')} />
                <StatCard label="Jobs queued or running" value={k.jobs_active} icon={<ClipboardList size={18} />} description="Imports and ArcMap syncs in progress" onClick={() => navigate('/gis/jobs?status=running')} />
                <StatCard label="Failed jobs (7 days)" value={k.jobs_failed_7d} icon={<XCircle size={18} />} tone={k.jobs_failed_7d ? 'warn' : 'ok'} description="Nothing was staged; open one for the reason and retry" onClick={() => navigate('/gis/jobs?status=failed')} />
                <StatCard label="Versions created (7 days)" value={k.versions_7d} icon={<GitBranch size={18} />} description="New working versions from imports, syncs and corrections" onClick={() => navigate('/gis/versions')} />
              </div>

              <div className="split-2">
                <Panel title="My tasks" actions={<Link to="/gis/tasks">All tasks</Link>}>
                  {s.myTasks.length === 0 ? <EmptyState title="No open tasks" /> : (
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Task</th><th>Case</th><th>Status</th><th>Due</th></tr></thead>
                      <tbody>{s.myTasks.map((t) => (
                        <tr key={t.id}><td>{t.task_no}: {t.title}</td><td>{t.case_no ?? '—'}</td><td><Badge value={t.status} /></td><td>{t.due_date?.slice(0, 10) ?? '—'}</td></tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </Panel>
                <Panel title="Recent processing jobs" actions={<Link to="/gis/jobs">All jobs</Link>}>
                  {s.recentJobs.length === 0 ? <EmptyState title="No jobs yet">Import a file or sync from ArcMap to start.</EmptyState> : (
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Job</th><th>Kind</th><th>Case</th><th>Status</th><th>When</th></tr></thead>
                      <tbody>{s.recentJobs.map((j) => (
                        <tr key={j.id} className="row-click" tabIndex={0} onClick={() => navigate(`/gis/jobs?job=${j.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/gis/jobs?job=${j.id}`); }}>
                          <td>{j.job_no}</td><td>{JOB_KIND_LABELS[j.kind] ?? j.kind}</td><td>{j.case_no}</td><td><JobStatusBadge status={j.status} /></td><td>{fmtDateTime(j.created_at)}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                  <p className="muted small">
                    Last ArcMap sync: {s.lastArcmapSync ? <>{s.lastArcmapSync.job_no}, <JobStatusBadge status={s.lastArcmapSync.status} /> {fmtDateTime(s.lastArcmapSync.finished_at ?? s.lastArcmapSync.created_at)}</> : 'none yet'}
                  </p>
                </Panel>
              </div>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
