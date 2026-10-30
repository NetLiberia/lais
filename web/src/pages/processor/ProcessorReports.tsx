import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, FileText } from 'lucide-react';
import { api, downloadFile } from '../../api';
import { EmptyState, ErrorBanner, fmtDateTime, fmtDay, Panel, QueryState } from '../../components/kit';
import { ChartFrame } from '../../components/charts';
import type { ApplicationCategory, ProcessorAnalytics, ReportResult } from '../../types';
import { STAGE_LABELS, human, qs } from './common';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Reports and analytics for the processor's counties. Charts and reports come from the same filtered data. */
export function ProcessorReportsPage() {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [category, setCategory] = useState('');
  const [stage, setStage] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const query = qs(`from=${from}`, `to=${to}`, category && `category=${category}`, stage && `stage=${stage}`);
  const categories = useQuery({ queryKey: ['processor', 'categories'], queryFn: () => api<{ categories: ApplicationCategory[] }>('/applications/categories'), staleTime: 300_000 });
  const analytics = useQuery({ queryKey: ['processor', 'analytics', query], queryFn: () => api<ProcessorAnalytics>(`/processor/analytics${query}`) });
  const reports = useQuery({ queryKey: ['processor', 'reports'], queryFn: () => api<{ key: string; title: string; description: string }[]>('/processor/reports') });
  const report = useQuery({ queryKey: ['processor', 'report', key, query], queryFn: () => api<ReportResult>(`/processor/reports/${key}${query}`), enabled: !!key });
  const download = (fmt: 'csv' | 'pdf') => downloadFile(`/processor/reports/${key}.${fmt}${query}`, `lais-processing-${key}.${fmt}`).catch((e) => setError((e as Error).message));
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Reports and Analytics</h1><p className="muted small">Computed from the database for your counties. Reports exclude applicant contact details and identification, state their filters and generation time, and are recorded in the audit trail. Synthetic demonstration data.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label className="inline">From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="inline">To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="inline">Category <select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All</option>{categories.data?.categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
          <label className="inline">Stage <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All</option>{Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
      </Panel>
      <QueryState query={analytics} skeletonLines={8}>
        {(a) => (
          <div className="chart-grid">
            <ChartFrame title="Applications registered over time" description={`By submission date, ${fmtDay(a.range.from)} – ${fmtDay(a.range.to)}.`} empty={a.registeredOverTime.every((d) => d.registered === 0)}
              table={<table className="table"><tbody>{a.registeredOverTime.filter((d) => d.registered).map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td>{d.registered}</td></tr>)}</tbody></table>}>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={a.registeredOverTime.map((d) => ({ ...d, label: fmtDay(d.day) }))}><CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" /><XAxis dataKey="label" minTickGap={24} tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} /><Tooltip /><Line dataKey="registered" name="Registered" stroke="#2f7d5b" dot={false} strokeWidth={2} /></LineChart>
              </ResponsiveContainer>
            </ChartFrame>
            <SimpleBars title="Applications by category" rows={a.byCategory.map((r) => ({ name: r.label, value: r.count }))} />
            <SimpleBars title="Applications by workflow stage" rows={a.byStage.map((r) => ({ name: r.label, value: r.count }))} />
            <SimpleBars title="Missing documents by category" description="Required documents not yet received on open applications" rows={a.missingDocuments.map((r) => ({ name: r.label, value: r.count }))} />
            <SimpleBars title="Information requests by status" description="Created in the period" rows={a.infoRequests.map((r) => ({ name: human(r.status), value: r.count }))} />
            <ChartFrame title="Applications handed off to GIS" description="Handoffs per day" empty={a.handoffsOverTime.every((d) => d.handoffs === 0)}
              table={<table className="table"><tbody>{a.handoffsOverTime.filter((d) => d.handoffs).map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td>{d.handoffs}</td></tr>)}</tbody></table>}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={a.handoffsOverTime.map((d) => ({ ...d, label: fmtDay(d.day) }))}><CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" /><XAxis dataKey="label" minTickGap={24} tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="handoffs" name="Handoffs" fill="#3b6fb6" /></BarChart>
              </ResponsiveContainer>
            </ChartFrame>
            <SimpleBars title="Applications returned for correction" description="By source, in the period" rows={a.returnsBySource.map((r) => ({ name: r.source, value: r.count }))} />
            <Panel title="Processing time and registrar backlog">
              <div className="stat-grid">
                <div className="stat-card"><div className="stat-label">Average days, registration to submission</div><div className="stat-value">{a.processing.avg_days_to_submission ?? '—'}</div><div className="stat-desc">{a.processing.submitted} application(s) first submitted in the period{a.processing.avg_days_to_submission === null ? ': none, so no average' : ''}</div></div>
                <div className="stat-card"><div className="stat-label">Awaiting a Registrar decision</div><div className="stat-value">{a.processing.awaiting_registrar}</div></div>
              </div>
            </Panel>
          </div>
        )}
      </QueryState>
      <Panel title="Reports">
        <QueryState query={reports}>
          {(list) => (
            <div className="filter-bar">
              <label className="inline">Report <select value={key} onChange={(e) => setKey(e.target.value)}><option value="">Choose</option>{list.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></label>
              {key && <><button className="secondary" onClick={() => void download('csv')}><Download size={16} /> CSV</button><button className="secondary" onClick={() => void download('pdf')}><FileText size={16} /> PDF</button></>}
              {key && <span className="muted small">{list.find((r) => r.key === key)?.description}</span>}
            </div>
          )}
        </QueryState>
        <ErrorBanner error={error} />
        {key && (
          <QueryState query={report} isEmpty={(r) => r.rows.length === 0} empty={<EmptyState title="No records for these filters" />}>
            {(r) => (
              <>
                <p className="muted small">{r.scope} · generated {fmtDateTime(r.generatedAt)} by {r.generatedBy} · {r.rows.length} row(s) · {r.dataNotice}</p>
                <div className="table-wrap"><table className="table small">
                  <thead><tr>{r.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>{r.rows.map((row, i) => <tr key={i}>{r.columns.map((c) => <td key={c.key}>{row[c.key] === null || row[c.key] === undefined ? '—' : String(row[c.key])}</td>)}</tr>)}</tbody>
                </table></div>
              </>
            )}
          </QueryState>
        )}
      </Panel>
    </div>
  );
}

function SimpleBars({ title, description, rows }: { title: string; description?: string; rows: { name: string; value: number }[] }) {
  return (
    <ChartFrame title={title} description={description ?? ''} empty={rows.length === 0}
      table={<table className="table"><tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.value}</td></tr>)}</tbody></table>}>
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 30 }}><CartesianGrid strokeDasharray="3 3" className="chart-grid-lines" /><XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} /><YAxis type="category" dataKey="name" width={170} tick={{ fontSize: 11 }} /><Tooltip /><Bar dataKey="value" name="Count" fill="#2f7d5b" /></BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
