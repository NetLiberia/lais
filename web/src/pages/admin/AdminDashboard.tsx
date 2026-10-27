import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertOctagon, FileClock, FolderKanban, Layers, MailQuestion, Map, RefreshCw, Users } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, fmtDateTime, fmtDay, Panel, QueryState, StatCard } from '../../components/kit';
import { ChartFrame, colorFor, label } from '../../components/charts';

interface Summary {
  active_staff: number; pending_activations: number; applications_total: number; applications_open: number; applications_under_review: number;
  parcels_published: number; parcels_in_staging: number; conflicts_open: number; gis_jobs_attention: number; counties_enabled: number; counties_total: number;
}
interface Charts {
  range: { from: string; to: string };
  applicationsByStatus: { status: string; count: number }[];
  applicationsOverTime: { day: string; count: number }[];
  parcelsByCounty: { code: string; name: string; enabled: boolean; active: number; disputed: number; retired: number }[];
  gisJobOutcomes: { outcome: string; count: number }[];
  conflictsByStatus: { review_status: string; count: number }[];
  staffActivity: { day: string; sign_ins: number; failed_sign_ins: number }[];
}
interface ActivityEvent {
  chain_seq: string; at: string; actor_username: string | null; action: string; outcome: string; entity_type: string | null;
  entity_id: string | null; case_id: string | null; case_no: string | null; county_code: string | null;
}
interface County { id: number; code: string; name: string; enabled: boolean }

const ACTION_LABELS: Record<string, string> = {
  'admin.user_create': 'Staff account created', 'admin.role_grant': 'Role assigned', 'admin.role_revoke': 'Role revoked',
  'admin.user_status': 'Account status changed', 'admin.password_reset_initiated': 'Password reset started', 'auth.account_activated': 'Account activated',
  'auth.login': 'Failed sign-in', 'staging.import': 'GIS import', 'case.create': 'Case opened', 'case.submit': 'Case submitted',
  'case.approve': 'Case approved', 'case.reject': 'Case rejected', 'case.return': 'Case returned', 'case.publish': 'Case published',
  'case.withdraw': 'Case withdrawn', 'authz.denied': 'Access denied', 'county.update': 'County updated', 'county.boundary_import': 'County boundary imported',
  'county.boundary_verify': 'County boundary verified', 'settings.update': 'Setting changed', 'document_category.update': 'Document category changed',
  'document_category.create': 'Document category added', 'backup.run': 'Backup',
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function AdminDashboard() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [preset, setPreset] = useState<'7' | '30' | '90' | 'custom'>('30');
  const today = useMemo(() => new Date(), []);
  const [custom, setCustom] = useState({ from: isoDay(new Date(today.getTime() - 29 * 86_400_000)), to: isoDay(today) });
  const [countyId, setCountyId] = useState('');
  const range = preset === 'custom' ? custom : { from: isoDay(new Date(today.getTime() - (Number(preset) - 1) * 86_400_000)), to: isoDay(today) };

  const summary = useQuery({ queryKey: ['admin', 'summary'], queryFn: () => api<Summary>('/admin/dashboard/summary') });
  const charts = useQuery({
    queryKey: ['admin', 'charts', range.from, range.to, countyId],
    queryFn: () => api<Charts>(`/admin/dashboard/charts?from=${range.from}&to=${range.to}${countyId ? `&countyId=${countyId}` : ''}`),
  });
  const activity = useQuery({ queryKey: ['admin', 'activity'], queryFn: () => api<ActivityEvent[]>('/admin/dashboard/activity?limit=15'), refetchInterval: 60_000 });
  const counties = useQuery({ queryKey: ['admin', 'counties'], queryFn: () => api<County[]>('/admin/counties') });
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: () => api<{ overall: string; checks: { key: string; label: string; status: string; summary: string }[] }>('/admin/health') });

  const openEvent = (e: ActivityEvent) => {
    if (e.entity_type === 'user' && e.entity_id) navigate(`/admin/users?user=${e.entity_id}`);
    else if (e.action === 'staging.import' && e.entity_id) navigate(`/admin/gis-sync?job=${e.entity_id}`);
    else if (e.action.startsWith('county.')) navigate('/admin/counties');
    else navigate(`/admin/audit?seq=${e.chain_seq}`);
  };

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Welcome, {session!.user!.displayName}</h1>
          <p className="muted">{today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Platform administration. Legal decisions on land records remain with the county Land Registrar.</p>
        </div>
      </div>

      <QueryState query={summary} skeletonLines={3}>
        {(s) => (
          <div className="stat-grid">
            <StatCard label="Active staff accounts" value={s.active_staff} icon={<Users size={18} />} description="Staff who can sign in now (landowner accounts excluded)" onClick={() => navigate('/admin/users?status=active')} />
            <StatCard label="Pending activations" value={s.pending_activations} icon={<MailQuestion size={18} />} tone={s.pending_activations ? 'warn' : undefined} description="Invited accounts not yet activated by their owner" onClick={() => navigate('/admin/users?status=invited')} />
            <StatCard label="Land applications" value={s.applications_total} icon={<FolderKanban size={18} />} description="All cases recorded, of every type and status" onClick={() => navigate('/admin/applications')} />
            <StatCard label="Awaiting processing" value={s.applications_open} icon={<FileClock size={18} />} description={`Open cases; ${s.applications_under_review} awaiting a registrar's decision`} onClick={() => navigate('/admin/applications?status=open')} />
            <StatCard label="Published parcels" value={s.parcels_published} icon={<Map size={18} />} description="Parcels in the approved publication layer (not retired)" onClick={() => navigate('/admin/parcels')} />
            <StatCard label="Parcels in staging" value={s.parcels_in_staging} icon={<Layers size={18} />} description="Imported parcel geometries in open cases, awaiting validation or review" onClick={() => navigate('/admin/gis-sync?status=awaiting_validation')} />
            <StatCard label="Open spatial conflicts" value={s.conflicts_open} icon={<AlertOctagon size={18} />} tone={s.conflicts_open ? 'warn' : 'ok'} description="Conflict findings not yet acknowledged by a registrar" onClick={() => navigate('/admin/conflicts?status=open')} />
            <StatCard label="GIS jobs needing attention" value={s.gis_jobs_attention} icon={<RefreshCw size={18} />} tone={s.gis_jobs_attention ? 'danger' : 'ok'} description="Active imports that failed validation or have not been validated" onClick={() => navigate('/admin/gis-sync')} />
          </div>
        )}
      </QueryState>

      <Panel>
        <div className="filter-bar" role="group" aria-label="Chart filters">
          <label className="inline">Period
            <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
              <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom range</option>
            </select>
          </label>
          {preset === 'custom' && (
            <>
              <label className="inline">From <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
              <label className="inline">To <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
            </>
          )}
          <label className="inline">County
            <select value={countyId} onChange={(e) => setCountyId(e.target.value)}>
              <option value="">All counties</option>
              {counties.data?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (not enabled)'}</option>)}
            </select>
          </label>
          <span className="muted small">Figures are live database counts. No trends are shown without recorded history.</span>
        </div>
      </Panel>

      <QueryState query={charts} skeletonLines={8}>
        {(c) => (
          <div className="chart-grid">
            <ChartFrame
              title="Applications by status" description={`Cases opened ${fmtDay(c.range.from)} – ${fmtDay(c.range.to)}, by current status. Select a bar to list them.`}
              empty={c.applicationsByStatus.length === 0}
              table={<table className="table"><thead><tr><th>Status</th><th>Cases</th></tr></thead><tbody>{c.applicationsByStatus.map((r) => <tr key={r.status}><td>{label(r.status)}</td><td>{r.count}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={c.applicationsByStatus.map((r) => ({ ...r, name: label(r.status) }))} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} label={{ value: 'cases', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <Tooltip formatter={(v) => [`${v} case(s)`, 'Count']} />
                  <Bar dataKey="count" name="Cases" cursor="pointer" onClick={(d) => navigate(`/admin/applications?status=${(d as unknown as { status: string }).status}`)}>
                    {c.applicationsByStatus.map((r, i) => <Cell key={r.status} fill={colorFor(r.status, i)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Applications received over time" description="New cases per day in the selected period."
              empty={c.applicationsOverTime.every((d) => d.count === 0)}
              table={<table className="table"><thead><tr><th>Day</th><th>New cases</th></tr></thead><tbody>{c.applicationsOverTime.filter((d) => d.count).map((r) => <tr key={r.day}><td>{fmtDay(r.day)}</td><td>{r.count}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={c.applicationsOverTime.map((d) => ({ ...d, label: fmtDay(d.day) }))} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => [`${v} case(s)`, 'Received']} />
                  <Area type="monotone" dataKey="count" name="Cases received" stroke="#3b6fb6" fill="#3b6fb6" fillOpacity={0.25} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Parcel records by county" description="Published parcels by status in each configured county (counties with no parcels are omitted)."
              empty={c.parcelsByCounty.every((r) => r.active + r.disputed + r.retired === 0)}
              table={<table className="table"><thead><tr><th>County</th><th>Active</th><th>Disputed</th><th>Retired</th></tr></thead><tbody>{c.parcelsByCounty.map((r) => <tr key={r.code}><td>{r.name}</td><td>{r.active}</td><td>{r.disputed}</td><td>{r.retired}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={c.parcelsByCounty.filter((r) => r.active + r.disputed + r.retired > 0)} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                  <XAxis dataKey="code" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} label={{ value: 'parcels', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <Tooltip labelFormatter={(code) => c.parcelsByCounty.find((r) => r.code === code)?.name ?? String(code)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="active" stackId="p" name="Active" fill="#2f7d5b" />
                  <Bar dataKey="disputed" stackId="p" name="Disputed" fill="#c4513f" />
                  <Bar dataKey="retired" stackId="p" name="Retired" fill="#a3a9b1" />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="GIS import job outcomes" description="Staging imports started in the period, by latest outcome. Select a segment to list them."
              empty={c.gisJobOutcomes.length === 0}
              table={<table className="table"><thead><tr><th>Outcome</th><th>Jobs</th></tr></thead><tbody>{c.gisJobOutcomes.map((r) => <tr key={r.outcome}><td>{r.outcome}</td><td>{r.count}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={c.gisJobOutcomes} dataKey="count" nameKey="outcome" innerRadius={55} outerRadius={85} paddingAngle={2} cursor="pointer"
                    onClick={(d) => navigate(`/admin/gis-sync?status=${String((d as unknown as { outcome: string }).outcome).replace(/ /g, '_')}`)}>
                    {c.gisJobOutcomes.map((r, i) => <Cell key={r.outcome} fill={colorFor(r.outcome, i)} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [`${v} job(s)`, String(n)]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Spatial conflicts by review status" description="Conflict findings detected in the period. Open findings need a registrar's acknowledgement."
              empty={c.conflictsByStatus.length === 0}
              table={<table className="table"><thead><tr><th>Review status</th><th>Findings</th></tr></thead><tbody>{c.conflictsByStatus.map((r) => <tr key={r.review_status}><td>{r.review_status}</td><td>{r.count}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={c.conflictsByStatus} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                  <YAxis type="category" dataKey="review_status" tick={{ fontSize: 12 }} width={90} />
                  <Tooltip formatter={(v) => [`${v} finding(s)`, 'Count']} />
                  <Bar dataKey="count" name="Findings" cursor="pointer" onClick={(d) => navigate(`/admin/conflicts?status=${(d as unknown as { review_status: string }).review_status}`)}>
                    {c.conflictsByStatus.map((r, i) => <Cell key={r.review_status} fill={colorFor(r.review_status, i)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Staff sign-in activity" description="Successful and failed sign-ins per day, from the audit trail."
              empty={c.staffActivity.every((d) => d.sign_ins + d.failed_sign_ins === 0)}
              table={<table className="table"><thead><tr><th>Day</th><th>Sign-ins</th><th>Failed</th></tr></thead><tbody>{c.staffActivity.filter((d) => d.sign_ins + d.failed_sign_ins).map((r) => <tr key={r.day}><td>{fmtDay(r.day)}</td><td>{r.sign_ins}</td><td>{r.failed_sign_ins}</td></tr>)}</tbody></table>}
            >
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={c.staffActivity.map((d) => ({ ...d, label: fmtDay(d.day) }))} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="sign_ins" name="Sign-ins" stroke="#2f7d5b" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="failed_sign_ins" name="Failed sign-ins" stroke="#c4513f" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>
        )}
      </QueryState>

      <div className="grid-2">
        <Panel title="Recent activity" actions={<button className="link small" onClick={() => navigate('/admin/audit')}>Full audit log</button>}>
          <QueryState query={activity} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No activity recorded yet" />}>
            {(events) => (
              <ul className="activity-list">
                {events.map((e) => (
                  <li key={e.chain_seq}>
                    <button className="activity-item" onClick={() => openEvent(e)}>
                      <span className={`dot ${e.outcome !== 'success' || e.action === 'auth.login' ? 'dot-warn' : ''}`} aria-hidden />
                      <span className="activity-text">
                        <strong>{ACTION_LABELS[e.action] ?? e.action}</strong>
                        {e.outcome !== 'success' && <> <Badge value={e.outcome === 'denied' ? 'warning' : 'error'} label={e.outcome} /></>}
                        <span className="muted small">
                          {[e.actor_username && `by ${e.actor_username}`, e.case_no, e.county_code, e.entity_type && !e.case_no ? e.entity_type : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="muted tiny">{fmtDateTime(e.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Panel>
        <Panel title="System health" actions={<button className="link small" onClick={() => navigate('/admin/health')}>Details</button>}>
          <QueryState query={health}>
            {(h) => (
              <ul className="health-list">
                {h.checks.map((c) => (
                  <li key={c.key}><Badge value={c.status} /> <strong>{c.label}</strong> <span className="muted small">{c.summary}</span></li>
                ))}
              </ul>
            )}
          </QueryState>
        </Panel>
      </div>
    </div>
  );
}
