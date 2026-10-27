import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, CASE_TYPE_LABELS, fmtDate, human } from '../api';
import { ParcelMap } from '../components/ParcelMap';
import { ErrorBox, Section, StatusPill, useAction, useLoad } from '../components/ui';

/** Internal registry record. Every view is logged on the server. */
export function ParcelRecord() {
  const { upi } = useParams();
  const { data, error, reload } = useLoad(() => api(`/parcels/${upi}`), [upi]);
  const action = useAction();
  const [reason, setReason] = useState('');
  const [referral, setReferral] = useState('');

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <p className="pad muted">Loading…</p>;
  const current = data.versions.find((v: any) => !v.valid_to);
  // A retired parcel has no current version; show its last one.
  const shown = current ?? data.versions[0];
  const retired = data.parcel.status === 'retired';

  const openDispute = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => api(`/parcels/${upi}/disputes`, { body: { reason, referral: referral || undefined } }))) {
      setReason('');
      setReferral('');
      await reload();
    }
  };
  const closeDispute = async (id: string) => {
    const resolution = window.prompt('Record the outcome and the authority that decided it:');
    if (resolution && (await action.run(() => api(`/parcels/${upi}/disputes/${id}/close`, { body: { resolution } })))) await reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{data.parcel.upi} <span className={`pill p-${data.parcel.status}`}>{data.parcel.status}</span></h1>
          <p className="muted">
            {data.parcel.county.name} · {human(shown?.land_category)} · {shown?.land_use ?? '—'}
            {data.parcel.legacy_ref && <> · legacy reference <strong>{data.parcel.legacy_ref}</strong></>}
          </p>
        </div>
      </div>
      <ErrorBox error={action.error} />
      {retired && (
        <div className="alert info">
          This parcel is retired. It was replaced by{' '}
          {data.children.map((c: any, i: number) => <span key={c.upi}>{i > 0 && ', '}<Link to={`/work/parcels/${c.upi}`}>{c.upi}</Link></span>)}
          {data.children[0] && ` (${data.children[0].case_no})`}. Its records are kept as history.
        </div>
      )}
      <div className="grid-2">
        <div className="stack">
          <Section title="Current interests">
            <table className="table">
              <thead><tr><th>Holder</th><th>Interest</th><th>Share</th><th>Status</th><th>Since</th><th>Case</th></tr></thead>
              <tbody>
                {data.currentRights.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.party_name} <span className="muted small">({r.party_type})</span></td>
                    <td>{human(r.rrr_type)}</td>
                    <td>{r.share_den ? `${r.share_num}/${r.share_den}` : '—'}</td>
                    <td>{r.interest_status}</td>
                    <td className="small">{fmtDate(r.valid_from)}</td>
                    <td className="small">{r.created_by_case ?? 'initial load'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.currentRights.some((r: any) => r.interest_status !== 'registered') && (
              <div className="alert info small">
                Interests marked <strong>documented</strong> are names copied from a legacy record. They have not been verified or registered.
              </div>
            )}
            <p className="small muted">This is the record held by LAIS. A record match is not by itself a legal determination of ownership.</p>
          </Section>
          {data.historicalRights.length > 0 && (
            <Section title="Previous interests">
              <table className="table">
                <thead><tr><th>Holder</th><th>Interest</th><th>From</th><th>To</th><th>Ended by</th></tr></thead>
                <tbody>
                  {data.historicalRights.map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.party_name}</td><td>{human(r.rrr_type)}</td>
                      <td className="small">{fmtDate(r.valid_from)}</td><td className="small">{fmtDate(r.valid_to)}</td>
                      <td className="small">{r.ended_by_case}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          <Section title="Versions">
            <table className="table">
              <thead><tr><th>#</th><th>Category</th><th>Use</th><th>Calculated area</th><th>Source</th><th>Valid</th><th>Published by</th></tr></thead>
              <tbody>
                {data.versions.map((v: any) => (
                  <tr key={v.id}>
                    <td>{v.version_no}</td><td>{human(v.land_category)}</td><td>{v.land_use ?? '—'}</td>
                    <td>{Number(v.area_m2_calculated).toLocaleString()} m²{v.area_m2_surveyed && <div className="small">surveyed {Number(v.area_m2_surveyed).toLocaleString()} m²</div>}</td>
                    <td className="small">{v.source_reference}</td>
                    <td className="small">{fmtDate(v.valid_from)} – {v.valid_to ? fmtDate(v.valid_to) : 'current'}</td>
                    <td className="small">{v.published_by_case ?? 'initial load'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown && <p className="small muted">{shown.area_method}</p>}
          </Section>
        </div>
        <div className="stack">
          <ParcelMap overlays={shown ? [{ id: 'p', data: shown.geometry, color: retired ? '#777' : '#d1342f', dashed: retired, label: `${data.parcel.upi}${retired ? ' (retired)' : ''}` }] : []} height={340} />
          {(data.parents.length > 0 || data.children.length > 0) && (
            <Section title="Lineage">
              <ul className="plain">
                {data.parents.map((p: any) => (
                  <li key={`p-${p.upi}`}>Created from <Link to={`/work/parcels/${p.upi}`}>{p.upi}</Link> <span className="muted small">({p.status}) by {p.case_no}</span></li>
                ))}
                {data.children.map((c: any) => (
                  <li key={`c-${c.upi}`}>Replaced by <Link to={`/work/parcels/${c.upi}`}>{c.upi}</Link> <span className="muted small">({c.status}) by {c.case_no}</span></li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Cases">
            {data.cases.length === 0 ? <p className="muted">No cases since initial load.</p> : (
              <ul className="plain">
                {data.cases.map((c: any) => (
                  <li key={c.id}><Link to={`/work/cases/${c.id}`}>{c.case_no}</Link> {CASE_TYPE_LABELS[c.case_type]} <StatusPill status={c.status} /></li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Disputes">
            {data.disputes.length === 0 && <p className="muted">None recorded.</p>}
            <ul className="plain">
              {data.disputes.map((d: any) => (
                <li key={d.id} className="dispute">
                  <strong>{d.closed_at ? 'Closed' : 'Open'}</strong> — opened by {d.opened_by}, {fmtDate(d.opened_at)}
                  <div>{d.reason}</div>
                  {d.referral && <div className="small muted">Referral: {d.referral}</div>}
                  {d.resolution && <div className="small">Outcome: {d.resolution} ({d.closed_by})</div>}
                  {!d.closed_at && data.canManageDisputes && <button className="link" onClick={() => void closeDispute(d.id)}>Record outcome and close</button>}
                </li>
              ))}
            </ul>
            {data.canManageDisputes && !retired && (
              <form onSubmit={openDispute} className="stack compact">
                <p className="small muted">Recording a dispute blocks transfers of this parcel. The system records the dispute; it does not decide it.</p>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Nature of the dispute (10+ characters)" minLength={10} required />
                <input value={referral} onChange={(e) => setReferral(e.target.value)} placeholder="Referred to (body / reference)" />
                <button type="submit">Record dispute</button>
              </form>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
