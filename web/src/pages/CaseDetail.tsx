import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, CASE_TYPE_LABELS, fmtDate, human } from '../api';
import { ParcelMap, type Overlay } from '../components/ParcelMap';
import { ErrorBox, Section, StatusPill, useAction, useLoad } from '../components/ui';

const RRR_TYPES = ['ownership', 'co_ownership', 'customary_tenure', 'lease', 'mortgage', 'easement'];
const DOC_TYPES = ['survey_plan', 'deed', 'customary_certificate', 'id_document', 'power_of_attorney', 'other'];

export function CaseDetail() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api(`/cases/${id}`), [id]);
  const action = useAction();

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <p className="pad muted">Loading…</p>;

  const cs = data.case;
  const can = (a: string) => data.allowedActions.includes(a);
  const act = async (fn: () => Promise<unknown>) => {
    await action.run(fn);
    await reload();
  };

  const features: any[] = data.staged?.features ?? [];
  const many = features.length > 1;
  const overlays: Overlay[] = [];
  for (const s of data.sources) {
    overlays.push({ id: `src-${s.upi}`, data: s.geometry, color: '#1f5fbf', dashed: true, label: `Being replaced: ${s.upi}` });
  }
  for (const f of features) {
    overlays.push({
      id: `staged-${f.index}`,
      data: f.geometry,
      color: f.structural_ok ? '#e07b00' : '#b00020',
      dashed: !f.structural_ok,
      label: `${many ? `New parcel ${f.index + 1}` : 'Proposed geometry'}${f.structural_ok ? ' (staging)' : ' (invalid)'}`,
    });
  }
  if (data.parcel?.geometry && (cs.case_type === 'transfer' || cs.case_type === 'correction')) {
    overlays.push({ id: 'parcel', data: data.parcel.geometry, color: '#1f5fbf', dashed: cs.case_type === 'correction', label: `Published ${data.parcel.upi}` });
  }
  const resultLinks = data.children.length > 0 && (
    <> · created {data.children.map((c: any, i: number) => <span key={c.upi}>{i > 0 && ', '}<Link to={`/work/parcels/${c.upi}`}>{c.upi}</Link></span>)}</>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{cs.case_no} <StatusPill status={cs.status} /></h1>
          <p className="muted">
            {CASE_TYPE_LABELS[cs.case_type]} · {cs.county.name}
            {data.parcel && cs.case_type !== 'consolidation' && <> · parcel <Link to={`/work/parcels/${data.parcel.upi}`}>{data.parcel.upi}</Link></>}
            {data.sources.length > 0 && <> · replaces {data.sources.map((s: any, i: number) => <span key={s.upi}>{i > 0 && ', '}<Link to={`/work/parcels/${s.upi}`}>{s.upi}</Link></span>)}</>}
            {resultLinks}
          </p>
        </div>
      </div>
      {data.separationNotice && <div className="alert info">{data.separationNotice}</div>}
      <ErrorBox error={action.error} />

      <div className="grid-2">
        <div className="stack">
          <Attributes data={data} editable={can('case.edit_attributes')} onSave={(body) => act(() => api(`/cases/${id}`, { method: 'PATCH', body }))} />
          {cs.case_type === 'transfer' && data.parcel && <CurrentRights parcel={data.parcel} note="On publication, ownership-type interests end and the incoming interests below are registered. Encumbrances carry forward." />}
          {data.sources.map((s: any) => (
            <CurrentRights key={s.upi} parcel={s} note="When this case is published the parcel is retired: all its current interests end, including encumbrances. Record on the new parcel(s) every interest that continues." />
          ))}
          {cs.case_type === 'correction'
            ? <Section title="Rights"><p className="small muted">A correction never changes who holds an interest. Use a transfer case for that.</p></Section>
            : <Rights data={data} editable={can('case.edit_rights')} act={act} caseId={id!} featureCount={features.length} />}
          <Documents data={data} canUpload={can('case.upload_document')} act={act} caseId={id!} />
        </div>
        <div className="stack">
          <Section title="Geometry">
            {cs.case_type === 'transfer'
              ? <p className="small muted">A transfer changes rights only; the published boundary is unchanged.</p>
              : data.staged
                ? <div className="small">
                    <p>Imported {data.staged.source_filename} (declared EPSG:{data.staged.declared_srid}) by {data.staged.uploaded_by}, {fmtDate(data.staged.created_at)}.</p>
                    <ul className="plain">
                      {features.map((f) => (
                        <li key={f.index}>
                          {many && <strong>New parcel {f.index + 1}: </strong>}
                          {f.area_m2 && <>calculated area {Number(f.area_m2).toLocaleString()} m²</>}
                          {!f.structural_ok && <strong className="danger"> invalid: {f.structural_message}</strong>}
                        </li>
                      ))}
                    </ul>
                  </div>
                : <p className="small muted">
                    {cs.case_type === 'correction' ? 'The boundary stays as published unless you import a corrected one.'
                      : cs.case_type === 'subdivision' ? 'Import one GeoJSON file containing every new parcel (2 or more features).'
                      : cs.case_type === 'consolidation' ? 'Import the merged parcel as a single feature.'
                      : 'No geometry imported yet.'}
                  </p>}
            <ParcelMap overlays={overlays} height={340} />
            {can('case.import_geometry') && <GeometryImport caseId={id!} act={act} />}
          </Section>
          <Validation data={data} act={act} caseId={id!} canValidate={can('case.validate')} canAcknowledge={can('case.acknowledge_finding')} />
          <Actions data={data} act={act} caseId={id!} can={can} />
        </div>
      </div>

      <Section title="History">
        {data.decisions.length > 0 && (
          <table className="table">
            <thead><tr><th>Decision</th><th>By</th><th>Reason</th><th>Authority</th><th>When</th><th>Snapshot</th></tr></thead>
            <tbody>
              {data.decisions.map((d: any) => (
                <tr key={d.id} className={d.superseded_at ? 'muted' : ''}>
                  <td>{d.decision}{d.superseded_at && ' (superseded)'}</td><td>{d.decided_by}</td><td>{d.reason}</td>
                  <td>{d.authority_basis ?? '—'}</td><td>{fmtDate(d.decided_at)}</td><td><code className="small">{d.snapshot_hash.slice(0, 12)}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ol className="timeline">
          {data.events.map((e: any) => (
            <li key={e.id}>
              <span className="muted small">{fmtDate(e.at)}</span> <strong>{e.actor ?? 'system'}</strong> {human(e.action)}
              {e.to_status && <> → <StatusPill status={e.to_status} /></>}
              {e.note && <span className="muted"> — {e.note}</span>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

/** For a correction, shows the published value beside a field when the case proposes something different. */
function Was({ published, proposed }: { published: unknown; proposed: unknown }) {
  const norm = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(Number(v) || v));
  if (norm(published) === norm(proposed)) return null;
  return <span className="small changed"> (published: {published === null || published === undefined || published === '' ? '—' : String(published)})</span>;
}

function Attributes({ data, editable, onSave }: { data: any; editable: boolean; onSave: (b: object) => void }) {
  const cs = data.case;
  const [form, setForm] = useState({
    landCategory: cs.land_category ?? '',
    landUse: cs.land_use ?? '',
    sourceReference: cs.source_reference ?? '',
    proposedUpi: cs.proposed_upi ?? '',
    correctionReason: cs.correction_reason ?? '',
    areaM2Surveyed: cs.area_m2_surveyed ?? '',
  });
  const registration = cs.case_type === 'first_registration';
  const correction = cs.case_type === 'correction';
  const createsParcels = cs.case_type !== 'transfer';
  // For a correction, the published values the case would change.
  const pub = correction ? data.parcel : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { sourceReference: form.sourceReference || null };
    if (createsParcels) Object.assign(body, { landCategory: form.landCategory || null, landUse: form.landUse || null });
    if (registration) Object.assign(body, { proposedUpi: form.proposedUpi || null });
    if (correction) Object.assign(body, { correctionReason: form.correctionReason || null, areaM2Surveyed: form.areaM2Surveyed === '' ? null : Number(form.areaM2Surveyed) });
    onSave(body);
  };
  const title = correction ? 'Corrected record' : 'Case details';
  if (!editable) {
    return (
      <Section title={title}>
        <dl className="facts">
          {correction && <><dt>Reason</dt><dd>{cs.correction_reason ?? '—'}</dd></>}
          {createsParcels && <>
            <dt>Land category</dt><dd>{human(cs.land_category)}{pub && <Was published={pub.land_category} proposed={cs.land_category} />}</dd>
            <dt>Land use</dt><dd>{cs.land_use ?? '—'}{pub && <Was published={pub.land_use} proposed={cs.land_use} />}</dd>
          </>}
          {correction && <><dt>Surveyed area</dt><dd>{cs.area_m2_surveyed ? `${Number(cs.area_m2_surveyed).toLocaleString()} m²` : '—'}<Was published={pub?.area_m2_surveyed} proposed={cs.area_m2_surveyed} /></dd></>}
          {registration && <><dt>Proposed identifier</dt><dd>{cs.proposed_upi ?? 'assigned at publication'}</dd></>}
          <dt>Source reference</dt><dd>{cs.source_reference ?? '—'}{pub && <Was published={pub.source_reference} proposed={cs.source_reference} />}</dd>
          <dt>Opened</dt><dd>{fmtDate(cs.created_at)}</dd>
        </dl>
      </Section>
    );
  }
  return (
    <Section title={title}>
      <form onSubmit={submit} className="stack">
        {correction && (
          <label>What is wrong, and how was it established?
            <textarea value={form.correctionReason} onChange={(e) => setForm({ ...form, correctionReason: e.target.value })} />
          </label>
        )}
        {createsParcels && (
          <>
            <label>Land category{!registration && !correction && ' (of the new parcels)'}{pub && <Was published={pub.land_category} proposed={form.landCategory} />}
              <select value={form.landCategory} onChange={(e) => setForm({ ...form, landCategory: e.target.value })}>
                <option value="">—</option><option value="private">Private</option><option value="customary">Customary</option>
                <option value="government">Government</option><option value="public">Public</option>
              </select>
            </label>
            <label>Land use{pub && <Was published={pub.land_use} proposed={form.landUse} />}<input value={form.landUse} onChange={(e) => setForm({ ...form, landUse: e.target.value })} /></label>
          </>
        )}
        {correction && (
          <label>Surveyed (legally recorded) area in m²{pub && <Was published={pub.area_m2_surveyed} proposed={form.areaM2Surveyed} />}
            <input type="number" min="0" step="0.01" value={form.areaM2Surveyed} onChange={(e) => setForm({ ...form, areaM2Surveyed: e.target.value })} />
          </label>
        )}
        {registration && (
          <label>Proposed identifier<input value={form.proposedUpi} placeholder="assigned at publication if blank" onChange={(e) => setForm({ ...form, proposedUpi: e.target.value.toUpperCase() })} /></label>
        )}
        <label>Source reference{pub && <Was published={pub.source_reference} proposed={form.sourceReference} />}<input value={form.sourceReference} onChange={(e) => setForm({ ...form, sourceReference: e.target.value })} /></label>
        <button type="submit">Save details</button>
      </form>
    </Section>
  );
}

function CurrentRights({ parcel, note }: { parcel: any; note: string }) {
  return (
    <Section title={`Interests on ${parcel.upi}${parcel.status === 'retired' ? ' (retired)' : ''}`}>
      <ul className="plain">
        {parcel.current_rights.map((r: any, i: number) => (
          <li key={i} className={r.ended ? 'muted' : ''}>
            {human(r.rrrType)}{r.share && ` ${r.share}`} — {r.partyName} <span className="muted">({r.partyType})</span>{r.ended && ' — ended by this case'}
          </li>
        ))}
      </ul>
      <p className="small muted">{note}</p>
    </Section>
  );
}

function PartyPicker({ onPick }: { onPick: (p: { id: string; name: string }) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    setResults(await api(`/parties?q=${encodeURIComponent(q)}`));
  };
  return (
    <div>
      <form onSubmit={search} className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parties by name" />
        <button type="submit" className="secondary">Search</button>
      </form>
      <ul className="plain picker">
        {results.map((p) => (
          <li key={p.id}>
            <button type="button" className="link" onClick={() => { onPick(p); setResults([]); }}>{p.name}</button>
            <span className="muted small"> {p.party_type} · identity {p.identity_status}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">Not listed? Record the party on the <Link to="/work/parties">Parties</Link> page; another processor then verifies their identity.</p>
    </div>
  );
}

function Rights({ data, editable, act, caseId, featureCount }: { data: any; editable: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; caseId: string; featureCount: number }) {
  const [party, setParty] = useState<{ id: string; name: string } | null>(null);
  const [rrrType, setRrrType] = useState('ownership');
  const [share, setShare] = useState('');
  const [target, setTarget] = useState(0);
  const subdivision = data.case.case_type === 'subdivision';
  const add = (e: FormEvent) => {
    e.preventDefault();
    const [num, den] = share.split('/').map((s) => Number(s.trim()));
    const body: Record<string, unknown> = { partyId: party!.id, rrrType };
    if (share) Object.assign(body, { shareNum: num, shareDen: den });
    if (subdivision) body.featureIndex = target;
    void act(() => api(`/cases/${caseId}/rights`, { body })).then(() => { setParty(null); setShare(''); });
  };
  const title = data.case.case_type === 'transfer' ? 'Incoming rights holders' : subdivision ? 'Proposed rights on the new parcels' : 'Proposed rights';
  return (
    <Section
      title={title}
      actions={editable && subdivision && featureCount > 1 && data.rights.length === 0 && (
        <button className="secondary" onClick={() => void act(() => api(`/cases/${caseId}/rights/copy-from-source`, { method: 'POST' }))}>
          Copy current ownership to each new parcel
        </button>
      )}
    >
      {data.rights.length === 0 ? <p className="muted">None recorded.</p> : (
        <table className="table">
          <thead><tr>{subdivision && <th>New parcel</th>}<th>Party</th><th>Interest</th><th>Share</th><th>Identity</th>{editable && <th />}</tr></thead>
          <tbody>
            {data.rights.map((r: any) => (
              <tr key={r.id}>
                {subdivision && <td>{r.feature_index === null ? <span className="danger">unassigned</span> : r.feature_index + 1}</td>}
                <td>{r.party_name} <span className="muted small">({r.party_type})</span></td>
                <td>{human(r.rrr_type)}</td>
                <td>{r.share_den ? `${r.share_num}/${r.share_den}` : '—'}</td>
                <td className={r.identity_status === 'verified' ? '' : 'danger'}>{r.identity_status}</td>
                {editable && <td><button className="link" onClick={() => void act(() => api(`/cases/${caseId}/rights/${r.id}`, { method: 'DELETE' }))}>Remove</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">A proposed right is a claim under review. It becomes a registered interest only when an authorized registrar approves and publishes the case.</p>
      {editable && subdivision && featureCount < 2 && <p className="small muted">Import the new parcel geometries first; interests are recorded per new parcel.</p>}
      {editable && (!subdivision || featureCount > 1) && (
        party ? (
          <form onSubmit={add} className="row wrap">
            <strong>{party.name}</strong>
            {subdivision && (
              <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="New parcel">
                {Array.from({ length: featureCount }, (_, i) => <option key={i} value={i}>New parcel {i + 1}</option>)}
              </select>
            )}
            <select value={rrrType} onChange={(e) => setRrrType(e.target.value)} aria-label="Interest">
              {RRR_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}
            </select>
            <input value={share} onChange={(e) => setShare(e.target.value)} placeholder="share e.g. 1/2 (co-ownership)" />
            <button type="submit">Add</button>
            <button type="button" className="secondary" onClick={() => setParty(null)}>Cancel</button>
          </form>
        ) : <PartyPicker onPick={setParty} />
      )}
    </Section>
  );
}

function Documents({ data, canUpload, act, caseId }: { data: any; canUpload: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; caseId: string }) {
  const [docType, setDocType] = useState('survey_plan');
  const [classification, setClassification] = useState('restricted');
  const [referenceNo, setReferenceNo] = useState('');
  const [issuer, setIssuer] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);

  const upload = (e: FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.append('docType', docType);
    form.append('classification', docType === 'id_document' ? 'highly_sensitive' : classification);
    if (referenceNo) form.append('referenceNo', referenceNo);
    if (issuer) form.append('issuer', issuer);
    form.append('file', file!);
    void act(() => api(`/cases/${caseId}/documents`, { form })).then(() => { setFile(null); setReferenceNo(''); setIssuer(''); setFormKey((k) => k + 1); });
  };

  const verify = (docId: string, status: 'verified' | 'rejected') => {
    const note = window.prompt(status === 'verified' ? 'Verification note (what was checked):' : 'Reason for rejection:');
    if (note) void act(() => api(`/cases/${caseId}/documents/${docId}/verify`, { body: { status, note } }));
  };

  return (
    <Section title="Documents and evidence">
      {data.documents.length === 0 ? <p className="muted">No documents.</p> : (
        <table className="table">
          <thead><tr><th>Type</th><th>Reference</th><th>Class</th><th>Uploaded</th><th>Check</th><th /></tr></thead>
          <tbody>
            {data.documents.map((d: any) => (
              <tr key={d.id}>
                <td>{human(d.doc_type)}</td>
                <td>{d.reference_no ?? '—'}{d.issuer && <div className="small muted">{d.issuer}</div>}</td>
                <td><span className={`pill c-${d.classification}`}>{human(d.classification)}</span></td>
                <td className="small">{d.uploaded_by_username}<br />{fmtDate(d.uploaded_at)}</td>
                <td className="small">
                  {d.verification_status}
                  {d.verified_by_username && <> by {d.verified_by_username}</>}
                  {d.verification_note && <div className="muted">{d.verification_note}</div>}
                  {d.canVerify && (
                    <div className="row">
                      <button className="link" onClick={() => verify(d.id, 'verified')}>Verify</button>
                      <button className="link danger" onClick={() => verify(d.id, 'rejected')}>Reject</button>
                    </div>
                  )}
                </td>
                <td>{d.canDownload ? <a href={`/api/documents/${d.id}/file`}>Download</a> : <span className="muted small">restricted</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">Documents are verified by a processor other than the uploader. Downloads of restricted files are logged.</p>
      {canUpload && (
        <form key={formKey} onSubmit={upload} className="stack compact">
          <div className="row wrap">
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOC_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}
            </select>
            <select value={docType === 'id_document' ? 'highly_sensitive' : classification} disabled={docType === 'id_document'} onChange={(e) => setClassification(e.target.value)}>
              <option value="public">Public</option><option value="restricted">Restricted</option><option value="highly_sensitive">Highly sensitive</option>
            </select>
          </div>
          <div className="row wrap">
            <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Reference no." />
            <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuing authority" />
          </div>
          <div className="row wrap">
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            <button type="submit" disabled={!file}>Upload</button>
          </div>
        </form>
      )}
    </Section>
  );
}

function GeometryImport({ caseId, act }: { caseId: string; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [crs, setCrs] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.append('crs', crs);
    form.append('file', file!);
    void act(() => api(`/cases/${caseId}/geometry`, { form }));
  };
  return (
    <form onSubmit={submit} className="stack compact">
      <strong>Import parcel geometry (GeoJSON exported from ArcGIS Pro / QGIS)</strong>
      <div className="row wrap">
        <select value={crs} onChange={(e) => setCrs(e.target.value)} required>
          <option value="">Declare the coordinate reference system…</option>
          <option value="4326">EPSG:4326 — WGS 84 longitude/latitude</option>
          <option value="32629">EPSG:32629 — WGS 84 / UTM zone 29N (metres)</option>
        </select>
        <input type="file" accept=".geojson,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <button type="submit" disabled={!file || !crs}>Import to staging</button>
      </div>
      <p className="small muted">The file goes to staging only. Invalid geometry is kept as received and flagged, never repaired automatically.</p>
    </form>
  );
}

function Validation({ data, act, caseId, canValidate, canAcknowledge }: { data: any; act: (fn: () => Promise<unknown>) => Promise<void>; caseId: string; canValidate: boolean; canAcknowledge: boolean }) {
  const v = data.validation;
  const acknowledge = (findingId: string) => {
    const note = window.prompt('Investigation note for this finding (required):');
    if (note) void act(() => api(`/cases/${caseId}/findings/${findingId}/acknowledge`, { body: { note } }));
  };
  return (
    <Section
      title="Validation and conflict checks"
      actions={canValidate && <button className="secondary" onClick={() => void act(() => api(`/cases/${caseId}/validate`, { method: 'POST' }))}>Run checks</button>}
    >
      {!v ? <p className="muted">Not yet validated.</p> : (
        <>
          <p className="small muted">Run {fmtDate(v.run.run_at)} ({v.run.purpose}): {v.run.error_count} error(s), {v.run.warning_count} warning(s).</p>
          {v.findings.length === 0 && <div className="alert ok">No issues found.</div>}
          <ul className="findings">
            {v.findings.map((f: any) => (
              <li key={f.id} className={f.severity}>
                <span className={`pill ${f.severity === 'error' ? 'sev-error' : 'sev-warn'}`}>{f.severity}</span> <code className="small">{f.code}</code>
                <div>{f.message}</div>
                {f.detail?.upi && <Link className="small" to={`/work/parcels/${f.detail.upi}`}>Open {f.detail.upi}</Link>}
                {f.acknowledged_by_username && <div className="small ok-text">Acknowledged by {f.acknowledged_by_username}: {f.acknowledgement_note}</div>}
                {canAcknowledge && f.severity === 'warning' && !f.acknowledged_by && (
                  <button className="link" onClick={() => acknowledge(f.id)}>Acknowledge with note</button>
                )}
              </li>
            ))}
          </ul>
          <p className="small muted">Errors must be corrected. Warnings are signals for investigation, not legal findings; a registrar must acknowledge each one before approval.</p>
        </>
      )}
    </Section>
  );
}

function Actions({ data, act, caseId, can }: { data: any; act: (fn: () => Promise<unknown>) => Promise<void>; caseId: string; can: (a: string) => boolean }) {
  const [decision, setDecision] = useState('approved');
  const [reason, setReason] = useState('');
  const [authorityBasis, setAuthorityBasis] = useState('');
  const any = ['case.submit', 'case.withdraw', 'case.decide', 'case.publish'].some(can);
  if (!any) return null;

  const decide = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api(`/cases/${caseId}/decision`, { body: { decision, reason, authorityBasis: authorityBasis || undefined } }));
  };

  return (
    <Section title="Workflow">
      <div className="stack">
        {can('case.submit') && (
          <div>
            <button onClick={() => void act(() => api(`/cases/${caseId}/submit`, { method: 'POST' }))}>Submit for review</button>
            <p className="small muted">Runs all checks. Cases with errors come back as “Returned”.</p>
          </div>
        )}
        {can('case.decide') && (
          <form onSubmit={decide} className="stack decision">
            <strong>Record a decision</strong>
            <div className="row wrap">
              {['approved', 'returned', 'rejected'].map((d) => (
                <label key={d} className="inline"><input type="radio" checked={decision === d} onChange={() => setDecision(d)} /> {d === 'approved' ? 'Approve' : d === 'returned' ? 'Return for correction' : 'Reject'}</label>
              ))}
            </div>
            <label>Reasons (recorded permanently)<textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} /></label>
            {decision === 'approved' && (
              <label>Delegated authority relied on<input value={authorityBasis} onChange={(e) => setAuthorityBasis(e.target.value)} placeholder="e.g. delegation instrument reference" required /></label>
            )}
            <button type="submit">Record decision</button>
          </form>
        )}
        {can('case.publish') && (
          <div>
            <button onClick={() => void act(() => api(`/cases/${caseId}/publish`, { method: 'POST' }))}>Publish approved record</button>
            <p className="small muted">Re-checks that nothing changed since approval, then publishes in a single transaction.</p>
          </div>
        )}
        {can('case.withdraw') && (
          <button className="secondary" onClick={() => {
            const reason = window.prompt('Reason for withdrawing this case:');
            if (reason) void act(() => api(`/cases/${caseId}/withdraw`, { body: { reason } }));
          }}>Withdraw case</button>
        )}
      </div>
    </Section>
  );
}
