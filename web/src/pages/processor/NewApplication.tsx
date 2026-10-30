import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Search, Upload } from 'lucide-react';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { ErrorBanner, Panel, QueryState, useToast } from '../../components/kit';
import type { ApplicantRow, ApplicationCategory, ApplicationWorkspace, Paged } from '../../types';
import { CompletenessChecklist, ReviewBadge, UploadDocumentModal, human } from './common';

/**
 * Application registration wizard: 1 applicant, 2 application, 3 declared parcel, 4 documents, 5 review.
 * The application is saved as a draft at the end of step 3 (so documents attach to it), and registered in
 * step 5 once the registration requirements are met. Parcel details are the applicant's declaration and
 * stay unverified; geometry is never drawn here.
 */
const STEPS = ['Applicant', 'Application', 'Declared parcel', 'Documents', 'Review and register'];
const ID_TYPES = { national_id: 'National ID card', passport: 'Passport', voter_card: 'Voter card', drivers_licence: "Driver's licence", registration_certificate: 'Registration certificate (organizations)', other: 'Other' };

type Applicant = {
  applicantType: string; name: string; phone: string; email: string; address: string; idDocumentType: string; idReference: string;
  representativeName: string; representativeRole: string; representativePhone: string;
};
const emptyApplicant: Applicant = { applicantType: 'person', name: '', phone: '', email: '', address: '', idDocumentType: '', idReference: '', representativeName: '', representativeRole: '', representativePhone: '' };

export function NewApplication() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const counties = (session?.grants ?? []).filter((g) => g.role === 'processor' && g.county).map((g) => g.county!);
  const categories = useQuery({ queryKey: ['processor', 'categories'], queryFn: () => api<{ categories: ApplicationCategory[] }>('/applications/categories'), staleTime: 300_000 });
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<ApplicantRow[] | null>(null);
  const [existing, setExisting] = useState<ApplicantRow | null>(null);
  const [applicant, setApplicant] = useState<Applicant>(emptyApplicant);
  // Step 2
  const [app, setApp] = useState({
    categoryCode: '', countyId: counties[0]?.id ?? 0, parcelUpi: '', parcelUpis: '', landCategory: '', purpose: '', submissionDate: new Date().toISOString().slice(0, 10),
    receivingOffice: counties[0] ? `${counties[0].name.replace(/ \(.*\)$/, '')} county office` : '', externalReference: '', titleDeedRef: '', remarks: '', correctionReason: '',
  });
  // The session may load after the first render: default the county and office once it is known.
  useEffect(() => {
    if (!app.countyId && counties[0]) {
      setApp((x) => ({ ...x, countyId: counties[0].id, receivingOffice: x.receivingOffice || `${counties[0].name.replace(/ \(.*\)$/, '')} county office` }));
    }
  }, [counties, app.countyId]);
  // Step 3
  const [parcel, setParcel] = useState({ declaredParcelRef: '', district: '', locality: '', declaredLandUse: '', declaredArea: '', declaredAreaUnit: 'ha', locationDescription: '', surveyReference: '' });
  // After creation
  const [created, setCreated] = useState<{ id: string; caseNo: string; applicantNo: string } | null>(null);
  const [duplicates, setDuplicates] = useState<{ caseNo: string; applicantNo: string; matchReason: string }[] | null>(null);
  const [duplicateReason, setDuplicateReason] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState({ county: false, category: false, documents: false });
  const [outstanding, setOutstanding] = useState('');

  const category = categories.data?.categories.find((c) => c.code === app.categoryCode);
  const needsCounty = !category || ['first_registration', 'migration'].includes(category.case_type);
  const needsParcel = category && ['transfer', 'subdivision', 'correction', 'confirmation'].includes(category.case_type);
  const needsParcels = category?.case_type === 'consolidation';
  const workspace = useQuery({ queryKey: ['processor', 'application', created?.id], queryFn: () => api<ApplicationWorkspace>(`/applications/${created!.id}`), enabled: !!created });

  const requiredFields = useMemo(() => new Set((category?.requirements ?? []).filter((r) => r.kind === 'field' && r.mandatory && r.stage === 'registration').map((r) => r.field_key)), [category]);
  const req = (key: string) => (requiredFields.has(key) ? ' (required to register)' : '');

  const applicantOk = mode === 'existing' ? !!existing : applicant.name.trim().length >= 2;
  const appOk = !!app.categoryCode && (needsCounty ? !!app.countyId : true) && (!needsParcel || !!app.parcelUpi.trim()) && (!needsParcels || app.parcelUpis.split(',').filter((s) => s.trim()).length >= 2);

  const findApplicants = async () => {
    setError(null);
    try { setFound((await api<Paged<ApplicantRow>>(`/applicants?q=${encodeURIComponent(search)}&pageSize=10`)).items); } catch (e) { setError((e as Error).message); }
  };

  const createDraft = async () => {
    setBusy(true); setError(null);
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const body = {
      mode: 'draft',
      ...(mode === 'existing' ? { applicantId: existing!.id } : {
        applicant: {
          applicantType: applicant.applicantType, name: applicant.name.trim(), phone: opt(applicant.phone) ?? null, email: opt(applicant.email) ?? null, address: opt(applicant.address) ?? null,
          idDocumentType: applicant.idDocumentType || null, idReference: opt(applicant.idReference) ?? null, representativeName: opt(applicant.representativeName) ?? null,
          representativeRole: opt(applicant.representativeRole) ?? null, representativePhone: opt(applicant.representativePhone) ?? null,
        },
      }),
      categoryCode: app.categoryCode,
      ...(needsCounty ? { countyId: app.countyId } : {}),
      ...(needsParcel ? { parcelUpi: app.parcelUpi.trim() } : {}),
      ...(needsParcels ? { parcelUpis: app.parcelUpis.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(category?.case_type === 'first_registration' && app.landCategory ? { landCategory: app.landCategory } : {}),
      ...(category?.case_type === 'correction' ? { correctionReason: opt(app.correctionReason) ?? null } : {}),
      purpose: opt(app.purpose) ?? null, submissionDate: app.submissionDate || null, receivingOffice: opt(app.receivingOffice) ?? null,
      externalReference: opt(app.externalReference) ?? null, titleDeedRef: opt(app.titleDeedRef) ?? null, remarks: opt(app.remarks) ?? null,
      declaredParcelRef: opt(parcel.declaredParcelRef) ?? null, district: opt(parcel.district) ?? null, locality: opt(parcel.locality) ?? null,
      declaredLandUse: opt(parcel.declaredLandUse) ?? null, locationDescription: opt(parcel.locationDescription) ?? null, surveyReference: opt(parcel.surveyReference) ?? null,
      declaredArea: parcel.declaredArea ? Number(parcel.declaredArea) : null, declaredAreaUnit: parcel.declaredArea ? parcel.declaredAreaUnit : null,
      ...(duplicates && duplicateReason ? { duplicateReview: { reason: duplicateReason } } : {}),
    };
    try {
      const r = await api<{ id: string; caseNo: string; applicantNo: string }>('/applications', { body });
      setCreated(r); setDuplicates(null);
      toast('success', `${r.caseNo} saved as a draft for applicant ${r.applicantNo}`);
      setStep(3);
    } catch (e) {
      const details = (e as ApiError).details as { duplicates?: typeof duplicates } | undefined;
      if (e instanceof ApiError && e.status === 409 && details?.duplicates) setDuplicates(details.duplicates);
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const register = async (finish: boolean) => {
    if (!created) return;
    setBusy(true); setError(null);
    try {
      if (outstanding.trim()) await api(`/applications/${created.id}/notes`, { body: { note: `Outstanding at registration: ${outstanding.trim()}` } });
      if (finish) {
        await api(`/applications/${created.id}/register`, { method: 'POST' });
        toast('success', `${created.caseNo} registered`);
      } else toast('info', `${created.caseNo} kept as a draft`);
      void qc.invalidateQueries({ queryKey: ['processor'] });
      navigate(`/processor/applications/${created.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const ws = workspace.data;
  const docRequirements = (category?.requirements ?? []).filter((r) => r.kind === 'document');

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>New Application</h1><p className="muted small">Register an application received through an official channel. Collect only what the process needs: not every applicant has an e-mail address or a smartphone.</p></div></div>
      <ol className="stepper" aria-label="Registration steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i + 1}</span>{s}</li>)}
      </ol>
      <ErrorBanner error={error} />

      {step === 0 && (
        <Panel title="1. Applicant">
          <div className="segmented" role="group" aria-label="Applicant">
            <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New applicant</button>
            <button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>Existing applicant</button>
          </div>
          {mode === 'existing' ? (
            <div className="stack">
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void findApplicants(); }}>
                <label>Find by name, applicant number or telephone <input value={search} onChange={(e) => setSearch(e.target.value)} minLength={2} /></label>
                <button type="submit" disabled={search.trim().length < 2}><Search size={16} /> Search</button>
              </form>
              {found && (found.length === 0 ? <p className="muted">No applicant found. Register a new one.</p> : (
                <table className="table"><thead><tr><th /><th>Applicant</th><th>Type</th><th>Telephone</th><th>Applications</th></tr></thead>
                  <tbody>{found.map((a) => (
                    <tr key={a.id}><td><input type="radio" name="applicant" aria-label={`Choose ${a.name}`} checked={existing?.id === a.id} onChange={() => setExisting(a)} /></td>
                      <td>{a.name} <span className="muted small">{a.applicant_no}</span></td><td>{human(a.applicant_type)}</td><td>{a.phone ?? '—'}</td><td>{a.applications}</td></tr>
                  ))}</tbody></table>
              ))}
            </div>
          ) : (
            <div className="form-grid">
              <label>Applicant type
                <select value={applicant.applicantType} onChange={(e) => setApplicant({ ...applicant, applicantType: e.target.value })}>
                  <option value="person">Person</option><option value="organization">Organization</option><option value="community">Community</option><option value="government">Government body</option>
                </select>
              </label>
              <label>Full name or registered name (required) <input value={applicant.name} onChange={(e) => setApplicant({ ...applicant, name: e.target.value })} maxLength={200} /></label>
              <label>Telephone (optional) <input value={applicant.phone} onChange={(e) => setApplicant({ ...applicant, phone: e.target.value })} placeholder="+231 ..." /></label>
              <label>E-mail (optional) <input type="email" value={applicant.email} onChange={(e) => setApplicant({ ...applicant, email: e.target.value })} /></label>
              <label className="span-2">Correspondence address (optional) <input value={applicant.address} onChange={(e) => setApplicant({ ...applicant, address: e.target.value })} maxLength={500} /></label>
              <label>Identification document type (only if the process requires it)
                <select value={applicant.idDocumentType} onChange={(e) => setApplicant({ ...applicant, idDocumentType: e.target.value })}>
                  <option value="">None recorded</option>{Object.entries(ID_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label>Identification reference (restricted) <input value={applicant.idReference} onChange={(e) => setApplicant({ ...applicant, idReference: e.target.value })} maxLength={60} disabled={!applicant.idDocumentType} /></label>
              <label>Authorized representative (optional) <input value={applicant.representativeName} onChange={(e) => setApplicant({ ...applicant, representativeName: e.target.value })} /></label>
              <label>Representative's role <input value={applicant.representativeRole} onChange={(e) => setApplicant({ ...applicant, representativeRole: e.target.value })} placeholder="e.g. Attorney-in-fact, family head" /></label>
            </div>
          )}
        </Panel>
      )}

      {step === 1 && (
        <Panel title="2. Application">
          <QueryState query={categories}>
            {(c) => (
              <div className="form-grid">
                <label>Application category (required)
                  <select value={app.categoryCode} onChange={(e) => setApp({ ...app, categoryCode: e.target.value })}>
                    <option value="">Choose</option>{c.categories.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
                  </select>
                </label>
                {needsCounty && (
                  <label>County (required)
                    <select value={app.countyId} onChange={(e) => setApp({ ...app, countyId: Number(e.target.value) })}>
                      {counties.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </label>
                )}
                {needsParcel && <label>Registered parcel identifier (required) <input value={app.parcelUpi} onChange={(e) => setApp({ ...app, parcelUpi: e.target.value })} placeholder="PROV-MO-000010" /></label>}
                {needsParcels && <label>Registered parcels to consolidate (comma-separated) <input value={app.parcelUpis} onChange={(e) => setApp({ ...app, parcelUpis: e.target.value })} /></label>}
                {category?.case_type === 'first_registration' && (
                  <label>Land category (if known)
                    <select value={app.landCategory} onChange={(e) => setApp({ ...app, landCategory: e.target.value })}>
                      <option value="">Not stated</option><option value="private">Private</option><option value="customary">Customary</option><option value="public">Public</option><option value="government">Government</option>
                    </select>
                  </label>
                )}
                <label className="span-2">Purpose of the application{req('purpose')} <textarea rows={2} value={app.purpose} onChange={(e) => setApp({ ...app, purpose: e.target.value })} maxLength={1000} /></label>
                <label>Submission date{req('submission_date')} <input type="date" value={app.submissionDate} onChange={(e) => setApp({ ...app, submissionDate: e.target.value })} /></label>
                <label>Receiving office{req('receiving_office')} <input value={app.receivingOffice} onChange={(e) => setApp({ ...app, receivingOffice: e.target.value })} /></label>
                <label>Office receipt number (optional, unique) <input value={app.externalReference} onChange={(e) => setApp({ ...app, externalReference: e.target.value })} placeholder="MO/RCPT/0001" /></label>
                <label>Existing title or deed reference{req('title_deed_ref')} <input value={app.titleDeedRef} onChange={(e) => setApp({ ...app, titleDeedRef: e.target.value })} /></label>
                {category?.case_type === 'correction' && <label className="span-2">What needs correcting <textarea rows={2} value={app.correctionReason} onChange={(e) => setApp({ ...app, correctionReason: e.target.value })} /></label>}
                <label className="span-2">Remarks (optional) <textarea rows={2} value={app.remarks} onChange={(e) => setApp({ ...app, remarks: e.target.value })} /></label>
              </div>
            )}
          </QueryState>
          {category && <p className="muted small">Category requirements are working defaults configured by administrators, not a statutory checklist. Assigned processor: you (it can be changed later).</p>}
        </Panel>
      )}

      {step === 2 && (
        <Panel title="3. Declared parcel information">
          <div className="alert"><AlertTriangle size={16} /> Everything on this step is the applicant's declaration. It stays <strong>unverified</strong> until the GIS officer's technical checks and the registrar's decision. No geometry is drawn or edited here.</div>
          <div className="form-grid">
            <label>Declared parcel identifier{req('declared_parcel_ref')} <input value={parcel.declaredParcelRef} onChange={(e) => setParcel({ ...parcel, declaredParcelRef: e.target.value })} /></label>
            <label>District{req('district')} <input value={parcel.district} onChange={(e) => setParcel({ ...parcel, district: e.target.value })} /></label>
            <label>Community or locality{req('locality')} <input value={parcel.locality} onChange={(e) => setParcel({ ...parcel, locality: e.target.value })} /></label>
            <label>Land use (as described){req('declared_land_use')} <input value={parcel.declaredLandUse} onChange={(e) => setParcel({ ...parcel, declaredLandUse: e.target.value })} /></label>
            <label>Declared size{req('declared_area')} <input type="number" min="0" step="any" value={parcel.declaredArea} onChange={(e) => setParcel({ ...parcel, declaredArea: e.target.value })} /></label>
            <label>Unit
              <select value={parcel.declaredAreaUnit} onChange={(e) => setParcel({ ...parcel, declaredAreaUnit: e.target.value })}>
                <option value="m2">square metres</option><option value="ha">hectares</option><option value="acre">acres</option>
              </select>
            </label>
            <label>Existing survey reference{req('survey_reference')} <input value={parcel.surveyReference} onChange={(e) => setParcel({ ...parcel, surveyReference: e.target.value })} /></label>
            <label className="span-2">Location description{req('location_description')} <textarea rows={3} value={parcel.locationDescription} onChange={(e) => setParcel({ ...parcel, locationDescription: e.target.value })} /></label>
          </div>
          <p className="muted small">A supporting map or sketch is attached as a document in the next step.</p>
          {duplicates && (
            <div className="alert">
              <strong>Possible duplicate.</strong> Similar open applications exist:
              <ul>{duplicates.map((d) => <li key={d.caseNo}>{d.caseNo} (applicant {d.applicantNo}): {d.matchReason}</li>)}</ul>
              Check them. If this is a separate application, explain why (recorded with the application):
              <textarea rows={2} value={duplicateReason} onChange={(e) => setDuplicateReason(e.target.value)} aria-label="Why this is not a duplicate" />
            </div>
          )}
        </Panel>
      )}

      {step === 3 && created && (
        <Panel title={`4. Supporting documents for ${created.caseNo}`} actions={<button onClick={() => setUploading(true)}><Upload size={16} /> Upload a document</button>}>
          <p className="small">Attach documents received through an official channel. Required for this category (working defaults):</p>
          <ul className="small">{docRequirements.map((r) => <li key={r.id}>{r.doc_label} — {r.mandatory ? 'required' : 'optional'} {r.stage === 'registration' ? 'to register' : r.stage === 'gis_handoff' ? 'before GIS processing' : 'before submission for review'}</li>)}</ul>
          <QueryState query={workspace}>
            {(w) => w.documents.length === 0 ? <p className="muted">No documents yet.</p> : (
              <table className="table"><thead><tr><th>Document</th><th>Category</th><th>Title</th><th>Review</th></tr></thead>
                <tbody>{w.documents.filter((d) => d.review_status !== 'superseded').map((d) => <tr key={d.id}><td>{d.document_no}</td><td>{d.doc_label}</td><td>{d.title ?? '—'}</td><td><ReviewBadge status={d.review_status} /></td></tr>)}</tbody></table>
            )}
          </QueryState>
          {uploading && <UploadDocumentModal open caseId={created.id} onClose={() => { setUploading(false); void workspace.refetch(); }} />}
        </Panel>
      )}

      {step === 4 && created && ws && (
        <Panel title={`5. Review and register ${created.caseNo}`}>
          <dl className="facts">
            <dt>Applicant</dt><dd>{ws.applicant?.name} ({ws.applicant?.applicant_no})</dd>
            <dt>Category</dt><dd>{ws.application.category_label}</dd>
            <dt>County</dt><dd>{ws.application.county_name}</dd>
            <dt>Purpose</dt><dd>{ws.application.purpose ?? <span className="warn-text">missing</span>}</dd>
            <dt>Submitted</dt><dd>{ws.application.submission_date?.slice(0, 10) ?? '—'} at {ws.application.receiving_office ?? '—'}</dd>
            <dt>Declared parcel</dt><dd>{ws.application.declared_parcel_ref ?? ws.application.parcel_upi ?? '—'} · {ws.application.location_description ?? 'no description'} <em className="muted">(declared, unverified)</em></dd>
            <dt>Documents</dt><dd>{ws.documents.filter((d) => d.review_status !== 'superseded').length} attached</dd>
          </dl>
          {ws.completeness && <CompletenessChecklist data={ws.completeness} />}
          <label className="check"><input type="checkbox" checked={confirm.county} onChange={(e) => setConfirm({ ...confirm, county: e.target.checked })} /> The county ({ws.application.county_name}) is correct</label>
          <label className="check"><input type="checkbox" checked={confirm.category} onChange={(e) => setConfirm({ ...confirm, category: e.target.checked })} /> The category ({ws.application.category_label}) is correct</label>
          <label className="check"><input type="checkbox" checked={confirm.documents} onChange={(e) => setConfirm({ ...confirm, documents: e.target.checked })} /> I have checked the uploaded documents</label>
          <label>Outstanding information to follow up (optional; saved as a note) <textarea rows={2} value={outstanding} onChange={(e) => setOutstanding(e.target.value)} /></label>
          <div className="chip-row">
            <button className="secondary" disabled={busy} onClick={() => void register(false)}>Keep as draft</button>
            <button disabled={busy || !confirm.county || !confirm.category || !confirm.documents} onClick={() => void register(true)}>Register application</button>
          </div>
        </Panel>
      )}

      <div className="wizard-foot">
        <button className="secondary" onClick={() => setStep(step - 1)} disabled={step === 0 || busy || (!!created && step <= 3)}>Back</button>
        {step < 2 && <button onClick={() => setStep(step + 1)} disabled={step === 0 ? !applicantOk : !appOk}>Next</button>}
        {step === 2 && <button onClick={() => void createDraft()} disabled={busy || (!!duplicates && duplicateReason.trim().length < 10)}>{busy ? 'Saving…' : duplicates ? 'Register anyway as a separate application' : 'Save draft and continue'}</button>}
        {step === 3 && <button onClick={() => { void workspace.refetch(); setStep(4); }}>Next</button>}
        {created && <Link to={`/processor/applications/${created.id}`}>Open the application workspace</Link>}
      </div>
    </div>
  );
}
