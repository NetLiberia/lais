import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, human } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Section, useAction, useLoad } from '../components/ui';
import type { DocumentRequestDetailResponse, DocumentRequestRow } from '../types';

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Awaiting preparation',
  prepared: 'Awaiting decision',
  approved: 'Approved',
  refused: 'Refused',
  withdrawn: 'Withdrawn',
};

function RequestStatus({ status }: { status: string }) {
  const tone = status === 'approved' ? 's-published' : status === 'refused' || status === 'withdrawn' ? 's-rejected' : status === 'prepared' ? 's-under_review' : 's-draft';
  return <span className={`pill ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

/** Queue of landowner document requests within the officer's jurisdiction. */
export function DocumentRequestList() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState(hasRole('registrar') ? 'prepared' : hasRole('processor') ? 'submitted' : '');
  const { data, error } = useLoad(() => api<DocumentRequestRow[]>(`/document-requests${status ? `?status=${status}` : ''}`), [status]);
  return (
    <div className="page">
      <h1>Document requests</h1>
      <p className="muted">Requests from landowners for copies of documents. A processor prepares what can be released; a different registrar decides.</p>
      <div className="row">
        <label>Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      {data?.length === 0 && <p className="muted">No requests.</p>}
      {data && data.length > 0 && (
        <table className="table clickable">
          <thead><tr><th>Request</th><th>Parcel</th><th>County</th><th>Requested by</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} onClick={() => navigate(`/work/document-requests/${r.id}`)}>
                <td><Link to={`/work/document-requests/${r.id}`}>{r.request_no}</Link></td>
                <td>{r.parcel_upi}</td>
                <td>{r.county_code}</td>
                <td>{r.requested_by_name}</td>
                <td><RequestStatus status={r.status} /></td>
                <td>{fmtDate(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DocumentRequestDetail() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api<DocumentRequestDetailResponse>(`/document-requests/${id}`), [id]);
  const action = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'approved' | 'refused'>('approved');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (data) setSelected(data.candidates.filter((c) => c.selected).map((c) => c.id));
  }, [data]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <p className="pad muted">Loading…</p>;
  const r = data.request;
  const preparing = data.allowedActions.includes('prepare');
  const deciding = data.allowedActions.includes('decide');
  const after = async (ok: boolean) => { if (ok) await reload(); };

  const prepare = async (e: FormEvent) => {
    e.preventDefault();
    await after(await action.run(() => api(`/document-requests/${id}/prepare`, { body: { documentIds: selected, note } })));
  };
  const decide = async (e: FormEvent) => {
    e.preventDefault();
    await after(await action.run(() => api(`/document-requests/${id}/decide`, { body: { decision, reason } })));
  };
  const toggle = (docId: string) => setSelected((cur) => (cur.includes(docId) ? cur.filter((x) => x !== docId) : [...cur, docId]));
  const shown = preparing ? data.candidates : data.candidates.filter((c) => c.selected);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{r.request_no} <RequestStatus status={r.status} /></h1>
          <p className="muted">Parcel <Link to={`/work/parcels/${r.parcel_upi}`}>{r.parcel_upi}</Link> · {r.county_name}</p>
        </div>
      </div>
      {data.separationNotice && <div className="alert info">{data.separationNotice}</div>}
      {!r.interest_current && ['submitted', 'prepared'].includes(r.status) && (
        <div className="alert error">The requester no longer holds the registered interest that made them eligible. Refuse this request.</div>
      )}
      <ErrorBox error={action.error} />

      <div className="grid-2">
        <div className="stack">
          <Section title="Request">
            <dl className="facts">
              <dt>Requested by</dt><dd>{r.requested_by_name} <span className="muted small">({r.requested_by_username})</span></dd>
              <dt>Eligible through</dt><dd>{r.party_name}</dd>
              <dt>Received</dt><dd>{fmtDate(r.created_at)}</dd>
              <dt>Documents asked for</dt><dd>{r.document_types.map(human).join(', ')}</dd>
              <dt>Purpose</dt><dd>{r.purpose}</dd>
            </dl>
          </Section>
          <Section title="Handling">
            <dl className="facts">
              <dt>Prepared</dt><dd>{r.prepared_by_username ? `${r.prepared_by_username}, ${fmtDate(r.prepared_at)}` : '—'}</dd>
              {r.preparation_note && <><dt>Preparation note</dt><dd>{r.preparation_note}</dd></>}
              <dt>Decision</dt><dd>{r.decided_by_username ? `${r.status} by ${r.decided_by_username}, ${fmtDate(r.decided_at)}` : '—'}</dd>
              {r.decision_reason && <><dt>Reason (shown to requester)</dt><dd>{r.decision_reason}</dd></>}
              {r.release_expires_at && <><dt>Release ends</dt><dd>{fmtDate(r.release_expires_at)}</dd></>}
            </dl>
          </Section>
        </div>

        <div className="stack">
          <Section title={preparing ? 'Choose documents to release' : 'Documents in the release'}>
            {shown.length === 0 ? <p className="muted">{preparing ? 'No verified documents from published cases are held for this parcel.' : 'None.'}</p> : (
              <table className="table">
                <thead><tr>{preparing && <th />}<th>Type</th><th>Reference</th><th>Class</th><th>From case</th></tr></thead>
                <tbody>
                  {shown.map((d) => (
                    <tr key={d.id} className={d.releasable ? '' : 'muted'}>
                      {preparing && (
                        <td>
                          <input type="checkbox" aria-label={`Release ${human(d.doc_type)} ${d.reference_no ?? ''}`} disabled={!d.releasable}
                            checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
                        </td>
                      )}
                      <td>{human(d.doc_type)}{!d.releasable && <div className="small danger">never released online</div>}</td>
                      <td>{d.reference_no ?? '—'}{d.issuer && <div className="small muted">{d.issuer}</div>}</td>
                      <td><span className={`pill c-${d.classification}`}>{human(d.classification)}</span></td>
                      <td className="small">{d.case_no}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preparing && (
              <form onSubmit={prepare} className="stack compact">
                <label>Note for the registrar (what was checked, why these documents)
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={5} required />
                </label>
                <button type="submit" disabled={action.busy}>Send to registrar ({selected.length} document{selected.length === 1 ? '' : 's'})</button>
                <p className="small muted">If nothing suitable is held, send with no documents selected and explain why; the registrar will refuse with a reason.</p>
              </form>
            )}
          </Section>

          {deciding && (
            <Section title="Decision">
              <form onSubmit={decide} className="stack">
                <div className="row wrap">
                  <label className="inline"><input type="radio" checked={decision === 'approved'} onChange={() => setDecision('approved')} /> Approve release</label>
                  <label className="inline"><input type="radio" checked={decision === 'refused'} onChange={() => setDecision('refused')} /> Refuse</label>
                </div>
                <label>Reason (shown to the requester)
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
                </label>
                <button type="submit" disabled={action.busy}>Record decision</button>
              </form>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
