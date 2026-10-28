import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, EmptyState, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, useToast } from '../../components/kit';
import { VersionOverlayMap } from '../../components/WorkspaceMap';
import type { VersionCompare, VersionList } from '../../types';
import { CasePicker } from './common';

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * Working versions of a case. Every import, sync and correction is a numbered version; earlier versions
 * and submitted snapshots stay exactly as they were. Versions cannot be deleted.
 */
export function Versions() {
  const [params, setParams] = useSearchParams();
  const caseId = params.get('case') ?? '';
  const versions = useQuery({ queryKey: ['gis', 'versions', caseId], queryFn: () => api<VersionList>(`/gis/cases/${caseId}/versions`), enabled: !!caseId });
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    const v = versions.data?.versions;
    if (v && v.length) { setB(v[0].version_no); setA(v[1]?.version_no ?? v[0].version_no); }
  }, [versions.data]);
  const compare = useQuery({
    queryKey: ['gis', 'compare', caseId, a, b],
    queryFn: () => api<VersionCompare>(`/gis/cases/${caseId}/versions/compare?a=${a}&b=${b}`),
    enabled: !!caseId && a !== null && b !== null,
  });

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Versions and Comparison</h1><p className="muted small">Submitted versions are frozen. Corrections always create a new version from the current one.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <CasePicker value={caseId} onChange={(id) => setParams(id ? { case: id } : {})} label="Case" />
          {versions.data?.editable && <button onClick={() => setCorrecting(true)}>Correct attributes</button>}
          {caseId && <Link className="button secondary" to={`/gis/submit?case=${caseId}`}>Submit to supervisor</Link>}
        </div>
      </Panel>
      {!caseId ? <EmptyState title="Choose a case to see its versions" /> : (
        <QueryState query={versions} isEmpty={(d) => d.versions.length === 0} empty={<EmptyState title="No geometry imported yet"><Link to={`/gis/import?case=${caseId}`}>Import data</Link></EmptyState>}>
          {(d) => (
            <>
              <Panel title={`${d.caseNo}: ${d.versions.length} version(s)`}>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Version</th><th>Status</th><th>Source</th><th>Features</th><th>CRS</th><th>Change</th><th>By</th><th>When</th><th>Submissions</th></tr></thead>
                  <tbody>{d.versions.map((v) => (
                    <tr key={v.id}>
                      <td><strong>v{v.version_no}</strong>{v.parent_version && <div className="muted small">from v{v.parent_version}</div>}</td>
                      <td><Badge value={v.status === 'active' ? 'active' : v.status} /></td>
                      <td className="small">{v.source_kind}{v.job_no && <> · <Link to={`/gis/jobs?job=${v.job_id}`}>{v.job_no}</Link></>}<div className="muted">{v.source_filename}</div></td>
                      <td>{v.feature_count}{v.excluded_count > 0 && <div className="muted small">{v.excluded_count} excluded</div>}{v.invalid_count > 0 && <div className="warn-text small">{v.invalid_count} invalid</div>}</td>
                      <td>EPSG:{v.declared_srid}</td><td className="small">{v.change_reason ?? '—'}</td><td>{v.created_by}</td><td>{fmtDateTime(v.created_at)}</td>
                      <td className="small">{v.submissions?.map((s) => <div key={s.id}><Link to={`/gis/submissions?open=${s.id}`}>{s.submissionNo}</Link> <Badge value="superseded" label="frozen" /></div>) ?? '—'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </Panel>
              {d.versions.length > 0 && (
                <Panel title="Compare versions">
                  <div className="filter-bar">
                    <label className="inline">A <select value={a ?? ''} onChange={(e) => setA(Number(e.target.value))}>{d.versions.map((v) => <option key={v.id} value={v.version_no}>v{v.version_no}</option>)}</select></label>
                    <label className="inline">B <select value={b ?? ''} onChange={(e) => setB(Number(e.target.value))}>{d.versions.map((v) => <option key={v.id} value={v.version_no}>v{v.version_no}</option>)}</select></label>
                  </div>
                  <QueryState query={compare}>
                    {(c) => (
                      <>
                        <p className="small">{c.summary.modified} modified · {c.summary.added} added · {c.summary.removed} removed · {c.summary.unchanged} unchanged</p>
                        <VersionOverlayMap a={c.geometry.a} b={c.geometry.b} labelA={`Version ${c.a}`} labelB={`Version ${c.b}`} height={360} />
                        <div className="table-wrap"><table className="table small">
                          <thead><tr><th>Feature</th><th>Change</th><th>Geometry</th><th>Area (m²)</th><th>Excluded</th><th>Attributes changed</th></tr></thead>
                          <tbody>{c.changes.map((x) => (
                            <tr key={x.featureIndex} className={x.change !== 'unchanged' ? 'changed' : ''}>
                              <td>{x.featureIndex + 1}</td><td><Badge value={x.change === 'unchanged' ? 'closed' : x.change === 'modified' ? 'warning' : 'info_requested'} label={x.change} /></td>
                              <td>{x.geometryChanged ? `moved up to ${x.maxShiftM ?? '?'} m` : 'same'}</td>
                              <td>{show(x.areaFrom)} → {show(x.areaTo)}</td><td>{show(x.excludedFrom)} → {show(x.excludedTo)}</td>
                              <td>{x.attributes.length === 0 ? '—' : x.attributes.map((t) => <div key={t.field}><strong>{t.field}</strong>: {show(t.from)} → {show(t.to)}</div>)}</td>
                            </tr>
                          ))}</tbody>
                        </table></div>
                      </>
                    )}
                  </QueryState>
                </Panel>
              )}
              {correcting && <CorrectionDialog caseId={caseId} versionNo={d.versions[0].version_no} onClose={() => setCorrecting(false)} />}
            </>
          )}
        </QueryState>
      )}
    </div>
  );
}

function CorrectionDialog({ caseId, versionNo, onClose }: { caseId: string; versionNo: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const features = useQuery({
    queryKey: ['gis', 'features', caseId, versionNo],
    queryFn: () => api<{ features: { properties: { feature_index: number; properties: Record<string, unknown> } }[] }>(`/gis/cases/${caseId}/versions/${versionNo}/features`),
  });
  const [feature, setFeature] = useState(0);
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = features.data?.features.find((f) => f.properties.feature_index === feature)?.properties.properties ?? {};
  const save = async () => {
    setError(null);
    try {
      const r = await api<{ versionNo: number; jobNo: string }>(`/gis/cases/${caseId}/corrections`, { body: { reason, changes: [{ featureIndex: feature, set: { [field]: value === '' ? null : value } }] } });
      toast('success', `Version ${r.versionNo} created (${r.jobNo})`);
      void qc.invalidateQueries({ queryKey: ['gis'] });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title={`Correct attributes (creates version ${versionNo + 1})`} onClose={onClose}
      footer={<><button className="secondary" onClick={onClose}>Cancel</button><button disabled={!field || reason.trim().length < 10} onClick={() => void save()}>Create new version</button></>}>
      <ErrorBanner error={error} />
      <p className="muted small">Geometry is copied unchanged: correct geometry in the GIS tool and import or sync it again. Ownership is not edited here.</p>
      <label>Feature <select value={feature} onChange={(e) => setFeature(Number(e.target.value))}>{features.data?.features.map((f) => <option key={f.properties.feature_index} value={f.properties.feature_index}>Feature {f.properties.feature_index + 1}</option>)}</select></label>
      <label>Attribute <input list="attr-names" value={field} onChange={(e) => { setField(e.target.value); setValue(show(current[e.target.value]) === '—' ? '' : String(current[e.target.value])); }} pattern="[A-Za-z_]\w{0,59}" placeholder="e.g. land_use" />
        <datalist id="attr-names">{Object.keys(current).map((k) => <option key={k} value={k} />)}</datalist>
      </label>
      <label>New value <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} /></label>
      <label>Reason for the correction (10+ characters) <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Modal>
  );
}
