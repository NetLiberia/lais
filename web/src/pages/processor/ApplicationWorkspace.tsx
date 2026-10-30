import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Upload } from 'lucide-react';
import { api, ApiError } from '../../api';
import { Badge, EmptyState, ErrorBanner, fmtDateTime, Panel, QueryState, useToast } from '../../components/kit';
import type { ApplicationWorkspace as Workspace, TimelineEvent } from '../../types';
import {
  CompletenessBadge, CompletenessChecklist, DocumentViewer, ReviewBadge, StageBadge, Timeline, UploadDocumentModal, fmtBytes, human,
} from './common';
import { CreateInfoRequestModal, DELIVERY_LABELS, InfoRequestDrawer, RequestStatusBadge } from './InfoRequests';

const TABS = [
  ['overview', 'Overview'], ['applicant', 'Applicant'], ['details', 'Application details'], ['parcel', 'Declared parcel'], ['documents', 'Supporting documents'],
  ['verification', 'Document verification'], ['completeness', 'Completeness'], ['requests', 'Information requests'], ['gis', 'GIS processing'],
  ['supervision', 'Supervisory review'], ['registrar', 'Registrar decision'], ['timeline', 'Workflow timeline'], ['notes', 'Notes'], ['audit', 'Audit history'],
] as const;
type Tab = (typeof TABS)[number][0];

const PROVENANCE = {
  applicant: { label: 'Provided by the applicant', tone: 'not_submitted' },
  processor: { label: 'Recorded by the processor', tone: 'info_requested' },
  gis: { label: 'GIS technical result', tone: 'assigned' },
  supervisor: { label: 'Supervisor quality review', tone: 'under_review' },
  registrar: { label: 'Registrar legal decision', tone: 'approved' },
} as const;
const Provenance = ({ of }: { of: keyof typeof PROVENANCE }) => <Badge value={PROVENANCE[of].tone} label={PROVENANCE[of].label} />;

export function ApplicationWorkspacePage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };
  const ws = useQuery({ queryKey: ['processor', 'application', id], queryFn: () => api<Workspace>(`/applications/${id}`) });
  return (
    <div className="page-v2">
      <QueryState query={ws}>
        {(w) => (
          <>
            <div className="page-title">
              <div>
                <h1>{w.application.case_no}</h1>
                <p className="muted">{w.application.category_label} · {w.application.county_name} · applicant {w.applicant?.name ?? '—'} ({w.applicant?.applicant_no ?? 'not recorded'})</p>
                <p className="stage-banner"><StageBadge stage={w.application.stage} /> <CompletenessBadge value={w.completeness?.status ?? null} />
                  {w.application.intake_status === 'draft' && <Badge value="not_submitted" label="registration draft" />}
                  <span className="muted small">Responsible processor: {w.application.assigned_processor ?? '—'}</span></p>
              </div>
            </div>
            <div className="tabs" role="tablist" aria-label="Application sections">
              {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
            </div>
            <WorkspaceTab tab={tab} w={w} setTab={setTab} />
          </>
        )}
      </QueryState>
    </div>
  );
}

function WorkspaceTab({ tab, w, setTab }: { tab: Tab; w: Workspace; setTab: (t: Tab) => void }) {
  const a = w.application;
  switch (tab) {
    case 'overview': return <Overview w={w} setTab={setTab} />;
    case 'applicant': return (
      <Panel title={<>Applicant <Provenance of="applicant" /></>} actions={w.applicant && <Link to={`/processor/applicants?open=${w.applicant.id}`}>Open applicant record</Link>}>
        {!w.applicant ? <EmptyState title="No applicant recorded">This case was not registered through intake.</EmptyState> : (
          <dl className="facts">
            <dt>Applicant</dt><dd>{w.applicant.name} ({w.applicant.applicant_no}) · {human(w.applicant.applicant_type)}</dd>
            <dt>Telephone</dt><dd>{w.applicant.contactHidden ? <em className="muted">hidden for your role</em> : w.applicant.phone ?? '—'}</dd>
            <dt>E-mail</dt><dd>{w.applicant.contactHidden ? <em className="muted">hidden for your role</em> : w.applicant.email ?? '—'}</dd>
            <dt>Address</dt><dd>{w.applicant.contactHidden ? <em className="muted">hidden for your role</em> : w.applicant.address ?? '—'}</dd>
            <dt>Identification</dt><dd>{w.applicant.id_document_type ? human(w.applicant.id_document_type) : 'none recorded'}{w.applicant.has_id_reference && ' (reference recorded; reveal from the applicant record, logged)'}</dd>
            <dt>Representative</dt><dd>{w.applicant.representative_name ? `${w.applicant.representative_name} (${w.applicant.representative_role ?? 'role not stated'})` : '—'}</dd>
            <dt>Identity</dt><dd className="muted">An applicant is an administrative contact. Identity verification of right holders is a separate, registrar-controlled step.</dd>
          </dl>
        )}
      </Panel>
    );
    case 'details': return <DetailsEditor w={w} which="details" />;
    case 'parcel': return <DetailsEditor w={w} which="parcel" />;
    case 'documents': return <DocumentsTab w={w} />;
    case 'verification': return <DocumentsTab w={w} reviewOnly />;
    case 'completeness': return <CompletenessTab w={w} />;
    case 'requests': return <RequestsTab w={w} />;
    case 'gis': return <GisTab w={w} />;
    case 'supervision': return (
      <Panel title={<>Supervisory review <Provenance of="supervisor" /></>}>
        <p className="muted small">Operational quality control by a supervisor. It is not a legal decision.</p>
        {w.supervisoryReviews.length === 0 ? <p className="muted">No supervisory review recorded.</p> : (
          <ul className="timeline">{w.supervisoryReviews.map((r, i) => <li key={i}><Badge value={r.decision} /> {r.reviewer} · {fmtDateTime(r.created_at)}<div>{r.notes}</div>{r.instructions && <div className="muted">Instructions: {r.instructions}</div>}{r.issue_categories.length > 0 && <div className="muted">{r.issue_categories.map(human).join(', ')}</div>}</li>)}</ul>
        )}
      </Panel>
    );
    case 'registrar': return (
      <Panel title={<>Registrar decision <Provenance of="registrar" /></>}>
        <p className="muted small">Read-only. Only the Land Registrar decides; the decision and its date come from the registrar's record.</p>
        {w.decisions.length === 0 ? <p className="muted">No decision recorded{['under_review', 'validating'].includes(a.status) ? ': awaiting the registrar' : ''}.</p> : (
          <table className="table"><thead><tr><th>Decision</th><th>Date</th><th>Registrar</th><th>Summary</th><th /></tr></thead>
            <tbody>{w.decisions.map((d, i) => <tr key={i}><td><Badge value={d.decision} /></td><td>{fmtDateTime(d.decided_at)}</td><td>{d.registrar}</td><td>{d.reason}</td><td>{d.superseded_at ? <span className="muted">superseded {fmtDateTime(d.superseded_at)}</span> : 'current'}</td></tr>)}</tbody></table>
        )}
      </Panel>
    );
    case 'timeline': return <TimelineTab id={a.id} />;
    case 'notes': return <NotesTab w={w} />;
    case 'audit': return (
      <Panel title="Audit history">
        {w.can.viewAudit ? <p>The full, tamper-evident audit trail of this application is in the <Link to={`/work/audit?caseId=${a.id}`}>audit log</Link>.</p>
          : <p className="muted">The audit trail is available to supervisors and auditors. The workflow timeline shows every recorded step of this application.</p>}
      </Panel>
    );
    default: return null;
  }
}

function Overview({ w, setTab }: { w: Workspace; setTab: (t: Tab) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const a = w.application;
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const r = await api<{ status: string }>(`/cases/${a.id}/submit`, { method: 'POST' });
      toast(r.status === 'under_review' ? 'success' : 'info', r.status === 'under_review' ? 'Submitted for review' : 'Returned by validation: see the findings on the case page');
      void qc.invalidateQueries({ queryKey: ['processor'] });
    } catch (e) {
      const missing = ((e as ApiError).details as { missing?: { label: string; state: string }[] } | undefined)?.missing;
      setError(missing ? `${(e as Error).message}` : (e as Error).message);
    }
  };
  const blockingSubmission = w.completeness?.blocking.submission ?? [];
  return (
    <>
      <Panel title="Where this application stands">
        <p className="small">{w.separation}</p>
        <div className="stat-grid">
          <div className="stat-card"><div className="stat-label">Stage</div><div className="stat-value small"><StageBadge stage={a.stage} /></div></div>
          <div className="stat-card"><div className="stat-label">Completeness</div><div className="stat-value small"><CompletenessBadge value={w.completeness?.status ?? null} /></div>
            <div className="stat-desc"><button className="link" onClick={() => setTab('completeness')}>Checklist</button></div></div>
          <div className="stat-card"><div className="stat-label">Documents</div><div className="stat-value">{w.documents.filter((d) => d.review_status !== 'superseded').length}</div>
            <div className="stat-desc">{w.documents.filter((d) => ['not_reviewed', 'under_review'].includes(d.review_status)).length} awaiting review</div></div>
          <div className="stat-card"><div className="stat-label">Open information requests</div><div className="stat-value">{w.infoRequests.filter((r) => ['pending', 'response_received', 'partially_satisfied'].includes(r.status)).length}</div></div>
          <div className="stat-card"><div className="stat-label">GIS</div><div className="stat-value small">{w.handoffs[0] ? `${w.handoffs[0].task_no}: ${human(w.handoffs[0].task_status)}` : 'Not handed off'}</div>
            <div className="stat-desc">{w.gis?.version_no ? `Geometry version ${w.gis.version_no}${w.gis.error_count !== null ? `, ${w.gis.error_count} error(s)` : ''}` : 'No geometry yet'}</div></div>
        </div>
      </Panel>
      <Panel title="Next actions">
        <ErrorBanner error={error} />
        <div className="chip-row">
          {w.can.upload && <button className="secondary" onClick={() => setTab('documents')}><Upload size={16} /> Documents</button>}
          {w.can.requestInformation && <button className="secondary" onClick={() => setTab('requests')}>Request information</button>}
          {w.can.handoff && <button className="secondary" onClick={() => setTab('gis')}>Hand off to GIS</button>}
          {w.can.submit && ['draft', 'returned'].includes(a.status) && a.intake_status === 'registered' && (
            <button disabled={blockingSubmission.length > 0} onClick={() => void submit()} title={blockingSubmission.length ? 'Required items are outstanding' : undefined}><Send size={16} /> Submit for review</button>
          )}
          <Link className="button secondary" to={`/work/cases/${a.id}`}>Open the case page</Link>
        </div>
        {blockingSubmission.length > 0 && <p className="muted small">Before submission: {blockingSubmission.map((b) => b.label).join(', ')}.</p>}
        {w.duplicateReviews.length > 0 && <p className="small">Registered despite similarity to {w.duplicateReviews.map((d) => d.similar_case_no).join(', ')}: {w.duplicateReviews[0].reason}</p>}
      </Panel>
    </>
  );
}

const DETAIL_FIELDS = {
  details: [['purpose', 'Purpose', 'textarea'], ['submissionDate', 'Submission date', 'date'], ['receivingOffice', 'Receiving office', 'text'],
    ['externalReference', 'Office receipt number', 'text'], ['titleDeedRef', 'Existing title or deed reference', 'text'], ['remarks', 'Remarks', 'textarea']],
  parcel: [['declaredParcelRef', 'Declared parcel identifier', 'text'], ['district', 'District', 'text'], ['locality', 'Community or locality', 'text'],
    ['declaredLandUse', 'Declared land use', 'text'], ['declaredArea', 'Declared size', 'number'], ['declaredAreaUnit', 'Unit (m2, ha, acre)', 'unit'],
    ['surveyReference', 'Survey reference', 'text'], ['locationDescription', 'Location description', 'textarea']],
} as const;
const COLUMN: Record<string, string> = {
  purpose: 'purpose', submissionDate: 'submission_date', receivingOffice: 'receiving_office', externalReference: 'external_reference', titleDeedRef: 'title_deed_ref',
  remarks: 'remarks', declaredParcelRef: 'declared_parcel_ref', district: 'district', locality: 'locality', declaredLandUse: 'declared_land_use',
  declaredArea: 'declared_area', declaredAreaUnit: 'declared_area_unit', surveyReference: 'survey_reference', locationDescription: 'location_description',
};

function DetailsEditor({ w, which }: { w: Workspace; which: 'details' | 'parcel' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const a = w.application as unknown as Record<string, unknown>;
  const fields = DETAIL_FIELDS[which];
  const initial = Object.fromEntries(fields.map(([k]) => [k, a[COLUMN[k]] === null || a[COLUMN[k]] === undefined ? '' : String(a[COLUMN[k]]).slice(0, k === 'submissionDate' ? 10 : undefined)]));
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const registered = w.application.intake_status === 'registered';
  const save = async () => {
    setError(null);
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== initial[k]).map(([k, v]) => [k, k === 'declaredArea' ? (v ? Number(v) : null) : v || null]));
    if (!Object.keys(changed).length) { setEditing(false); return; }
    if (changed.declaredArea !== undefined || changed.declaredAreaUnit !== undefined) { changed.declaredArea = values.declaredArea ? Number(values.declaredArea) : null; changed.declaredAreaUnit = values.declaredArea ? values.declaredAreaUnit || 'ha' : null; }
    try {
      await api(`/applications/${w.application.id}`, { method: 'PATCH', body: { ...changed, reason: reason || undefined } });
      toast('success', 'Saved; previous values are kept in the history');
      setEditing(false); setReason('');
      void qc.invalidateQueries({ queryKey: ['processor'] });
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Panel title={<>{which === 'details' ? 'Application details' : 'Declared parcel information'} <Provenance of={which === 'parcel' ? 'applicant' : 'processor'} /></>}
      actions={w.can.edit && !editing && <button className="secondary" onClick={() => { setValues(initial); setEditing(true); }}>Edit</button>}>
      {which === 'parcel' && <p className="small warn-text">Declared by the applicant and unverified. GIS officers establish the geometry; it is never drawn here.</p>}
      {which === 'parcel' && w.application.parcel_upi && <p className="small">Registered parcel concerned: <Link to={`/work/parcels/${w.application.parcel_upi}`}>{w.application.parcel_upi}</Link></p>}
      <ErrorBanner error={error} />
      {!editing ? (
        <dl className="facts">{fields.map(([k, l]) => <Fragment key={k}><dt>{l}</dt><dd>{initial[k] || <span className="muted">—</span>}</dd></Fragment>)}</dl>
      ) : (
        <div className="stack">
          <div className="form-grid">
            {fields.map(([k, l, type]) => (
              <label key={k} className={type === 'textarea' ? 'span-2' : ''}>{l}
                {type === 'textarea' ? <textarea rows={2} value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
                  : type === 'unit' ? <select value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })}><option value="">—</option><option value="m2">m2</option><option value="ha">ha</option><option value="acre">acre</option></select>
                  : <input type={type} value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />}
              </label>
            ))}
          </div>
          {registered && <label>Reason for the change (required for a registered application) <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
          <div className="chip-row"><button className="secondary" onClick={() => setEditing(false)}>Cancel</button><button disabled={registered && reason.trim().length < 5} onClick={() => void save()}>Save</button></div>
        </div>
      )}
    </Panel>
  );
}

function DocumentsTab({ w, reviewOnly = false }: { w: Workspace; reviewOnly?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const docs = w.documents.filter((d) => (showOld || d.review_status !== 'superseded') && (!reviewOnly || d.review_status !== 'superseded'));
  return (
    <Panel title={reviewOnly ? 'Document verification' : 'Supporting documents'}
      actions={<>{!reviewOnly && w.can.upload && <button onClick={() => setUpload(true)}><Upload size={16} /> Upload a document</button>}
        {!reviewOnly && <label className="check small"><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> Show superseded versions</label>}</>}>
      {reviewOnly && <p className="muted small">Administrative review only: readable, complete and consistent with the application. It does not establish legal validity. Refer legal questions instead of deciding them.</p>}
      {docs.length === 0 ? <EmptyState title="No documents yet" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Document</th><th>Category</th><th>Title</th><th>Version</th><th>Review</th><th>Reviewer</th><th>Uploaded</th><th>Size</th></tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={d.id} className="row-click" tabIndex={0} onClick={() => setOpen(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(d.id); }}>
              <td>{d.document_no}</td><td>{d.doc_label}</td><td>{d.restricted ? <em className="muted">hidden</em> : d.title ?? '—'}</td><td>{d.version_no}</td>
              <td><ReviewBadge status={d.review_status} />{d.last_review?.referred && <> <Badge value="escalated" label="referred" /></>}</td>
              <td className="small">{d.last_review ? `${d.last_review.by}, ${fmtDateTime(d.last_review.at)}` : '—'}{d.last_review?.note && <div className="muted">{d.last_review.note}</div>}</td>
              <td className="small">{fmtDateTime(d.uploaded_at)}<div className="muted">{d.uploaded_by}</div></td><td>{fmtBytes(d.size_bytes)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && <DocumentViewer id={open} onClose={() => setOpen(null)} />}
      {upload && <UploadDocumentModal open caseId={w.application.id} onClose={() => setUpload(false)} />}
    </Panel>
  );
}

function CompletenessTab({ w }: { w: Workspace }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [keys, setKeys] = useState<string[]>([]);
  const [stage, setStage] = useState<'gis_handoff' | 'submission'>('gis_handoff');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!w.completeness) return <Panel><EmptyState title="Not an intake application">Completeness applies to applications registered through intake.</EmptyState></Panel>;
  const outstanding = w.completeness.items.filter((i) => i.applies && i.mandatory && i.state !== 'complete');
  const grant = async () => {
    setError(null);
    try { await api(`/applications/${w.application.id}/exceptions`, { body: { stage, requirementKeys: keys, reason } }); toast('success', 'Exception recorded'); setKeys([]); setReason(''); void qc.invalidateQueries({ queryKey: ['processor'] }); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <Panel title="Completeness checklist"><CompletenessChecklist data={w.completeness} /></Panel>
      {w.exceptions.length > 0 && (
        <Panel title="Exceptions">
          <ul className="timeline">{w.exceptions.map((e) => <li key={e.id}><strong>{human(e.stage)}</strong>: {e.requirement_keys.join(', ')} · granted by {e.granted_by} · {fmtDateTime(e.granted_at)}<div>{e.reason}</div></li>)}</ul>
        </Panel>
      )}
      {w.can.grantException && outstanding.length > 0 && (
        <Panel title="Grant an exception (supervisor)">
          <p className="small muted">Waives named requirements for one stage, with a justification. Recorded, audited and shown to everyone; it never makes an application legally valid.</p>
          <ErrorBanner error={error} />
          <div className="check-grid">{outstanding.map((i) => <label key={i.req_key} className="check"><input type="checkbox" checked={keys.includes(i.req_key)} onChange={(e) => setKeys(e.target.checked ? [...keys, i.req_key] : keys.filter((k) => k !== i.req_key))} /> {i.label}</label>)}</div>
          <label>Stage <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}><option value="gis_handoff">GIS handoff</option><option value="submission">Submission for review</option></select></label>
          <label>Justification (20+ characters) <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button disabled={!keys.length || reason.trim().length < 20} onClick={() => void grant()}>Grant exception</button>
        </Panel>
      )}
    </>
  );
}

function RequestsTab({ w }: { w: Workspace }) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel title="Additional information requests" actions={w.can.requestInformation && <button onClick={() => setCreating(true)}>New request</button>}>
      {w.infoRequests.length === 0 ? <EmptyState title="No requests" /> : (
        <table className="table"><thead><tr><th>Request</th><th>Requested</th><th>Channel</th><th>Status</th><th>Due</th><th>Created</th></tr></thead>
          <tbody>{w.infoRequests.map((r) => (
            <tr key={r.id} className="row-click" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r.id); }}>
              <td>{r.request_no}</td><td className="small">{r.items}</td><td className="small">{human(r.channel)}<div className="muted">{DELIVERY_LABELS[r.delivery_status]}</div></td>
              <td><RequestStatusBadge r={r} /></td><td>{r.due_date?.slice(0, 10) ?? '—'}</td><td>{fmtDateTime(r.created_at)} · {r.requested_by}</td>
            </tr>
          ))}</tbody></table>
      )}
      {creating && <CreateInfoRequestModal open caseId={w.application.id} onClose={() => setCreating(false)} />}
      {open && <InfoRequestDrawer id={open} documents={w.documents} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

interface HandoffCheck { ready: boolean; items: { key: string; label: string; ok: boolean; warning?: boolean; detail: string }[]; exceptions: string[] }

function GisTab({ w }: { w: Workspace }) {
  const qc = useQueryClient();
  const toast = useToast();
  const check = useQuery({ queryKey: ['processor', 'handoff-check', w.application.id], queryFn: () => api<HandoffCheck>(`/applications/${w.application.id}/handoff-check`), enabled: !!w.completeness });
  const staff = useQuery({ queryKey: ['processor', 'staff', w.application.id], queryFn: () => api<{ id: string; username: string; display_name: string; role: string }[]>(`/applications/${w.application.id}/staff`), enabled: w.can.handoff });
  const [form, setForm] = useState({ taskType: 'gis_preparation', assigneeId: '', instructions: '', priority: 'normal', dueDate: '', documentIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setError(null);
    try {
      const r = await api<{ handoffNo: string; taskNo: string }>(`/applications/${w.application.id}/handoff`, { body: { ...form, assigneeId: form.assigneeId || null, dueDate: form.dueDate || undefined } });
      toast('success', `${r.handoffNo}: GIS task ${r.taskNo} created`);
      void qc.invalidateQueries({ queryKey: ['processor'] });
    } catch (e) { setError((e as Error).message); }
  };
  const docs = w.documents.filter((d) => d.review_status !== 'superseded');
  return (
    <>
      <Panel title={<>GIS processing <Provenance of="gis" /></>}>
        <p className="muted small">GIS officers do the spatial work. Processors never upload or edit geometry; the handoff passes the application, its documents and instructions.</p>
        {w.gis?.version_no ? <p className="small">Working geometry version {w.gis.version_no} ({w.gis.feature_count} feature(s), EPSG:{w.gis.declared_srid}){w.gis.validated_at && `, validated ${fmtDateTime(w.gis.validated_at)}: ${w.gis.error_count} error(s), ${w.gis.warning_count} warning(s)`}.</p> : <p className="small">No geometry imported yet.</p>}
        {w.handoffs.length > 0 && (
          <table className="table"><thead><tr><th>Handoff</th><th>GIS task</th><th>Status</th><th>GIS officer</th><th>Instructions</th><th>Handed off</th></tr></thead>
            <tbody>{w.handoffs.map((h) => <tr key={h.id}><td>{h.handoff_no}{h.with_exception && <div className="muted small">with exception</div>}</td><td>{h.task_no}</td><td><Badge value={h.task_status} /></td>
              <td>{h.gis_officer ?? 'county queue'}</td><td className="small">{h.instructions}{h.last_clarification && <div className="warn-text">Clarification asked: {h.last_clarification}</div>}</td><td>{fmtDateTime(h.created_at)} · {h.processor}</td></tr>)}</tbody></table>
        )}
      </Panel>
      {w.can.handoff && w.completeness && (
        <Panel title="Hand off to GIS processing">
          <QueryState query={check}>
            {(c) => (
              <>
                <ul className="check-list">{c.items.map((i) => <li key={i.key}>{i.ok ? (i.warning ? '⚠️' : '✅') : '❌'} <strong>{i.label}</strong>: {i.detail}</li>)}</ul>
                {c.exceptions.length > 0 && <p className="small">Exceptions in force: {c.exceptions.join(', ')}</p>}
                <ErrorBanner error={error} />
                <div className="form-grid">
                  <label>GIS task type
                    <select value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value })}>
                      <option value="gis_preparation">GIS data preparation</option><option value="gis_validation_correction">GIS validation correction</option><option value="attribute_verification">Attribute verification</option>
                    </select>
                  </label>
                  <label>GIS officer
                    <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                      <option value="">County GIS queue (any GIS officer may claim it)</option>
                      {staff.data?.filter((s) => s.role === 'gis_officer').map((s) => <option key={s.id} value={s.id}>{s.display_name} ({s.username})</option>)}
                    </select>
                  </label>
                  <label>Priority <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
                  <label>Due date (optional) <input type="date" value={form.dueDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
                </div>
                <label>Processing instructions <textarea rows={3} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="What the GIS officer should do, and any open administrative issues" /></label>
                {docs.length > 0 && <div className="check-grid">{docs.map((d) => <label key={d.id} className="check"><input type="checkbox" checked={form.documentIds.includes(d.id)} onChange={(e) => setForm({ ...form, documentIds: e.target.checked ? [...form.documentIds, d.id] : form.documentIds.filter((x) => x !== d.id) })} /> {d.document_no} {d.doc_label}</label>)}</div>}
                <button disabled={!c.ready || form.instructions.trim().length < 10} onClick={() => void send()}>Hand off to GIS</button>
                {!c.ready && <p className="muted small">Resolve the items marked ❌ first (or ask a supervisor for a justified exception).</p>}
              </>
            )}
          </QueryState>
        </Panel>
      )}
    </>
  );
}

function TimelineTab({ id }: { id: string }) {
  const events = useQuery({ queryKey: ['processor', 'timeline', id], queryFn: () => api<TimelineEvent[]>(`/applications/${id}/timeline`) });
  return <Panel title="Workflow timeline"><p className="muted small">Generated from the stored events of the application, its documents, requests, GIS tasks, reviews and decisions.</p><QueryState query={events}>{(e) => <Timeline events={e} />}</QueryState></Panel>;
}

function NotesTab({ w }: { w: Workspace }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try { await api(`/applications/${w.application.id}/notes`, { body: { note } }); setNote(''); void qc.invalidateQueries({ queryKey: ['processor'] }); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Panel title="Administrative notes">
      {w.can.note && (<><ErrorBanner error={error} /><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" /><button disabled={note.trim().length < 3} onClick={() => void add()}>Add note</button></>)}
      {w.notes.length === 0 ? <p className="muted">No notes.</p> : <ul className="timeline">{w.notes.map((n) => <li key={n.id}><strong>{n.author}</strong> · {fmtDateTime(n.at)}<div>{n.note}</div></li>)}</ul>}
      <p className="muted small">Notes cannot be edited or deleted.</p>
    </Panel>
  );
}
