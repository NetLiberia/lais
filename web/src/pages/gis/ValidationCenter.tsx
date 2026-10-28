import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Geometry } from 'geojson';
import { Download, Play } from 'lucide-react';
import { api } from '../../api';
import { Badge, EmptyState, fmtDateTime, Panel, QueryState, ReasonDialog, useToast } from '../../components/kit';
import { WorkspaceMap } from '../../components/WorkspaceMap';
import type { RuleSet, Severity, ValidationFindingRow, ValidationRule } from '../../types';
import { CasePicker, downloadFile, qs } from './common';

/** Validation center: the latest findings of every spatial case in scope, with filters, zoom, export and re-run. */
export function ValidationCenter() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const severity = params.get('severity') ?? '';
  const category = params.get('category') ?? '';
  const code = params.get('code') ?? '';
  const caseId = params.get('caseId') ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const query = qs(severity && `severity=${severity}`, category && `category=${category}`, code && `code=${code}`, caseId && `caseId=${caseId}`);
  const data = useQuery({ queryKey: ['gis', 'validation', query], queryFn: () => api<{ findings: ValidationFindingRow[]; rules: { code: string; label: string; category: string; severity: Severity }[] }>(`/gis/validation${query}`) });
  const [focus, setFocus] = useState<{ geometry: Geometry; token: number } | null>(null);
  const extents = useMemo(() => ({
    working: { type: 'FeatureCollection' as const, features: (data.data?.findings ?? []).filter((f) => f.extent).map((f) => ({ type: 'Feature' as const, geometry: f.extent as Geometry, properties: { case: f.case_no, rule: f.code, severity: f.severity, feature: f.feature_index === null ? '' : f.feature_index + 1 } })) },
  }), [data.data]);
  const rerun = useMutation({
    mutationFn: (id: string) => api<{ findings: unknown[] }>(`/cases/${id}/validate`, { method: 'POST' }),
    onSuccess: (r) => { toast('success', `Validation re-run: ${r.findings.length} finding(s)`); void qc.invalidateQueries({ queryKey: ['gis'] }); },
    onError: (e) => toast('error', (e as Error).message),
  });
  const categories = [...new Set((data.data?.rules ?? []).map((r) => r.category))];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Validation Center</h1><p className="muted small">Errors block submission and must be corrected in the data; warnings are signals to investigate. Rule severities are set by administrators and every run records the rule-set version it used.</p></div>
        <div className="page-actions">
          <Link className="button secondary" to="/gis/validation/rules">Rules and history</Link>
          <button className="secondary" onClick={() => void downloadFile(`/gis/validation.csv${query}`, 'validation-findings.csv')}><Download size={16} /> Export CSV</button>
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label className="inline">Severity<select value={severity} onChange={(e) => set('severity', e.target.value)}><option value="">All</option><option value="error">Errors</option><option value="warning">Warnings</option></select></label>
          <label className="inline">Category<select value={category} onChange={(e) => set('category', e.target.value)}><option value="">All</option>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="inline">Rule<select value={code} onChange={(e) => set('code', e.target.value)}><option value="">All</option>{data.data?.rules.map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}</select></label>
          <CasePicker value={caseId} onChange={(id) => set('caseId', id)} label="Case" />
          {caseId && <button onClick={() => rerun.mutate(caseId)} disabled={rerun.isPending}><Play size={16} /> Re-run validation</button>}
        </div>
      </Panel>
      <QueryState query={data} isEmpty={(d) => d.findings.length === 0} empty={<EmptyState title="No findings match">Validated cases without findings do not appear here.</EmptyState>}>
        {(d) => (
          <>
            <WorkspaceMap height={340} layers={extents} focus={focus} />
            <Panel title={`${d.findings.length} finding(s)`}>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Case</th><th>Severity</th><th>Rule</th><th>Feature</th><th>Message</th><th>How to fix</th><th>Run</th><th /></tr></thead>
                <tbody>{d.findings.map((f) => (
                  <tr key={f.id}>
                    <td><Link to={`/work/cases/${f.case_id}`}>{f.case_no}</Link><div className="muted small">{f.case_status}</div></td>
                    <td><Badge value={f.severity} /></td>
                    <td className="small"><strong>{f.code}</strong><div className="muted">{f.rule_label}</div></td>
                    <td>{f.feature_index === null ? '—' : f.feature_index + 1}</td>
                    <td className="small">{f.message}</td>
                    <td className="small muted">{f.suggestion}</td>
                    <td className="small">{fmtDateTime(f.run_at)}<div className="muted">rules v{f.rule_set_version ?? '?'}</div></td>
                    <td>{f.extent && <button className="secondary small-btn" onClick={() => setFocus({ geometry: f.extent!, token: Date.now() })}>Zoom</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}

/** Rules and their versioned history. Administrators may change the severity of configurable rules. */
export function ValidationRules() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['gis', 'rules'], queryFn: () => api<RuleSet>('/gis/validation/rules') });
  const [change, setChange] = useState<ValidationRule | null>(null);
  const save = async (reason: string) => {
    if (!change) return;
    const to = change.severity === 'error' ? 'warning' : 'error';
    const r = await api<{ version: number }>(`/gis/validation/rules/${change.code}`, { method: 'PATCH', body: { severity: to, reason } });
    toast('success', `${change.code} is now ${to === 'error' ? 'blocking' : 'a warning'} (rule set v${r.version})`);
    setChange(null);
    void qc.invalidateQueries({ queryKey: ['gis', 'rules'] });
  };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Validation Rules</h1><p className="muted small">Safety rules (invalid geometry, wrong county, CRS problems, identifier errors) are fixed. Configurable rules can be made blocking or advisory by an administrator, with a reason; every change is a new rule-set version.</p></div></div>
      <QueryState query={rules}>
        {(r) => (
          <>
            <Panel title={`Current rule set: version ${r.currentVersion ?? '—'}`}>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Rule</th><th>Category</th><th>Severity</th><th>Default</th><th>Configurable</th><th>Guidance</th><th /></tr></thead>
                <tbody>{r.rules.map((x) => (
                  <tr key={x.code}>
                    <td><strong>{x.code}</strong><div className="small">{x.label}</div></td><td>{x.category}</td>
                    <td><Badge value={x.severity} label={x.severity === 'error' ? 'blocking' : 'warning'} /></td><td className="small">{x.default_severity}</td>
                    <td>{x.configurable ? 'yes' : 'fixed'}</td><td className="small muted">{x.suggestion}</td>
                    <td>{r.canConfigure && x.configurable && <button className="secondary small-btn" onClick={() => setChange(x)}>Make {x.severity === 'error' ? 'warning' : 'blocking'}</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Panel>
            <Panel title="Change history">
              <table className="table small">
                <thead><tr><th>Version</th><th>When</th><th>By</th><th>Rule</th><th>Change</th><th>Reason</th></tr></thead>
                <tbody>{r.history.map((h) => (
                  <tr key={h.version}><td>{h.version}</td><td>{fmtDateTime(h.changed_at)}</td><td>{h.changed_by_username ?? 'system'}</td><td>{h.rule_code ?? '—'}</td>
                    <td>{h.rule_code ? `${h.from_value} → ${h.to_value}` : '—'}</td><td>{h.reason}</td></tr>
                ))}</tbody>
              </table>
            </Panel>
          </>
        )}
      </QueryState>
      <ReasonDialog open={!!change} title={change ? `Change ${change.code}` : ''} confirmLabel="Save new rule-set version"
        description={change ? `Make ${change.code} ${change.severity === 'error' ? 'a warning (advisory)' : 'blocking (submission refused while it is found)'}. Runs after this change record the new version.` : ''}
        onClose={() => setChange(null)} onConfirm={save} />
    </div>
  );
}
