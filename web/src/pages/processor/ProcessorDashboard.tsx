import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock, CheckCircle2, ClipboardCheck, FileClock, FilePlus2, FileSearch, FileWarning, Gavel, Inbox, Layers, MessageSquareMore, RefreshCw, Undo2, UserCheck,
} from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { EmptyState, fmtDateTime, Panel, QueryState, StatCard } from '../../components/kit';
import type { ApplicationList, ProcessorSummary } from '../../types';
import { CompletenessBadge, StageBadge, qs } from './common';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The LAIS Processor Dashboard. Every figure comes from the server for the officer's counties. */
export function ProcessorDashboard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const today = useMemo(() => new Date(), []);
  const [preset, setPreset] = useState<'7' | '30' | '90' | 'custom'>('30');
  const [custom, setCustom] = useState({ from: isoDay(new Date(today.getTime() - 29 * 86_400_000)), to: isoDay(today) });
  const counties = (session?.grants ?? []).filter((g) => g.role === 'processor' || g.role === 'supervisor');
  const [countyId, setCountyId] = useState<number | null>(null);
  const range = preset === 'custom' ? custom : { from: isoDay(new Date(today.getTime() - (Number(preset) - 1) * 86_400_000)), to: isoDay(today) };
  const query = qs(countyId && `countyId=${countyId}`, `from=${range.from}`, `to=${range.to}`);
  const summary = useQuery({ queryKey: ['processor', 'summary', query], queryFn: () => api<ProcessorSummary>(`/processor/summary${query}`) });
  const mine = useQuery({ queryKey: ['processor', 'mine', countyId], queryFn: () => api<ApplicationList>(`/applications${qs('processor=me', 'pageSize=8', countyId && `countyId=${countyId}`)}`) });
  const go = (path: string) => navigate(path);
  const scope = countyId ? counties.find((g) => g.county?.id === countyId)?.county?.name : counties.map((g) => g.county?.name ?? 'All counties').join(', ');

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>LAIS Processor Dashboard</h1>
          <p className="muted">
            {today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Scope: <strong>{scope || '…'}</strong>
            {summary.data && <> · <strong>{summary.data.kpis.my_open}</strong> application(s) under your responsibility</>}
          </p>
          <p className="muted small">You register applications and check their documents for administrative completeness. That is not legal verification: GIS officers do the spatial work, supervisors check quality, and the Land Registrar decides.</p>
        </div>
        <div className="page-actions">
          <span className="muted small" aria-live="polite">{summary.data ? `Updated ${fmtDateTime(summary.data.refreshedAt)}` : ''}</span>
          <Link className="button" to="/processor/new"><FilePlus2 size={16} /> New application</Link>
          <button className="secondary" onClick={() => { void summary.refetch(); void mine.refetch(); }} disabled={summary.isFetching}>
            <RefreshCw size={16} className={summary.isFetching ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <Panel>
        <div className="filter-bar" role="group" aria-label="Dashboard filters">
          {counties.length > 1 && (
            <label className="inline">County
              <select value={countyId ?? ''} onChange={(e) => setCountyId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">All my counties</option>{counties.filter((g) => g.county).map((g) => <option key={g.county!.id} value={g.county!.id}>{g.county!.name}</option>)}
              </select>
            </label>
          )}
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
          <span className="muted small">The period applies to “New applications received” and “Completed”; the other figures are current counts.</span>
        </div>
      </Panel>

      <QueryState query={summary} skeletonLines={4}>
        {({ kpis: k }) => (
          <div className="stat-grid stat-grid-5">
            <StatCard label="Total applications registered" value={k.total_registered} icon={<Inbox size={18} />} description="All applications registered through intake in scope" onClick={() => go('/processor/applications')} />
            <StatCard label="New applications received" value={k.new_in_period} icon={<FilePlus2 size={18} />} description={`Submitted ${range.from} – ${range.to}`} onClick={() => go(`/processor/applications?from=${range.from}&to=${range.to}`)} />
            <StatCard label="Awaiting document review" value={k.awaiting_document_review} icon={<FileSearch size={18} />} tone={k.awaiting_document_review ? 'warn' : undefined} description="Open applications with documents not yet reviewed" onClick={() => go('/processor/verification')} />
            <StatCard label="Administratively complete" value={k.complete} icon={<ClipboardCheck size={18} />} tone="ok" description="All configured requirements met (not legal approval)" onClick={() => go('/processor/applications?completeness=complete')} />
            <StatCard label="Incomplete applications" value={k.incomplete} icon={<FileWarning size={18} />} tone={k.incomplete ? 'warn' : 'ok'} description="Required information or documents outstanding" onClick={() => go('/processor/incomplete')} />
            <StatCard label="Awaiting additional information" value={k.awaiting_information} icon={<MessageSquareMore size={18} />} description="Open information requests to applicants" onClick={() => go('/processor/info-requests?status=open')} />
            <StatCard label="Awaiting GIS processing" value={k.awaiting_gis} icon={<Layers size={18} />} description="Handed off; the GIS task has not started" onClick={() => go('/processor/gis-queue')} />
            <StatCard label="Being processed by GIS" value={k.gis_processing} icon={<FileClock size={18} />} description="A GIS officer is working on it" onClick={() => go('/processor/gis-queue')} />
            <StatCard label="Returned for correction" value={k.returned} icon={<Undo2 size={18} />} tone={k.returned ? 'warn' : undefined} description="By validation, a supervisor or a registrar" onClick={() => go('/processor/returned')} />
            <StatCard label="Awaiting Registrar decision" value={k.awaiting_registrar} icon={<Gavel size={18} />} description="Submitted for review, not yet decided" onClick={() => go('/processor/decisions')} />
            <StatCard label="Completed in period" value={k.completed_in_period} icon={<CheckCircle2 size={18} />} tone="ok" description="Approved, rejected or published in the period" onClick={() => go('/processor/decisions')} />
            <StatCard label="Overdue administrative tasks" value={k.overdue_tasks} icon={<AlarmClock size={18} />} tone={k.overdue_tasks ? 'danger' : 'ok'} description="Overdue information requests and processing tasks" onClick={() => go('/processor/info-requests?status=overdue')} />
          </div>
        )}
      </QueryState>

      <Panel title={<><UserCheck size={18} aria-hidden /> Under my responsibility</>} actions={<Link to="/processor/mine">All my applications</Link>}>
        <QueryState query={mine} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No applications assigned to you">Register one with “New application”.</EmptyState>}>
          {(d) => (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Application</th><th>Applicant</th><th>Category</th><th>Stage</th><th>Completeness</th><th>Open requests</th></tr></thead>
              <tbody>{d.items.map((a) => (
                <tr key={a.id} className="row-click" tabIndex={0} onClick={() => go(`/processor/applications/${a.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') go(`/processor/applications/${a.id}`); }}>
                  <td>{a.case_no}</td><td>{a.applicant_name} <span className="muted small">{a.applicant_no}</span></td><td>{a.category_label}</td>
                  <td><StageBadge stage={a.stage} /></td><td><CompletenessBadge value={a.completeness} /></td><td>{a.open_requests || '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
