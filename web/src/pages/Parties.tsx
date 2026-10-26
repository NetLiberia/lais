import { useState, type FormEvent } from 'react';
import { api, fmtDate } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Section, useAction, useLoad } from '../components/ui';

export function Parties() {
  const { hasRole } = useAuth();
  const isProcessor = hasRole('processor');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, reload } = useLoad(() => api<any[]>(`/parties?q=${encodeURIComponent(query)}`), [query]);
  const action = useAction();
  const [sensitive, setSensitive] = useState<Record<string, any>>({});
  const [form, setForm] = useState({ partyType: 'person', name: '', nationalIdRef: '', contact: '' });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => api('/parties', { body: { ...form, nationalIdRef: form.nationalIdRef || undefined, contact: form.contact || undefined } }))) {
      setForm({ partyType: 'person', name: '', nationalIdRef: '', contact: '' });
      await reload();
    }
  };
  const verify = async (id: string) => {
    const note = window.prompt('How was the identity verified (document seen, reference)?');
    if (note && (await action.run(() => api(`/parties/${id}/verify-identity`, { body: { note } })))) await reload();
  };
  const link = async (id: string) => {
    const username = window.prompt('Landowner account username to link (after identity checks):');
    if (username) await action.run(() => api(`/parties/${id}/link-user`, { body: { username } }));
  };
  const reveal = async (id: string) => {
    await action.run(async () => {
      const p = await api(`/parties/${id}/sensitive`);
      setSensitive((s) => ({ ...s, [id]: p }));
    });
  };

  return (
    <div className="page">
      <h1>Parties</h1>
      <p className="muted">People, organisations, communities and government bodies that can hold interests. Identity numbers are hidden unless revealed; each reveal is logged.</p>
      <ErrorBox error={error ?? action.error} />
      <div className="grid-2">
        <Section title="Search">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="row">
            <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name contains…" />
            <button type="submit">Search</button>
          </form>
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Identity</th><th>Recorded</th><th /></tr></thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {sensitive[p.id] && <div className="small">ID ref: {sensitive[p.id].national_id_ref ?? '—'} · Contact: {sensitive[p.id].contact ?? '—'}</div>}
                  </td>
                  <td>{p.party_type}</td>
                  <td className={p.identity_status === 'verified' ? '' : 'danger'}>{p.identity_status}</td>
                  <td className="small">{fmtDate(p.created_at)}</td>
                  <td className="small">
                    {!sensitive[p.id] && p.has_id_reference && <button className="link" onClick={() => void reveal(p.id)}>Reveal ID</button>}
                    {isProcessor && p.identity_status !== 'verified' && <button className="link" onClick={() => void verify(p.id)}>Verify identity</button>}
                    {isProcessor && p.identity_status === 'verified' && p.party_type === 'person' && <button className="link" onClick={() => void link(p.id)}>Link portal account</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        {isProcessor && (
          <Section title="Record a party">
            <form onSubmit={create} className="stack">
              <label>Type
                <select value={form.partyType} onChange={(e) => setForm({ ...form, partyType: e.target.value })}>
                  <option value="person">Person</option><option value="organization">Organisation</option>
                  <option value="community">Community</option><option value="government">Government entity</option>
                </select>
              </label>
              <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></label>
              <label>Identity document reference (highly sensitive)<input value={form.nationalIdRef} onChange={(e) => setForm({ ...form, nationalIdRef: e.target.value })} /></label>
              <label>Contact (restricted)<input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></label>
              <button type="submit" disabled={action.busy}>Record party</button>
              <p className="small muted">A different processor must verify the identity before this party can hold a registered interest. Use synthetic data only in this prototype.</p>
            </form>
          </Section>
        )}
      </div>
    </div>
  );
}
