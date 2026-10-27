import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlarmClock, CheckCircle2, ClipboardCheck, FolderKanban, Gauge, Gavel, Hourglass, Layers, RefreshCw, ShieldAlert, Undo2,
} from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { fmtDateTime, fmtDay, Panel, QueryState, StatCard } from '../../components/kit';
import { ChartFrame, colorFor, label } from '../../components/charts';
import type { SupervisorCharts, SupervisorSummary } from '../../types';
import { qs, useSupervision } from './common';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const CONFLICT_LABELS: Record<string, string> = {
  new: 'Newly detected', investigating: 'Under investigation', awaiting_correction: 'Awaiting correction', escalated: 'Escalated',
  resolved: 'Resolved after authorized review', closed: 'Closed with documented disposition',
};

export function SupervisorDashboard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { scope, countyId, countyQs } = useSupervision();
  const [preset, setPreset] = useState<'7' | '30' | '90' | 'custom'>('30');
  const today = useMemo(() => new Date(), []);
  const [custom, setCustom] = useState({ from: isoDay(new Date(today.getTime() - 29 * 86_400_000)), to: isoDay(today) });
  const range = preset === 'custom' ? custom : { from: isoDay(new Date(today.getTime() - (Number(preset) - 1) * 86_400_000)), to: isoDay(today) };
  const query = qs(countyQs, `from=${range.from}`, `to=${range.to}`);

  const summary = useQuery({ queryKey: ['supervision', 'summary', query], queryFn: () => api<SupervisorSummary>(`/supervision/dashboard/summary${query}`) });
  const charts = useQuery({ queryKey: ['supervision', 'charts', query], queryFn: () => api<SupervisorCharts>(`/supervision/dashboard/charts${query}`) });
  const refreshing = summary.isFetching || charts.isFetching;
  const refresh = () => { void summary.refetch(); void charts.refetch(); };
  const scopeName = countyId ? scope?.counties.find((c) => c.id === countyId)?.name : scope?.national ? 'All counties' : scope?.counties.map((c) => c.name).join(', ');
  const go = (path: string, extra = '') => navigate(`${path}${qs(extra)}`);

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Supervisor Dashboard</h1>
          <p className="muted">
            Welcome, {session!.user!.displayName}. {today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Scope: <strong>{scopeName ?? '…'}</strong>
          </p>
          <p className="muted small">
            Operational oversight and quality control. Quality acceptance is not legal approval: decisions and publication stay with the county Land Registrar.
            {scope && <> Quality review is <strong>{scope.reviewMode}</strong> before a registrar decision.</>}
          </p>
        </div>
        <div className="page-actions">
          <span className="muted small" aria-live="polite">{summary.data ? `Updated ${fmtDateTime(summary.data.refreshedAt)}` : ''}</span>
          <button className="secondary" onClick={refresh} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      <Panel>
        <div className="filter-bar" role="group" aria-label="Dashboard period">
          <label className="inline">Period
            <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
              <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom range</option>
            </select>
          </label>
          {preset === 'custom' && (
            <>
              <label className="inline">From <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
              <label className="inline">To <input type="date" value={custom.to} min={custom.from} max={isoDay(today)} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
            </>
          )}
          <span className="muted small">Counts are live from the database. Period-based figures: processing time, pass rate, tasks completed and the charts over time.</span>
        </div>
      </Panel>

      <QueryState query={summary} skeletonLines={4}>
        {(s) => (
          <div className="stat-grid stat-grid-5">
            <StatCard label="Applications in scope" value={s.applications_total} icon={<FolderKanban size={18} />} description={`${s.applications_open} still open`} onClick={() => go('/supervisor/queue')} />
            <StatCard label="Awaiting processing" value={s.awaiting_processing} icon={<Hourglass size={18} />} description="Drafts being prepared by processors and GIS officers" onClick={() => go('/supervisor/queue', 'stage=preparation')} />
            <StatCard label="Awaiting quality review" value={s.awaiting_quality_review} icon={<Layers size={18} />} tone={s.awaiting_quality_review ? 'warn' : undefined} description="Submitted GIS work not yet accepted by a supervisor" onClick={() => go('/supervisor/gis-review', 'status=awaiting_review')} />
            <StatCard label="Returned for correction" value={s.returned_for_correction} icon={<Undo2 size={18} />} description="By validation, a supervisor or a registrar" onClick={() => go('/supervisor/queue', 'stage=returned')} />
            <StatCard label="Unresolved spatial conflicts" value={s.unresolved_conflicts} icon={<ShieldAlert size={18} />} tone={s.unresolved_conflicts ? 'warn' : 'ok'} description="Technical signals awaiting investigation or a registrar's review" onClick={() => go('/supervisor/conflicts')} />
            <StatCard label="Overdue tasks" value={s.overdue_tasks} icon={<AlarmClock size={18} />} tone={s.overdue_tasks ? 'danger' : 'ok'} description="Open tasks past their operational due date" onClick={() => go('/supervisor/overdue')} />
            <StatCard label="Awaiting Registrar decision" value={s.awaiting_registrar} icon={<Gavel size={18} />} description={s.reviewMode === 'required' ? 'Submitted cases that passed quality review' : 'All submitted cases (quality review is optional)'} onClick={() => go('/supervisor/queue', 'stage=registrar_decision')} />
            <StatCard label="Average processing time" value={s.avg_processing_days === null ? '—' : `${s.avg_processing_days} d`} icon={<Gauge size={18} />}
              description={s.decided_count ? `Submission to decision, ${s.decided_count} case(s) decided in the period` : 'No case was decided in the period'} onClick={() => go('/supervisor/overdue')} />
            <StatCard label="Data-quality pass rate" value={s.quality_pass_rate === null ? '—' : `${s.quality_pass_rate}%`} icon={<ClipboardCheck size={18} />}
              description={s.submissions_validated ? `${s.submissions_passed} of ${s.submissions_validated} submissions had no blocking error` : 'No submission was validated in the period'} onClick={() => go('/supervisor/quality')} />
            <StatCard label="Tasks completed" value={s.tasks_completed} icon={<CheckCircle2 size={18} />} description="Operational tasks completed in the period" onClick={() => go('/supervisor/tasks', 'status=completed')} />
          </div>
        )}
      </QueryState>

      <QueryState query={charts} skeletonLines={8}>
        {(c) => {
          const q = c.gisQuality;
          const quality = [
            { key: 'valid', name: 'Valid records', value: q.valid, color: '#2f7d5b' },
            { key: 'warnings', name: 'Records with warnings', value: q.warnings, color: '#c08a1e' },
            { key: 'invalid', name: 'Invalid records (blocking)', value: q.invalid, color: '#c4513f' },
          ];
          const findings = [
            { name: 'Duplicate identifiers', value: q.duplicate_identifiers },
            { name: 'Invalid geometries', value: q.invalid_geometries },
            { name: 'Potential overlaps', value: q.potential_overlaps },
            { name: q.boundariesVerified ? 'Outside county boundary' : 'Outside county boundary (indicative)', value: q.out_of_boundary },
          ];
          const durations = c.stageDurations.filter((d) => d.n > 0).map((d) => ({ ...d, name: label(d.status) }));
          return (
            <div className="chart-grid">
              <ChartFrame title="Applications by workflow stage" description="Current stage of every application in scope (mapping in the workflow guide). Select a bar to open the queue."
                empty={c.stages.every((s) => s.count === 0)}
                table={<table className="table"><thead><tr><th>Stage</th><th>Applications</th></tr></thead><tbody>{c.stages.map((s) => <tr key={s.key}><td>{s.label}</td><td>{s.count}</td></tr>)}</tbody></table>}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={c.stages} layout="vertical" margin={{ left: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => [`${v} application(s)`, 'Count']} />
                    <Bar dataKey="count" name="Applications" cursor="pointer" onClick={(d) => go('/supervisor/queue', `stage=${(d as unknown as { key: string }).key}`)}>
                      {c.stages.map((s, i) => <Cell key={s.key} fill={colorFor(s.key, i)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>

              <ChartFrame title="Work completed over time" description={`Tasks completed and workflow steps completed by staff per day, ${fmtDay(c.range.from)} – ${fmtDay(c.range.to)}.`}
                empty={c.workCompleted.every((d) => d.tasks_completed + d.stage_completions === 0)}
                table={<table className="table"><thead><tr><th>Day</th><th>Tasks</th><th>Workflow steps</th></tr></thead><tbody>{c.workCompleted.filter((d) => d.tasks_completed + d.stage_completions).map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td>{d.tasks_completed}</td><td>{d.stage_completions}</td></tr>)}</tbody></table>}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={c.workCompleted.map((d) => ({ ...d, label: fmtDay(d.day) }))} margin={{ left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="tasks_completed" name="Tasks completed" stroke="#2f7d5b" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="stage_completions" name="Workflow steps" stroke="#3b6fb6" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>

              <ChartFrame title="GIS quality results" description={`Current submissions of open cases: ${q.features} record(s). Errors block a submission; warnings need investigation. ${q.boundariesVerified ? '' : 'County boundaries are not verified, so boundary results are indicative.'}`}
                empty={q.features === 0} emptyText="No submitted GIS records in scope"
                table={<table className="table"><thead><tr><th>Measure</th><th>Count</th></tr></thead><tbody>{[...quality, ...findings].map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.value}</td></tr>)}</tbody></table>}>
                <div className="chart-pair">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={quality.filter((d) => d.value)} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} cursor="pointer" onClick={() => go('/supervisor/gis-review')}>
                        {quality.filter((d) => d.value).map((d) => <Cell key={d.key} fill={d.color} />)}
                      </Pie>
                      <Tooltip /><Legend />
                    </PieChart>
                  </ResponsiveContainer>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={findings} layout="vertical" margin={{ left: 30 }}>
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => [`${v} finding(s)`, 'Findings']} />
                      <Bar dataKey="value" name="Findings" fill="#c08a1e" cursor="pointer" onClick={() => go('/supervisor/conflicts')} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartFrame>

              <ChartFrame title="Processing time by stage" description="Average and median hours spent in each status, for stays that ended in the period (from the case history). Stays still in progress are excluded."
                empty={durations.length === 0} emptyText="No completed stays in this period"
                table={<table className="table"><thead><tr><th>Status</th><th>Stays</th><th>Average h</th><th>Median h</th></tr></thead><tbody>{durations.map((d) => <tr key={d.status}><td>{d.name}</td><td>{d.n}</td><td>{d.avgHours}</td><td>{d.medianHours}</td></tr>)}</tbody></table>}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={durations} margin={{ left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} label={{ value: 'hours', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                    <Tooltip formatter={(v, n) => [`${v} h`, n]} />
                    <Legend />
                    <Bar dataKey="avgHours" name="Average" fill="#3b6fb6" cursor="pointer" onClick={() => go('/supervisor/overdue')} />
                    <Bar dataKey="medianHours" name="Median" fill="#3a9aa3" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>

              <ChartFrame title="Staff workload" description="Tasks per GIS officer and processor. Raw counts: they do not reflect task complexity, leave or assignment volume, and are not a ranking."
                empty={c.staffWorkload.every((s) => s.assigned + s.active + s.overdue + s.returned + s.completed === 0)} emptyText="No tasks assigned in scope"
                table={<table className="table"><thead><tr><th>Officer</th><th>Assigned</th><th>Active</th><th>Overdue</th><th>Returned</th><th>Completed</th></tr></thead><tbody>{c.staffWorkload.map((s) => <tr key={s.id}><td>{s.username}</td><td>{s.assigned}</td><td>{s.active}</td><td>{s.overdue}</td><td>{s.returned}</td><td>{s.completed}</td></tr>)}</tbody></table>}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={c.staffWorkload} margin={{ left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                    <XAxis dataKey="username" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="assigned" name="Assigned" stackId="a" fill="#3b6fb6" cursor="pointer" onClick={(d) => go('/supervisor/workload', `staffId=${(d as unknown as { id: string }).id}`)} />
                    <Bar dataKey="active" name="Active" stackId="a" fill="#3a9aa3" />
                    <Bar dataKey="overdue" name="Overdue" stackId="a" fill="#c4513f" />
                    <Bar dataKey="returned" name="Returned" stackId="a" fill="#c08a1e" />
                    <Bar dataKey="completed" name="Completed (period)" fill="#2f7d5b" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>

              <ChartFrame title="Spatial conflict status" description="Conflict signals by review status. Resolved means a registrar reviewed it; the evidence and history are kept."
                empty={c.conflictStatus.length === 0} emptyText="No spatial conflicts detected in scope"
                table={<table className="table"><thead><tr><th>Status</th><th>Conflicts</th></tr></thead><tbody>{c.conflictStatus.map((s) => <tr key={s.review_status}><td>{CONFLICT_LABELS[s.review_status]}</td><td>{s.count}</td></tr>)}</tbody></table>}>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={c.conflictStatus.map((s) => ({ ...s, name: CONFLICT_LABELS[s.review_status] }))} dataKey="count" nameKey="name" outerRadius={90}
                      cursor="pointer" onClick={(d) => go('/supervisor/conflicts', `status=${(d as unknown as { review_status: string }).review_status}`)}>
                      {c.conflictStatus.map((s, i) => <Cell key={s.review_status} fill={colorFor(s.review_status, i)} />)}
                    </Pie>
                    <Tooltip /><Legend />
                  </PieChart>
                </ResponsiveContainer>
              </ChartFrame>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
