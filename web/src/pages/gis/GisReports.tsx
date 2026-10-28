import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { api } from '../../api';
import { EmptyState, ErrorBanner, fmtDateTime, Panel, QueryState } from '../../components/kit';
import type { ReportResult } from '../../types';
import { downloadFile, qs } from './common';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** GIS reports for the officer's counties, as a table on screen, CSV or PDF. */
export function GisReports() {
  const reports = useQuery({ queryKey: ['gis', 'reports'], queryFn: () => api<{ key: string; title: string; description: string }[]>('/gis/reports') });
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [error, setError] = useState<string | null>(null);
  const query = qs(`from=${from}`, `to=${to}`);
  const report = useQuery({ queryKey: ['gis', 'report', key, query], queryFn: () => api<ReportResult>(`/gis/reports/${key}${query}`), enabled: !!key });
  const download = (fmt: 'csv' | 'pdf') => downloadFile(`/gis/reports/${key}.${fmt}${query}`, `lais-gis-${key}.${fmt}`).catch((e) => setError((e as Error).message));
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>GIS Reports</h1><p className="muted small">Generated from the database for your counties; every report is recorded in the audit trail. Synthetic demonstration data.</p></div></div>
      <QueryState query={reports}>
        {(list) => (
          <Panel>
            <div className="filter-bar">
              <label className="inline">Report<select value={key} onChange={(e) => setKey(e.target.value)}><option value="">Choose</option>{list.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></label>
              <label className="inline">From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="inline">To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
              {key && <><button className="secondary" onClick={() => void download('csv')}><Download size={16} /> CSV</button><button className="secondary" onClick={() => void download('pdf')}><FileText size={16} /> PDF</button></>}
            </div>
            {key && <p className="muted small">{list.find((r) => r.key === key)?.description}</p>}
          </Panel>
        )}
      </QueryState>
      <ErrorBanner error={error} />
      {!key ? <EmptyState title="Choose a report" /> : (
        <QueryState query={report} isEmpty={(r) => r.rows.length === 0} empty={<EmptyState title="No records in this period" />}>
          {(r) => (
            <Panel title={r.title} actions={<span className="muted small">{r.scope} · generated {fmtDateTime(r.generatedAt)} · {r.rows.length} row(s)</span>}>
              <div className="table-wrap"><table className="table small">
                <thead><tr>{r.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>{r.rows.map((row, i) => <tr key={i}>{r.columns.map((c) => <td key={c.key}>{row[c.key] === null || row[c.key] === undefined ? '—' : String(row[c.key])}</td>)}</tr>)}</tbody>
              </table></div>
            </Panel>
          )}
        </QueryState>
      )}
    </div>
  );
}
