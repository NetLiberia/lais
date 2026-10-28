import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { Geometry } from 'geojson';
import { api } from '../../api';
import { ErrorBanner, Panel, QueryState } from '../../components/kit';
import { WorkspaceMap } from '../../components/WorkspaceMap';
import type { WorkspaceLayers } from '../../types';
import { CasePicker, qs } from './common';

/** The parcel workspace: every layer a GIS officer needs on one map, limited to their counties. */
export function Workspace() {
  const [caseId, setCaseId] = useState('');
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState<{ geometry: Geometry; token: number } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<{ kind: string; label: string; id: string; extent: Geometry }[] | null>(null);
  const layers = useQuery({ queryKey: ['gis', 'layers', caseId], queryFn: () => api<WorkspaceLayers>(`/gis/workspace/layers${qs(caseId && `caseId=${caseId}`)}`) });

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError(null);
    try {
      const r = await api<{ kind: string; label: string; id: string; extent: Geometry }[]>(`/gis/workspace/search?q=${encodeURIComponent(q)}`);
      setHits(r);
      if (r[0]) setFocus({ geometry: r[0].extent, token: Date.now() });
      else setSearchError('No parcel or case matches that identifier in your counties.');
    } catch (err) { setSearchError((err as Error).message); }
  };

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Parcel Workspace</h1>
          <p className="muted small">Staging data is working data, not the register. Approved reference parcels come from the published register and cannot be edited here.</p>
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <CasePicker value={caseId} onChange={(id) => setCaseId(id)} label="Show staging data of" />
          <form onSubmit={search} className="inline-form" role="search">
            <label>Find parcel or case
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="UPI, legacy reference or case number" minLength={2} />
            </label>
            <button type="submit" disabled={q.trim().length < 2}><Search size={16} /> Find</button>
          </form>
          {hits && hits.length > 1 && (
            <div className="chip-row">{hits.map((h) => <button key={h.kind + h.id} className="chip" onClick={() => setFocus({ geometry: h.extent, token: Date.now() })}>{h.label}</button>)}</div>
          )}
        </div>
        <ErrorBanner error={searchError} />
      </Panel>
      <QueryState query={layers} skeletonLines={10}>
        {(d) => (
          <>
            {d.truncated && <div className="alert">Some layers show only the first {d.limit} features. Choose a case to see its data in full.</div>}
            <WorkspaceMap layers={d.layers} focus={focus} initiallyOff={caseId ? [] : ['submitted']} />
          </>
        )}
      </QueryState>
    </div>
  );
}
