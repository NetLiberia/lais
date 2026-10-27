import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { api, downloadFile } from '../../api';
import { Badge, EmptyState, fmtDateTime, Panel, QueryState, usePatchParams, useToast } from '../../components/kit';
import type { ReportResult } from '../../types';
import { qs, useSupervision } from './common';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const cell = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDateTime(v) : String(v));

/** One generated report: metadata, column kinds, rows. Generating it is audited on the server. */
export function ReportView({ report }: { report: ReportResult }) {
  return (
    <div className="report">
      <div className="report-meta small">
        <div><strong>{report.title}</strong>: {report.description}</div>
        <div>Report <code>{report.reportId}</code> · generated {fmtDateTime(report.generatedAt)} by {report.generatedBy}</div>
        <div>Scope: {report.scope} · period {report.filters.from} to {report.filters.to}{report.filters.stage && ` · stage ${report.filters.stage}`}{report.filters.taskType && ` · task type ${report.filters.taskType}`}{report.filters.role && ` · role ${report.filters.role}`}</div>
        <div className="warn-text">{report.dataNotice}</div>
        <div className="muted">Column kinds: <Badge value="count" label="count" /> measured counts · <Badge value="derived" label="derived" /> calculated figures · plain values otherwise.</div>
      </div>
      {report.rows.length === 0 ? <EmptyState title="No rows for these filters" /> : (
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">{report.title}</caption>
            <thead><tr>{report.columns.map((c) => <th key={c.key}>{c.label}{c.kind !== 'value' && <span className={`kind kind-${c.kind}`}> {c.kind}</span>}</th>)}</tr></thead>
            <tbody>{report.rows.map((r, i) => <tr key={i}>{report.columns.map((c) => <td key={c.key} className={c.kind !== 'value' ? 'num' : 'small'}>{cell(r[c.key])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ReportsPage() {
  const [params] = useSearchParams();
  const patch = usePatchParams();
  const { scope, countyQs } = useSupervision();
  const toast = useToast();
  const list = useQuery({ queryKey: ['supervision', 'reports'], queryFn: () => api<{ key: string; title: string; description: string }[]>('/supervision/reports') });
  const key = params.get('report') ?? '';
  const filters = {
    from: params.get('from') ?? isoDay(new Date(Date.now() - 29 * 86_400_000)), to: params.get('to') ?? isoDay(new Date()),
    stage: params.get('stage') ?? '', taskType: params.get('taskType') ?? '', role: params.get('role') ?? '',
  };
  const query = qs(countyQs, `from=${filters.from}`, `to=${filters.to}`, filters.stage && `stage=${filters.stage}`, filters.taskType && `taskType=${filters.taskType}`, filters.role && `role=${filters.role}`);
  const [run, setRun] = useState(0);
  const report = useQuery({
    queryKey: ['supervision', 'report', key, query, run],
    queryFn: () => api<ReportResult>(`/supervision/reports/${key}${query}`),
    enabled: Boolean(key) && run > 0,
    staleTime: Infinity,
  });
  const download = () => void downloadFile(`/supervision/reports/${key}.csv${query}`, `lais-${key}.csv`).then(() => toast('success', 'CSV downloaded (recorded in the audit trail)')).catch((e) => toast('error', (e as Error).message));

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Reports and Analytics</h1><p className="muted">Operational reports limited to your scope. Every generation is recorded in the audit trail with its identifier and filters. Personal data of applicants and holders is never included.</p></div></div>
      <Panel>
        <div className="filter-bar no-print">
          <label className="grow">Report
            <select value={key} onChange={(e) => { patch({ report: e.target.value }); setRun(0); }}>
              <option value="">Choose a report…</option>
              {list.data?.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
            </select>
          </label>
          <label>From<input type="date" value={filters.from} max={filters.to} onChange={(e) => patch({ from: e.target.value })} /></label>
          <label>To<input type="date" value={filters.to} min={filters.from} onChange={(e) => patch({ to: e.target.value })} /></label>
          <label>Stage<select value={filters.stage} onChange={(e) => patch({ stage: e.target.value })}><option value="">All</option>{scope?.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label>Task type<select value={filters.taskType} onChange={(e) => patch({ taskType: e.target.value })}><option value="">All</option>{scope?.taskTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
          <label>Staff role<select value={filters.role} onChange={(e) => patch({ role: e.target.value })}><option value="">All</option><option value="gis_officer">GIS officers</option><option value="processor">Processors</option></select></label>
        </div>
        {key && <p className="muted small no-print">{list.data?.find((r) => r.key === key)?.description} Filters that do not apply to this report are ignored.</p>}
        <div className="row wrap no-print">
          <button disabled={!key} onClick={() => setRun((n) => n + 1)}>Generate</button>
          <button className="secondary" disabled={!key} onClick={download}><Download size={16} /> Download CSV</button>
          <button className="secondary" disabled={!report.data} onClick={() => window.print()}><Printer size={16} /> Print / save as PDF</button>
        </div>
      </Panel>
      {key && run > 0 && (
        <Panel>
          <QueryState query={report} skeletonLines={6}>{(r) => <ReportView report={r} />}</QueryState>
        </Panel>
      )}
    </div>
  );
}

/** Quality and compliance: the three compliance reports side by side, for the current scope and 30 days. */
export function QualityPage() {
  const { countyQs } = useSupervision();
  const query = qs(countyQs);
  const keys = ['repeated_quality_issues', 'supervisory_review_outcomes', 'workflow_exceptions', 'gis_validation_outcomes'];
  const reports = useQuery({
    queryKey: ['supervision', 'quality', query],
    queryFn: () => Promise.all(keys.map((k) => api<ReportResult>(`/supervision/reports/${k}${query}`))),
  });
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Quality and Compliance</h1><p className="muted">The last 30 days: data-quality issues that keep recurring, supervisory review outcomes, workflow exceptions and validation outcomes. Each view is generated as a recorded report.</p></div></div>
      <QueryState query={reports} skeletonLines={8}>
        {(rs) => <div className="stack">{rs.map((r) => <Panel key={r.key} title={r.title}><ReportView report={r} /></Panel>)}</div>}
      </QueryState>
    </div>
  );
}
