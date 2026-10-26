import { useState, type FormEvent } from 'react';
import { api, fmtDate, human } from '../api';
import { ParcelMap } from '../components/ParcelMap';
import { ErrorBox, Section, useAction, useLoad } from '../components/ui';

const REQUESTABLE = [
  { value: 'deed', label: 'Deed or title document' },
  { value: 'survey_plan', label: 'Survey plan' },
  { value: 'customary_certificate', label: 'Customary land certificate' },
  { value: 'power_of_attorney', label: 'Power of attorney' },
  { value: 'other', label: 'Other supporting document' },
];

const REQUEST_STATUS: Record<string, string> = {
  submitted: 'Received, awaiting preparation',
  prepared: 'Prepared, awaiting a decision',
  approved: 'Approved',
  refused: 'Refused',
  withdrawn: 'Withdrawn',
};

/** Landowner portal: registered interests of the parties linked to this account, and document requests. */
export function MyParcels() {
  const parcels = useLoad(() => api<any[]>('/me/parcels'));
  const requests = useLoad(() => api<any[]>('/me/document-requests'));
  const [requesting, setRequesting] = useState<string | null>(null);

  return (
    <div className="page">
      <h1>My registered interests</h1>
      <p className="muted">
        This list shows interests registered to the people linked to your account after identity checks. Your account itself is not proof of ownership.
      </p>
      <ErrorBox error={parcels.error ?? requests.error} />
      {parcels.data?.length === 0 && <p>No registered interests are linked to your account.</p>}
      <div className="grid-2">
        <div className="stack">
          {parcels.data?.map((p) => (
            <Section
              key={p.upi}
              title={p.upi}
              actions={requesting !== p.upi && <button className="secondary" onClick={() => setRequesting(p.upi)}>Request documents</button>}
            >
              <dl className="facts">
                <dt>County</dt><dd>{p.county}</dd>
                <dt>Category / use</dt><dd>{human(p.land_category)} · {p.land_use ?? '—'}</dd>
                <dt>Calculated area</dt><dd>{Number(p.area_m2_calculated).toLocaleString()} m²</dd>
                <dt>Record status</dt><dd>{p.status === 'disputed' ? 'under dispute' : 'registered'}</dd>
              </dl>
              <ul className="plain">
                {p.my_interests.map((i: any, n: number) => (
                  <li key={n}>{human(i.rrrType)}{i.share && ` ${i.share}`} held by {i.holder} since {fmtDate(i.since)}</li>
                ))}
              </ul>
              {requesting === p.upi && (
                <RequestForm
                  upi={p.upi}
                  onDone={() => { setRequesting(null); void requests.reload(); }}
                  onCancel={() => setRequesting(null)}
                />
              )}
            </Section>
          ))}
        </div>
        {parcels.data && parcels.data.length > 0 && (
          <ParcelMap
            showParcels={false}
            overlays={parcels.data.map((p) => ({ id: p.upi, data: p.geometry, color: '#d1342f', label: p.upi }))}
            height={420}
          />
        )}
      </div>
      <MyRequests requests={requests.data} onChange={() => void requests.reload()} />
    </div>
  );
}

function RequestForm({ upi, onDone, onCancel }: { upi: string; onDone: () => void; onCancel: () => void }) {
  const [types, setTypes] = useState<string[]>(['deed']);
  const [purpose, setPurpose] = useState('');
  const { busy, error, run } = useAction();
  const toggle = (t: string) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/me/document-requests', { body: { parcelUpi: upi, documentTypes: types, purpose } }))) onDone();
  };
  return (
    <form onSubmit={submit} className="stack compact">
      <fieldset className="stack compact-fieldset">
        <legend>Which documents do you need?</legend>
        {REQUESTABLE.map((t) => (
          <label key={t.value} className="inline">
            <input type="checkbox" checked={types.includes(t.value)} onChange={() => toggle(t.value)} /> {t.label}
          </label>
        ))}
      </fieldset>
      <label>Why do you need them? (10+ characters)
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} minLength={10} required />
      </label>
      <p className="small muted">
        A processor checks what is held on file and a registrar decides what can be released. Identity documents are never released online.
        Approved copies can be downloaded for a limited time.
      </p>
      <ErrorBox error={error} />
      <div className="row">
        <button type="submit" disabled={busy || types.length === 0}>Send request</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function MyRequests({ requests, onChange }: { requests: any[] | null; onChange: () => void }) {
  const action = useAction();
  if (!requests || requests.length === 0) return null;
  const withdraw = async (id: string) => {
    if (window.confirm('Withdraw this request?') && (await action.run(() => api(`/me/document-requests/${id}/withdraw`, { method: 'POST' })))) onChange();
  };
  return (
    <Section title="My document requests">
      <ErrorBox error={action.error} />
      <table className="table">
        <thead><tr><th>Request</th><th>Parcel</th><th>Documents asked for</th><th>Status</th><th>Released copies</th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{r.request_no}<div className="small muted">{fmtDate(r.created_at)}</div></td>
              <td>{r.parcel_upi}</td>
              <td className="small">{r.document_types.map(human).join(', ')}</td>
              <td>
                {REQUEST_STATUS[r.status] ?? r.status}
                {r.decision_reason && <div className="small muted">{r.decision_reason}</div>}
                {['submitted', 'prepared'].includes(r.status) && <div><button className="link" onClick={() => void withdraw(r.id)}>Withdraw</button></div>}
              </td>
              <td className="small">
                {r.status === 'approved' && (r.release_active
                  ? <>
                      {r.released_documents.map((d: any) => (
                        <div key={d.id}><a href={`/api/me/document-requests/${r.id}/documents/${d.id}/file`}>{human(d.docType)}{d.referenceNo && ` ${d.referenceNo}`}</a></div>
                      ))}
                      <div className="muted">Available until {fmtDate(r.release_expires_at)}</div>
                    </>
                  : <span className="muted">Release period ended {fmtDate(r.release_expires_at)}</span>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
