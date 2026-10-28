import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Drawer, EmptyState, ErrorBanner, fmtDateTime, Panel, QueryState, useToast } from '../../components/kit';
import { ReviewMap } from '../../components/ReviewMap';
import type { ConflictDetail, ConflictRow } from '../../types';
import { qs } from './common';

const STATUS = ['unresolved', 'new', 'investigating', 'awaiting_correction', 'escalated', 'resolved', 'closed'];

/**
 * Conflict investigation for GIS officers: look at the evidence, add notes, re-run the checks after a
 * correction, and submit findings. Officers cannot resolve, dismiss or delete a conflict: resolution is a
 * registrar's acknowledgement, or corrected data that no longer triggers the rule.
 */
export function GisConflicts() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'unresolved';
  const open = params.get('conflict');
  const list = useQuery({ queryKey: ['gis', 'conflicts', status], queryFn: () => api<ConflictRow[]>(`/gis/conflicts${qs(`status=${status}`)}`) });
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Conflict Investigation</h1><p className="muted small">A conflict is a technical signal for investigation, not a finding about ownership. Evidence and history are never deleted.</p></div></div>
      <Panel>
        <div className="segmented" role="group" aria-label="Review status">
          {STATUS.map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => set('status', s)}>{s.replace(/_/g, ' ')}</button>)}
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No conflicts with this status" />}>
        {(rows) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Case</th><th>Category</th><th>Severity</th><th>Related</th><th>Status</th><th>Investigator</th><th>Detected</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="row-click" tabIndex={0} onClick={() => set('conflict', c.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('conflict', c.id); }}>
                  <td>{c.case_no}</td><td>{c.category_label}</td><td><Badge value={c.severity} /></td><td>{c.related_upi ?? c.related_case_no ?? '—'}</td>
                  <td><Badge value={c.review_status} /></td><td>{c.investigator ?? '—'}</td><td>{fmtDateTime(c.detected_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        )}
      </QueryState>
      {open && <ConflictDrawer id={open} onClose={() => set('conflict', null)} />}
    </div>
  );
}

function ConflictDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['gis', 'conflict', id], queryFn: () => api<ConflictDetail>(`/gis/conflicts/${id}`) });
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: 'note' | 'revalidated' | 'findings_submitted') => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ rerun: { stillDetected: boolean } | null }>(`/gis/conflicts/${id}/actions`, { body: { action, note } });
      toast('success', action === 'revalidated' ? `Checks re-run: ${r.rerun?.stillDetected ? 'still detected' : 'no longer detected'}` : action === 'findings_submitted' ? 'Findings submitted to the supervisor' : 'Note added');
      setNote('');
      void qc.invalidateQueries({ queryKey: ['gis'] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Drawer open title="Conflict" subtitle={detail.data && <><Badge value={detail.data.conflict.review_status} /> {detail.data.conflict.case_no}</>} onClose={onClose}>
      <QueryState query={detail}>
        {(d) => {
          const c = d.conflict;
          const ev = d.evidence;
          return (
            <div className="stack">
              <p><strong>{c.category_label}</strong>: {c.message}</p>
              <p className="small">Case <Link to={`/work/cases/${c.case_id}`}>{c.case_no}</Link>{c.related_upi && <> · related parcel <Link to={`/work/parcels/${c.related_upi}`}>{c.related_upi}</Link></>}{c.related_case_no && <> · related case {c.related_case_no}</>}</p>
              {ev?.feature && (
                <ReviewMap height={300}
                  working={[{ id: 'f', geometry: ev.feature, popup: `${c.case_no} feature ${(c.feature_index ?? 0) + 1}` }]}
                  references={ev.related_parcel ? [{ id: 'r', geometry: ev.related_parcel, popup: c.related_upi ?? 'Published parcel' }] : []}
                  overlaps={ev.intersection ? [{ id: 'o', geometry: ev.intersection, popup: `Overlap ${ev.intersection_m2} m²` }] : []} />
              )}
              {ev?.intersection_m2 && <p className="small">Overlap area {ev.intersection_m2} m² of {ev.feature_m2} m².</p>}
              <h3>History</h3>
              {d.events.length === 0 ? <p className="muted small">No review actions yet.</p> : (
                <ul className="timeline small">{d.events.map((e) => <li key={e.id}><strong>{e.action.replace(/_/g, ' ')}</strong> by {e.actor} · {fmtDateTime(e.at)}<div>{e.note}</div></li>)}</ul>
              )}
              <h3>Investigate</h3>
              <ErrorBanner error={error} />
              <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and found (findings: at least 20 characters)" aria-label="Investigation note" />
              <div className="chip-row">
                <button className="secondary" disabled={busy || note.trim().length < 5} onClick={() => void act('note')}>Add note</button>
                <button className="secondary" disabled={busy || note.trim().length < 5} onClick={() => void act('revalidated')} title="Re-runs validation of the case (only while it is a draft or returned)">Re-run checks</button>
                <button disabled={busy || note.trim().length < 20} onClick={() => void act('findings_submitted')}>Submit findings</button>
              </div>
              <p className="muted small">There is no “resolve” here on purpose: a registrar's acknowledgement, or corrected data that no longer triggers the rule, closes a conflict.</p>
            </div>
          );
        }}
      </QueryState>
    </Drawer>
  );
}
