import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileUp } from 'lucide-react';
import { api, ApiError, CASE_TYPE_LABELS } from '../../api';
import { Badge, ErrorBanner, Panel, QueryState } from '../../components/kit';
import { WorkspaceMap } from '../../components/WorkspaceMap';
import type { GisCase, ImportOptions, ImportPreview, ImportResult, UploadInspection } from '../../types';
import { CasePicker, downloadFile, fmtBytes, JobStatusBadge } from './common';

/**
 * Data Import Center: eight steps from file to staged version.
 *   1 upload & inspect  2 layer  3 target case  4 field mapping  5 coordinate system  6 preview  7 confirm  8 result
 * The CRS is never assigned silently: an unknown CRS needs an explicit declaration AND a documented reason,
 * and a declaration that contradicts the file's metadata is refused by the server.
 */
const STEPS = ['Upload & inspect', 'Layer', 'Target case', 'Field mapping', 'Coordinate system', 'Preview', 'Confirm', 'Result'];

export function ImportWizard() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['gis', 'import-options'], queryFn: () => api<ImportOptions>('/gis/imports/options'), staleTime: 600_000 });
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<UploadInspection | null>(null);
  const [layer, setLayer] = useState('');
  const [caseId, setCaseId] = useState(params.get('case') ?? '');
  const [targetCase, setTargetCase] = useState<GisCase | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [wktColumn, setWktColumn] = useState('');
  const [declared, setDeclared] = useState('');
  const [reason, setReason] = useState('');
  const [crsConfirmed, setCrsConfirmed] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = inspection?.layers.find((l) => l.name === layer) ?? inspection?.layers[0];
  const detected = info?.crs.epsg ?? null;
  const isPackage = inspection?.format === 'arcmap_package';
  const required = (targetCase && options.data?.requiredFields[targetCase.case_type]) ?? [];

  useEffect(() => {
    if (inspection) {
      const first = inspection.layers[0]?.name ?? '';
      setLayer(first);
      setMapping(inspection.suggestedMapping[first] ?? {});
      setWktColumn(inspection.layers[0]?.wktColumn ?? '');
    }
  }, [inspection]);

  const body = useMemo(() => ({
    caseId, uploadKey: inspection?.uploadKey, layer: layer || null,
    declaredCrs: detected ?? (declared ? Number(declared) : null),
    crsExceptionReason: detected ? null : reason || null,
    // A package carries its own mapping (shapefile names are 10 characters); otherwise send the officer's.
    fieldMapping: isPackage ? undefined : Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
    purpose: purpose || null, wktColumn: wktColumn || null,
  }), [caseId, inspection, layer, detected, declared, reason, isPackage, mapping, purpose, wktColumn]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); } finally { setBusy(false); }
  };

  const upload = () => run(async () => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setInspection(await api<UploadInspection>('/gis/uploads', { form }));
    setStep(1);
  });
  const doPreview = () => run(async () => { setPreview(await api<ImportPreview>('/gis/imports/preview', { body })); setStep(5); });
  const confirm = () => run(async () => {
    const r = await api<ImportResult>('/gis/imports', { body: { ...body, confirm: true, wait: true } });
    setResult(r);
    setStep(7);
    void qc.invalidateQueries({ queryKey: ['gis'] });
  });

  const crsOk = detected !== null ? crsConfirmed : !!declared && reason.trim().length >= 10 && crsConfirmed;
  const canNext = [
    !!inspection, !!info, !!caseId, true, crsOk, !!preview && preview.accepted > 0 && preview.withinLimits, true, false,
  ][step];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Data Import Center</h1><p className="muted small">Imports create a new working version of a case in staging. Nothing is published, and geometry is never repaired or reprojected beyond the accepted transformation to WGS 84 for storage.</p></div>
      </div>
      <ol className="stepper" aria-label="Import steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i + 1}</span>{s}</li>)}
      </ol>
      <ErrorBanner error={error} />

      {step === 0 && (
        <Panel title="1. Upload and inspect">
          <QueryState query={options}>
            {(o) => (
              <>
                <p>Supported formats:</p>
                <ul className="small">{o.formats.filter((f) => f.supported).map((f) => <li key={f.format}>{f.label}</li>)}</ul>
                <details className="small"><summary>Formats that cannot be imported directly</summary>
                  <ul>{o.formats.filter((f) => !f.supported).map((f) => <li key={f.format}><strong>{f.format}</strong>: {f.reason}</li>)}</ul>
                </details>
                <p className="muted small">Files are treated as untrusted: archives are checked for unsafe names and contents, nothing in them is executed, and the upload is deleted after {24} hours. Up to {fmtBytes(o.limits.maxUploadBytes)}, {o.limits.maxFeatures} features.</p>
                <label>File <input type="file" accept=".zip,.geojson,.json,.csv,.gpkg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
                <button disabled={!file || busy} onClick={() => void upload()}><FileUp size={16} /> {busy ? 'Inspecting…' : 'Upload and inspect'}</button>
              </>
            )}
          </QueryState>
        </Panel>
      )}

      {step === 1 && inspection && (
        <Panel title="2. Layer">
          <p>{inspection.file} · {fmtBytes(inspection.size)} · <Badge value={inspection.format} /> · sha256 <code>{inspection.sha256.slice(0, 16)}…</code></p>
          {inspection.warnings.map((w) => <div key={w} className="alert"><AlertTriangle size={16} /> {w}</div>)}
          {isPackage && <div className="alert">ArcMap package from adapter {String(inspection.manifest?.adapter_version ?? '?')}, export <code>{String(inspection.manifest?.export_id ?? '')}</code>, prepared for {String(inspection.manifest?.case_no ?? '?')}.</div>}
          <label>Layer
            <select value={layer} onChange={(e) => { setLayer(e.target.value); setMapping(inspection.suggestedMapping[e.target.value] ?? {}); }}>
              {inspection.layers.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.featureCount} features, {l.geometryTypes.join(', ')})</option>)}
            </select>
          </label>
          {info && (
            <table className="table small">
              <thead><tr><th>Field</th><th>Type</th><th>Sample values</th></tr></thead>
              <tbody>{info.fields.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.type}</td><td>{info.sample.slice(0, 3).map((s) => String(s[f.name] ?? '')).join(' · ')}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      )}

      {step === 2 && (
        <Panel title="3. Target case">
          <p className="muted small">The data becomes a new working version of this case. Only drafts and returned cases in your counties can take imported geometry.</p>
          <CasePicker value={caseId} onChange={(id, c) => { setCaseId(id); setTargetCase(c); }} editableOnly label="Case" />
          {targetCase && <p className="small">{CASE_TYPE_LABELS[targetCase.case_type]} in {targetCase.county_code}; {targetCase.version_no ? `current version ${targetCase.version_no} (${targetCase.feature_count} feature(s)) will be superseded, not deleted` : 'no geometry yet'}.</p>}
          {isPackage && !!inspection?.manifest?.case_no && targetCase && inspection.manifest.case_no !== targetCase.case_no && (
            <div className="alert">The package was exported for {String(inspection.manifest.case_no)}; the server will refuse it for {targetCase.case_no}.</div>
          )}
          <label>Purpose / change note (optional) <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={500} placeholder="e.g. Boundary re-surveyed after return" /></label>
        </Panel>
      )}

      {step === 3 && info && options.data && (
        <Panel title="4. Field mapping">
          {isPackage ? <p>The package names its own field mapping (<code>{JSON.stringify(inspection?.manifest?.field_map ?? {})}</code>). Source fields that are not mapped are kept under their own names.</p> : (
            <>
              <p className="muted small">Choose which source field holds each LAIS attribute. Unmapped source fields are kept unchanged. {required.length > 0 && <>Required for this case type: <strong>{required.join(', ')}</strong>.</>}</p>
              {inspection?.format === 'csv_wkt' && (
                <label>Geometry column (WKT)
                  <select value={wktColumn} onChange={(e) => setWktColumn(e.target.value)}>
                    <option value="">Choose</option>{info.fields.map((f) => <option key={f.name}>{f.name}</option>)}
                  </select>
                </label>
              )}
              <table className="table">
                <thead><tr><th>LAIS attribute</th><th>Source field</th></tr></thead>
                <tbody>{options.data.targetFields.map((t) => (
                  <tr key={t.key}>
                    <td>{t.label}{required.includes(t.key) && <> <Badge value="warning" label="required" /></>}</td>
                    <td><select aria-label={`Source for ${t.key}`} value={mapping[t.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [t.key]: e.target.value })}>
                      <option value="">Not mapped</option>{info.fields.map((f) => <option key={f.name}>{f.name}</option>)}
                    </select></td>
                  </tr>
                ))}</tbody>
              </table>
            </>
          )}
        </Panel>
      )}

      {step === 4 && info && options.data && (
        <Panel title="5. Coordinate reference system">
          {detected !== null ? (
            <>
              <p>The file states <strong>EPSG:{detected}</strong> {info.crs.name && <>({info.crs.name})</>} in its {info.crs.source === 'prj' ? '.prj file' : 'crs member'}.</p>
              {!options.data.acceptedCrs.some((c) => c.epsg === detected) && <div className="alert">LAIS accepts only {options.data.acceptedCrs.map((c) => `EPSG:${c.epsg}`).join(' and ')}. Reproject the data in your GIS tool; LAIS does not transform other systems.</div>}
            </>
          ) : (
            <>
              <div className="alert"><AlertTriangle size={16} /> The file does not state its coordinate system. LAIS will not guess. Declare it only if you know it from the source (survey report, export settings), and record how you know.</div>
              <label>Declared coordinate system
                <select value={declared} onChange={(e) => setDeclared(e.target.value)}>
                  <option value="">Choose</option>{options.data.acceptedCrs.map((c) => <option key={c.epsg} value={c.epsg}>EPSG:{c.epsg} {c.name}</option>)}
                </select>
              </label>
              <label>How the coordinate system was established (recorded with the import)
                <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Survey report SR-17 page 2 states WGS 84 geographic coordinates" />
              </label>
              {inspection?.format === 'geojson' && <p className="muted small">GeoJSON without a crs member is WGS 84 by definition (RFC 7946), but check the coordinates really are longitude/latitude.</p>}
            </>
          )}
          <label className="check"><input type="checkbox" checked={crsConfirmed} onChange={(e) => setCrsConfirmed(e.target.checked)} /> I confirm the coordinate system above is correct for this data</label>
        </Panel>
      )}

      {step === 5 && preview && (
        <Panel title="6. Preview (nothing staged yet)">
          <div className="stat-grid">
            <div className="stat-card"><div className="stat-label">Records received</div><div className="stat-value">{preview.received}</div></div>
            <div className="stat-card"><div className="stat-label">Accepted</div><div className="stat-value">{preview.accepted}</div></div>
            <div className="stat-card"><div className="stat-label">Rejected</div><div className="stat-value">{preview.rejected}</div></div>
            <div className="stat-card"><div className="stat-label">Coordinate system</div><div className="stat-value small">EPSG:{preview.crs.declared}</div><div className="stat-desc">{preview.crs.detected ? 'from file metadata' : `declared: ${preview.crs.exceptionReason}`}</div></div>
          </div>
          {!preview.withinLimits && <div className="alert">{preview.limitLabel}: this import would fail. Choose another layer or case.</div>}
          {preview.extent && (
            <WorkspaceMap height={320} layers={{ working: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { note: 'Extent of the accepted records' },
              geometry: { type: 'Polygon', coordinates: [[[preview.extent[0], preview.extent[1]], [preview.extent[2], preview.extent[1]], [preview.extent[2], preview.extent[3]], [preview.extent[0], preview.extent[3]], [preview.extent[0], preview.extent[1]]]] } }] } }} />
          )}
          {preview.rejections.length > 0 && <><h3>Rejected records</h3><ul className="small">{preview.rejections.slice(0, 20).map((r) => <li key={r.record}>Record {r.record}: {r.reason}</li>)}</ul></>}
          {preview.warnings.length > 0 && <><h3>Warnings</h3><ul className="small">{preview.warnings.slice(0, 20).map((w) => <li key={w}>{w}</li>)}</ul></>}
          <h3>Mapped attributes (first records)</h3>
          <div className="table-wrap"><table className="table small">
            <thead><tr>{Object.keys(preview.sample[0] ?? {}).slice(0, 10).map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>{preview.sample.map((s, i) => <tr key={i}>{Object.keys(preview.sample[0] ?? {}).slice(0, 10).map((k) => <td key={k}>{String(s[k] ?? '')}</td>)}</tr>)}</tbody>
          </table></div>
        </Panel>
      )}

      {step === 6 && preview && (
        <Panel title="7. Confirm">
          <p>Stage <strong>{preview.accepted}</strong> record(s) from <strong>{preview.file}</strong> ({preview.layer}) as a new working version of <strong>{preview.caseNo}</strong>, in EPSG:{preview.crs.declared}.</p>
          <p className="muted small">The current version (if any) is superseded and kept. The import runs as a processing job; if anything fails, nothing is staged.</p>
          <button disabled={busy} onClick={() => void confirm()}>{busy ? 'Importing…' : 'Confirm import'}</button>
        </Panel>
      )}

      {step === 7 && result && (
        <Panel title="8. Result">
          {result.job ? (
            <>
              <p><strong>{result.job.job_no}</strong> <JobStatusBadge status={result.job.status} /> {result.duplicate && '(this export had already been processed)'}</p>
              {result.job.status.startsWith('completed') && <p><CheckCircle2 size={16} className="ok-text" /> Staged as version {result.job.version_no}: {result.job.records_accepted} accepted, {result.job.records_rejected} rejected.</p>}
              {result.job.error_summary && <div className="alert">{result.job.error_summary}</div>}
              {(result.job.warnings?.length ?? 0) > 0 && <ul className="small">{result.job.warnings.slice(0, 15).map((w) => <li key={w}>{w}</li>)}</ul>}
              <div className="chip-row">
                <button className="secondary" onClick={() => void downloadFile(`/gis/jobs/${result.jobId}/report.csv`, `${result.jobNo}-report.csv`)}>Download error report (CSV)</button>
                <Link className="button" to={`/gis/jobs?job=${result.jobId}`}>Open job</Link>
                {result.job.status.startsWith('completed') && <Link className="button" to={`/gis/validation?caseId=${caseId}`}>Validate</Link>}
                <button className="secondary" onClick={() => navigate(0)}>Import another file</button>
              </div>
            </>
          ) : <p>Job {result.jobNo} queued. <Link to={`/gis/jobs?job=${result.jobId}`}>Follow it on the jobs page.</Link></p>}
        </Panel>
      )}

      {step > 0 && step < 7 && (
        <div className="wizard-foot">
          <button className="secondary" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>
          {step < 4 && <button onClick={() => setStep(step + 1)} disabled={!canNext}>Next</button>}
          {step === 4 && <button onClick={() => void doPreview()} disabled={!canNext || busy}>{busy ? 'Checking…' : 'Preview'}</button>}
          {step === 5 && <button onClick={() => setStep(6)} disabled={!canNext}>Next</button>}
        </div>
      )}
    </div>
  );
}
