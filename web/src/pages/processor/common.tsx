import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Download, FileWarning, Flag, Upload, XCircle } from 'lucide-react';
import { api, ApiError, getCsrfToken } from '../../api';
import { Badge, Drawer, ErrorBanner, fmtDateTime, Modal, QueryState, useToast } from '../../components/kit';
import type { CompletenessResult, DocReviewStatus, DocumentCategory, DocumentDetailResponse, TimelineEvent } from '../../types';

export const STAGE_LABELS: Record<string, string> = {
  registration_draft: 'Registration draft', document_review: 'Document review', awaiting_information: 'Awaiting additional information',
  ready_for_gis: 'Ready for GIS processing', awaiting_gis: 'Awaiting GIS processing', gis_processing: 'GIS processing', gis_complete: 'GIS work done',
  ready_for_submission: 'Ready for submission', under_review: 'Under supervisor or registrar review', returned: 'Returned for correction',
  approved: 'Approved by the registrar', rejected: 'Rejected by the registrar', published: 'Published', withdrawn: 'Withdrawn', in_preparation: 'In preparation',
};
const STAGE_TONES: Record<string, string> = {
  registration_draft: 'not_submitted', document_review: 'warning', awaiting_information: 'awaiting_review', ready_for_gis: 'info_requested', awaiting_gis: 'assigned',
  gis_processing: 'in_progress', gis_complete: 'passed', ready_for_submission: 'passed', under_review: 'under_review', returned: 'returned', approved: 'approved',
  rejected: 'rejected', published: 'published', withdrawn: 'withdrawn', in_preparation: 'not_submitted',
};
export const StageBadge = ({ stage }: { stage: string }) => <Badge value={STAGE_TONES[stage] ?? 'muted'} label={STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ')} />;

export const COMPLETENESS_LABELS: Record<string, string> = {
  draft: 'Draft', awaiting_information: 'Awaiting information', incomplete: 'Incomplete', ready_for_review: 'Ready for review', complete: 'Administratively complete',
};
const COMPLETENESS_TONES: Record<string, string> = { draft: 'not_submitted', awaiting_information: 'awaiting_review', incomplete: 'warning', ready_for_review: 'info_requested', complete: 'passed' };
export const CompletenessBadge = ({ value }: { value: string | null }) => (value ? <Badge value={COMPLETENESS_TONES[value] ?? 'muted'} label={COMPLETENESS_LABELS[value] ?? value} /> : <span className="muted">—</span>);

export const REVIEW_LABELS: Record<DocReviewStatus, string> = {
  not_reviewed: 'Not reviewed', under_review: 'Under review', accepted: 'Accepted for administrative completeness', incomplete: 'Incomplete',
  unreadable: 'Unreadable', inconsistent: 'Inconsistent information', requires_clarification: 'Requires clarification', superseded: 'Superseded',
};
const REVIEW_TONES: Record<DocReviewStatus, string> = {
  not_reviewed: 'not_submitted', under_review: 'in_progress', accepted: 'passed', incomplete: 'warning', unreadable: 'failed', inconsistent: 'failed',
  requires_clarification: 'awaiting_review', superseded: 'superseded',
};
export const ReviewBadge = ({ status }: { status: DocReviewStatus }) => <Badge value={REVIEW_TONES[status]} label={REVIEW_LABELS[status]} />;

export const human = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');
export const qs = (...parts: (string | false | null | undefined | 0)[]) => { const p = parts.filter(Boolean); return p.length ? `?${p.join('&')}` : ''; };
export const fmtBytes = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------------------------------------------------------------------------
// Completeness checklist
// ---------------------------------------------------------------------------

const STATE_ICON = {
  complete: <CheckCircle2 size={16} className="ok-text" aria-label="complete" />,
  received: <CircleDashed size={16} className="muted" aria-label="received, not reviewed" />,
  missing: <XCircle size={16} className="warn-text" aria-label="missing" />,
  unreadable: <FileWarning size={16} className="warn-text" aria-label="unreadable" />,
  incomplete: <FileWarning size={16} className="warn-text" aria-label="incomplete" />,
  clarification: <Flag size={16} className="warn-text" aria-label="needs clarification" />,
};
const STATE_TEXT: Record<string, string> = {
  complete: 'Complete', received: 'Received, awaiting review', missing: 'Missing', unreadable: 'Unreadable', incomplete: 'Incomplete', clarification: 'Needs clarification',
};

export function CompletenessChecklist({ data }: { data: CompletenessResult }) {
  const stages = ['registration', 'gis_handoff', 'submission'] as const;
  const stageLabel = { registration: 'Needed to register', gis_handoff: 'Needed before GIS processing', submission: 'Needed before submission for review' };
  return (
    <div className="stack">
      <p><CompletenessBadge value={data.status} /> <span className="muted small">{data.notice}</span></p>
      {stages.map((st) => {
        const items = data.items.filter((i) => i.stage === st && i.applies);
        if (!items.length) return null;
        return (
          <div key={st}>
            <h3 className="small-heading">{stageLabel[st]}</h3>
            <ul className="check-list">
              {items.map((i) => (
                <li key={i.req_key}>
                  {i.waived_for.length ? <CheckCircle2 size={16} className="muted" aria-label="waived" /> : STATE_ICON[i.state]}
                  <strong>{i.label}</strong>
                  <span className="muted small">({i.kind === 'document' ? 'document' : 'information'}{i.mandatory ? ', required' : ', optional'})</span>
                  <span className="small">{STATE_TEXT[i.state]}</span>
                  {i.waived_for.length > 0 && <Badge value="info_requested" label={`exception for ${i.waived_for.join(', ').replace(/_/g, ' ')}`} />}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline (from stored events)
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  case: 'Application', document: 'Document review', info_request: 'Information request', gis: 'GIS processing', supervision: 'Supervisor', registrar: 'Registrar',
  exception: 'Exception', note: 'Note',
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="muted">No events recorded yet.</p>;
  return (
    <ol className="workflow-timeline">
      {events.map((e, i) => (
        <li key={i} className={`tl-${e.source}`}>
          <div className="tl-head">
            <Badge value={e.source === 'registrar' ? 'approved' : e.source === 'supervision' ? 'under_review' : e.source === 'gis' ? 'assigned' : 'muted'} label={SOURCE_LABELS[e.source] ?? e.source} />
            <strong>{human(e.event)}</strong>
            <span className="muted small">{fmtDateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}</span>
          </div>
          {(e.from_status || e.to_status) && <div className="small">{human(e.from_status)} → {human(e.to_status)}</div>}
          {e.note && <div className="small">{e.note}</div>}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Upload (drag and drop, progress, failure recovery)
// ---------------------------------------------------------------------------

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff';

function uploadWithProgress(url: string, form: FormData, onProgress: (pct: number) => void): Promise<{ id: string; document_no: string; version_no: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    xhr.withCredentials = true;
    const csrf = getCsrfToken();
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
      else reject(new ApiError(xhr.status, body.error ?? `Upload failed (${xhr.status})`, undefined, body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload was interrupted (network). Nothing was stored; try again.'));
    xhr.send(form);
  });
}

export function UploadDocumentModal({ open, caseId, onClose, replace }: {
  open: boolean; caseId: string; onClose: () => void; replace?: { id: string; document_no: string; doc_type: string; classification: string };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useQuery({ queryKey: ['document-categories'], queryFn: () => api<DocumentCategory[]>('/document-categories'), enabled: open, staleTime: 300_000 });
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState(replace?.doc_type ?? '');
  const [classification, setClassification] = useState(replace?.classification ?? 'restricted');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setFile(null); setTitle(''); setDescription(''); setReferenceNo(''); setReason(''); setProgress(null); setError(null); setDocType(replace?.doc_type ?? ''); setClassification(replace?.classification ?? 'restricted'); } }, [open, replace]);
  useEffect(() => { if (docType === 'id_document') setClassification('highly_sensitive'); }, [docType]);
  const tooBig = file && file.size > 10 * 1024 * 1024;
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); };
  const send = async () => {
    if (!file) return;
    const form = new FormData();
    form.append('docType', docType);
    form.append('classification', classification);
    if (title) form.append('title', title);
    if (description) form.append('description', description);
    if (referenceNo) form.append('referenceNo', referenceNo);
    if (replace) { form.append('supersedesId', replace.id); form.append('replacementReason', reason); }
    form.append('file', file);
    setError(null); setProgress(0);
    try {
      const r = await uploadWithProgress(`/applications/${caseId}/documents`, form, setProgress);
      toast('success', replace ? `${r.document_no} (version ${r.version_no}) replaces ${replace.document_no}` : `${r.document_no} uploaded`);
      void qc.invalidateQueries({ queryKey: ['processor'] });
      onClose();
    } catch (e) { setError((e as Error).message); setProgress(null); }
  };
  return (
    <Modal open={open} title={replace ? `Replace ${replace.document_no} with a new version` : 'Upload a document'} onClose={onClose}
      footer={<><button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={!file || !docType || !!tooBig || progress !== null || (!!replace && reason.trim().length < 5)} onClick={() => void send()}>
          <Upload size={16} /> {progress !== null ? `Uploading… ${progress}%` : 'Upload'}</button></>}>
      <ErrorBanner error={error} />
      {replace && <p className="small">The current version stays in the record as <em>superseded</em>; nothing is overwritten.</p>}
      <div className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }} aria-label="Choose or drop a file">
        <Upload size={20} aria-hidden />
        <span>{file ? `${file.name} (${fmtBytes(file.size)})` : 'Drop a PDF, PNG, JPEG or TIFF here, or click to choose'}</span>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="doc-file" />
      </div>
      {tooBig && <p className="warn-text small">The file is larger than 10 MB.</p>}
      <p className="muted small">The file type is checked from its content, not its name. Files are stored privately and never published.</p>
      {progress !== null && <progress max={100} value={progress} aria-label="Upload progress" />}
      <div className="form-grid">
        <label>Document category
          <select value={docType} onChange={(e) => setDocType(e.target.value)} disabled={!!replace}>
            <option value="">Choose</option>
            {categories.data?.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </label>
        <label>Access classification
          <select value={classification} onChange={(e) => setClassification(e.target.value)} disabled={docType === 'id_document'}>
            <option value="public">Public</option><option value="restricted">Restricted</option><option value="highly_sensitive">Highly sensitive</option>
          </select>
        </label>
        <label>Title (optional) <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
        <label>Reference number (optional) <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} maxLength={100} /></label>
      </div>
      <label>Description (optional) <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></label>
      {replace && <label>Reason for replacing (required) <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Document viewer: preview (in memory, never a permanent link), versions, review history, review actions
// ---------------------------------------------------------------------------

export function DocumentViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['processor', 'document', id], queryFn: () => api<DocumentDetailResponse>(`/documents/${id}`) });
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<DocReviewStatus>('accepted');
  const [note, setNote] = useState('');
  const [checks, setChecks] = useState({ readable: false, pagesPresent: false, requiredInformation: false, matchesApplication: false });
  const [refer, setRefer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const fetchFile = async () => {
    const res = await fetch(`/api/documents/${id}/file`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: `Refused (${res.status})` }))).error);
    return res.blob();
  };
  const showPreview = async () => {
    setPreviewError(null);
    try { setPreview(URL.createObjectURL(await fetchFile())); } catch (e) { setPreviewError((e as Error).message); }
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await fetchFile());
      const a = document.createElement('a');
      a.href = url; a.download = detail.data?.document.original_name ?? detail.data?.document.document_no ?? 'document'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast('error', (e as Error).message); }
  };
  const submitReview = async () => {
    setError(null);
    try {
      await api(`/documents/${id}/review`, { body: { status, note: note || undefined, checks, refer } });
      toast('success', 'Review recorded');
      setNote(''); setRefer(false);
      void qc.invalidateQueries({ queryKey: ['processor'] });
    } catch (e) { setError((e as Error).message); }
  };
  const d = detail.data?.document;
  return (
    <Drawer open title={d ? `${d.document_no} · version ${d.version_no}` : 'Document'} subtitle={d && <ReviewBadge status={d.review_status} />} onClose={onClose}>
      <QueryState query={detail}>
        {(r) => (
          <div className="stack small">
            <dl className="facts">
              <dt>Application</dt><dd>{r.document.case_no}</dd>
              <dt>Category</dt><dd>{r.document.doc_label ?? r.document.doc_type}</dd>
              <dt>Title</dt><dd>{r.document.restricted ? <em>hidden (highly sensitive)</em> : r.document.title ?? '—'}</dd>
              <dt>File</dt><dd>{r.document.restricted ? '—' : r.document.original_name} · {r.document.mime_type} · {fmtBytes(r.document.size_bytes)}</dd>
              <dt>Classification</dt><dd><Badge value={r.document.classification === 'highly_sensitive' ? 'danger' : 'muted'} label={human(r.document.classification)} /></dd>
              <dt>Uploaded</dt><dd>{fmtDateTime(r.document.uploaded_at)} by {r.document.uploaded_by}</dd>
              <dt>SHA-256</dt><dd><code>{r.document.sha256.slice(0, 24)}…</code></dd>
            </dl>
            <p className="muted">{r.notice}</p>
            <div className="chip-row">
              {r.can.download && r.document.previewable && <button className="secondary" onClick={() => void showPreview()}>Preview</button>}
              {r.can.download && <button className="secondary" onClick={() => void download()}><Download size={16} /> Download</button>}
              {!r.can.download && <span className="muted">You may not open this document (classification {human(r.document.classification)}).</span>}
              {r.can.replace && <button className="secondary" onClick={() => setReplacing(true)}>Upload a new version</button>}
            </div>
            <ErrorBanner error={previewError} />
            {preview && (r.document.mime_type === 'application/pdf'
              ? <iframe className="doc-preview" src={preview} title={`Preview of ${r.document.document_no}`} />
              : <div className="doc-preview-image"><img src={preview} alt={`Preview of ${r.document.document_no}`} /></div>)}
            {!r.document.previewable && r.can.download && <p className="muted">This file type (TIFF) cannot be shown in the browser; download it to view.</p>}

            <h3>Versions</h3>
            <table className="table"><thead><tr><th>Version</th><th>Document</th><th>Status</th><th>Uploaded</th><th>Reason</th></tr></thead>
              <tbody>{r.versions.map((v) => <tr key={v.id} className={v.id === id ? 'changed' : ''}><td>{v.version_no}</td><td>{v.document_no}</td><td><ReviewBadge status={v.review_status} /></td><td>{fmtDateTime(v.uploaded_at)} · {v.uploaded_by}</td><td>{v.replacement_reason ?? '—'}</td></tr>)}</tbody></table>

            <h3>Review history</h3>
            {r.history.length === 0 ? <p className="muted">Not reviewed yet.</p> : (
              <ul className="timeline">{r.history.map((h, i) => (
                <li key={i}><strong>{REVIEW_LABELS[h.to_status as DocReviewStatus] ?? h.to_status}</strong> · {h.reviewer} · {fmtDateTime(h.at)}{h.referred && <> · <Badge value="escalated" label="referred for decision" /></>}
                  {h.note && <div>{h.note}</div>}
                  {Object.keys(h.checks ?? {}).length > 0 && <div className="muted">{Object.entries(h.checks).map(([k, v]) => `${human(k)}: ${v ? 'yes' : 'no'}`).join(' · ')}</div>}</li>
              ))}</ul>
            )}

            {r.can.review && r.document.review_status !== 'superseded' && (
              <>
                <h3>Record a review</h3>
                <ErrorBanner error={error} />
                <div className="check-grid">
                  {([['readable', 'Readable'], ['pagesPresent', 'Required pages present'], ['requiredInformation', 'Required information present'], ['matchesApplication', 'Details match the application']] as const).map(([k, l]) => (
                    <label key={k} className="check"><input type="checkbox" checked={checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {l}</label>
                  ))}
                </div>
                <label>Outcome
                  <select value={status} onChange={(e) => setStatus(e.target.value as DocReviewStatus)}>
                    {(['under_review', 'accepted', 'incomplete', 'unreadable', 'inconsistent', 'requires_clarification'] as DocReviewStatus[]).map((s) => <option key={s} value={s}>{REVIEW_LABELS[s]}</option>)}
                  </select>
                </label>
                <label>Note {['incomplete', 'unreadable', 'inconsistent', 'requires_clarification'].includes(status) ? '(reason required)' : '(optional)'}
                  <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <label className="check"><input type="checkbox" checked={refer} onChange={(e) => setRefer(e.target.checked)} /> Refer for an authorized (legal) decision instead of judging it here</label>
                {r.document.uploaded_by_id && <p className="muted">The officer who uploaded a document cannot record its acceptance or rejection.</p>}
                <button onClick={() => void submitReview()}>Record review</button>
              </>
            )}
            {replacing && <UploadDocumentModal open caseId={r.document.case_id} replace={{ id: r.document.id, document_no: r.document.document_no, doc_type: r.document.doc_type, classification: r.document.classification }} onClose={() => { setReplacing(false); void qc.invalidateQueries({ queryKey: ['processor'] }); }} />}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}
