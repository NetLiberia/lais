import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { api } from '../../api';
import { Badge, Drawer, EmptyState, ErrorBanner, fmtDateTime, Pagination, Panel, QueryState, useToast } from '../../components/kit';
import type { ApplicantProfile, ApplicantRow, Paged } from '../../types';
import { CompletenessBadge, ReviewBadge, human, qs } from './common';

/** Applicant management: search, profiles, and corrections that keep the previous values. */
export function ApplicantsPage() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page' && k !== 'open') p.delete('page'); setParams(p); };
  const [q, setQ] = useState(get('q'));
  const query = qs(get('q') && `q=${encodeURIComponent(get('q'))}`, get('type') && `type=${get('type')}`, get('status') && `status=${get('status')}`,
    get('from') && `from=${get('from')}`, get('to') && `to=${get('to')}`, `sort=${get('sort') || 'created_at'}`, `dir=${get('dir') || 'desc'}`, `page=${get('page') || 1}`, 'pageSize=25');
  const list = useQuery({ queryKey: ['processor', 'applicants', query], queryFn: () => api<Paged<ApplicantRow>>(`/applicants${query}`), placeholderData: keepPreviousData });
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Applicant Management</h1><p className="muted small">Applicants are administrative contacts. Contact details and identification references are shown only to officers allowed to see them, and every correction keeps the previous value.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set('q', q.trim() || null); }} role="search">
            <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, applicant number or telephone" /></label>
            <button type="submit">Search</button>
          </form>
          <label className="inline">Type
            <select value={get('type')} onChange={(e) => set('type', e.target.value || null)}>
              <option value="">All</option><option value="person">Person</option><option value="organization">Organization</option><option value="community">Community</option><option value="government">Government</option>
            </select>
          </label>
          <label className="inline">Status <select value={get('status')} onChange={(e) => set('status', e.target.value || null)}><option value="">All</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
          <label className="inline">Registered from <input type="date" value={get('from')} onChange={(e) => set('from', e.target.value || null)} /></label>
          <label className="inline">to <input type="date" value={get('to')} onChange={(e) => set('to', e.target.value || null)} /></label>
          <label className="inline">Sort
            <select value={`${get('sort') || 'created_at'}:${get('dir') || 'desc'}`} onChange={(e) => { const [s, d] = e.target.value.split(':'); const p = new URLSearchParams(params); p.set('sort', s); p.set('dir', d); setParams(p); }}>
              <option value="created_at:desc">Newest first</option><option value="name:asc">Name A–Z</option><option value="applicant_no:asc">Applicant number</option><option value="updated_at:desc">Recently updated</option>
            </select>
          </label>
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No applicants match" />}>
        {(d) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Applicant</th><th>Type</th><th>Telephone</th><th>E-mail</th><th>Applications</th><th>County</th><th>Registered</th><th>Updated</th><th>Status</th></tr></thead>
              <tbody>{d.items.map((a) => (
                <tr key={a.id} className="row-click" tabIndex={0} onClick={() => set('open', a.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('open', a.id); }}>
                  <td><strong>{a.name}</strong><div className="muted small">{a.applicant_no}</div></td><td>{human(a.applicant_type)}</td>
                  <td>{a.phone ?? '—'}</td><td>{a.email ?? '—'}</td><td>{a.applications}</td><td>{a.county_code}</td>
                  <td>{fmtDateTime(a.created_at)}</td><td>{fmtDateTime(a.updated_at)}</td><td><Badge value={a.status === 'active' ? 'active' : 'closed'} label={a.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            {d.items.some((a) => a.contactMasked) && <p className="muted small">Contact details are masked for your role.</p>}
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => set('page', String(p))} />
          </Panel>
        )}
      </QueryState>
      {get('open') && <ApplicantDrawer id={get('open')} onClose={() => set('open', null)} />}
    </div>
  );
}

const EDITABLE: [string, string, string][] = [
  ['name', 'name', 'Name (correction: reason required)'], ['phone', 'phone', 'Telephone'], ['email', 'email', 'E-mail'], ['address', 'address', 'Address'],
  ['representativeName', 'representative_name', 'Representative'], ['representativeRole', 'representative_role', "Representative's role"],
];

function ApplicantDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const profile = useQuery({ queryKey: ['processor', 'applicant', id], queryFn: () => api<ApplicantProfile>(`/applicants/${id}`) });
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [identity, setIdentity] = useState<{ idDocumentType: string | null; idReference: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startEdit = (p: ApplicantProfile) => { setValues(Object.fromEntries(EDITABLE.map(([k, col]) => [k, String((p.applicant as unknown as Record<string, unknown>)[col] ?? '')]))); setEditing(true); };
  const save = async (p: ApplicantProfile) => {
    setError(null);
    const current = p.applicant as unknown as Record<string, unknown>;
    const changed = Object.fromEntries(EDITABLE.filter(([k, col]) => (values[k] ?? '') !== String(current[col] ?? '')).map(([k]) => [k, values[k] || null]));
    try {
      await api(`/applicants/${id}`, { method: 'PATCH', body: { ...changed, reason: reason || undefined } });
      toast('success', 'Saved; the previous values are kept in the history'); setEditing(false); setReason('');
      void qc.invalidateQueries({ queryKey: ['processor'] });
    } catch (e) { setError((e as Error).message); }
  };
  const reveal = async () => { try { setIdentity(await api(`/applicants/${id}/identity`)); } catch (e) { setError((e as Error).message); } };
  return (
    <Drawer open title={profile.data?.applicant.name ?? 'Applicant'} subtitle={profile.data?.applicant.applicant_no} onClose={onClose}>
      <QueryState query={profile}>
        {(p) => (
          <div className="stack small">
            <ErrorBanner error={error} />
            {!editing ? (
              <dl className="facts">
                <dt>Type</dt><dd>{human(p.applicant.applicant_type)}</dd>
                <dt>Telephone</dt><dd>{p.applicant.phone ?? '—'}</dd>
                <dt>E-mail</dt><dd>{p.applicant.email ?? '—'}</dd>
                <dt>Address</dt><dd>{p.applicant.contactMasked ? <em className="muted">hidden for your role</em> : p.applicant.address ?? '—'}</dd>
                <dt>Identification</dt><dd>{p.applicant.id_document_type ? human(p.applicant.id_document_type) : 'none recorded'}
                  {p.can.revealIdentity && !identity && <> · <button className="link" onClick={() => void reveal()}><Eye size={14} /> Reveal reference (logged)</button></>}
                  {identity && <> · <code>{identity.idReference}</code></>}</dd>
                <dt>Representative</dt><dd>{p.applicant.representative_name ? `${p.applicant.representative_name} (${p.applicant.representative_role ?? 'role not stated'})` : '—'}</dd>
                <dt>Status</dt><dd>{p.applicant.status}</dd>
              </dl>
            ) : (
              <div className="stack">
                {EDITABLE.map(([k, , l]) => <label key={k}>{l} <input value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} /></label>)}
                <label>Reason (required when correcting the name) <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <div className="chip-row"><button className="secondary" onClick={() => setEditing(false)}>Cancel</button><button onClick={() => void save(p)}>Save</button></div>
              </div>
            )}
            {p.can.manage && !editing && <button className="secondary" onClick={() => startEdit(p)}>Update details</button>}
            <h3>Applications</h3>
            {p.applications.length === 0 ? <p className="muted">None.</p> : (
              <ul>{p.applications.map((a) => <li key={a.id}><Link to={`/processor/applications/${a.id}`}>{a.case_no}</Link> · {a.category_label} · {human(a.status)} · <CompletenessBadge value={a.completeness} /></li>)}</ul>
            )}
            <h3>Documents</h3>
            {p.documents.length === 0 ? <p className="muted">None.</p> : <ul>{p.documents.map((d) => <li key={d.id}>{d.document_no} ({human(d.doc_type)}, {d.case_no}) <ReviewBadge status={d.review_status} /></li>)}</ul>}
            <h3>Outstanding information requests</h3>
            {p.openRequests.length === 0 ? <p className="muted">None.</p> : <ul>{p.openRequests.map((r) => <li key={r.id}>{r.request_no} ({r.case_no}): {r.items} · {human(r.status)}</li>)}</ul>}
            <h3>Change history</h3>
            <table className="table"><thead><tr><th>When</th><th>Field</th><th>Previous</th><th>New</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>{p.history.map((h, i) => <tr key={i}><td>{fmtDateTime(h.changed_at)}</td><td>{human(h.field)}</td><td>{h.old_value ?? '—'}</td><td>{h.new_value ?? '—'}</td><td>{h.reason ?? '—'}</td><td>{h.changed_by}</td></tr>)}</tbody></table>
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}
