import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Feature } from 'geojson';
import { api, human, fmtDate } from '../api';
import { INTERNAL_ROLES, useAuth } from '../auth';
import { ParcelMap } from '../components/ParcelMap';
import { ErrorBox } from '../components/ui';

/** Public information portal: approved public fields only, no personal data. */
export function PublicPortal() {
  const { hasRole } = useAuth();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Feature | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async (upi: string) => {
    setError(null);
    try {
      setSelected(await api<Feature>(`/public/parcels/${encodeURIComponent(upi.trim())}`));
    } catch (e) {
      setSelected(null);
      setError((e as Error).message);
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) void lookup(query);
  };

  const p = selected?.properties;
  return (
    <div className="layout-split">
      <div className="side">
        <h1>Public parcel search</h1>
        <p className="muted">
          Shows approved public information only: parcel identifier, county, land category, land use and record status.
          Owner names, documents and identity data are never published here.
        </p>
        <form onSubmit={onSearch} className="row">
          <label className="grow">
            <span className="sr-only">Parcel identifier</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. PROV-MO-000001" />
          </label>
          <button type="submit">Search</button>
        </form>
        <ErrorBox error={error} />
        {p && (
          <div className="card">
            <h2>{p.upi}</h2>
            <dl className="facts">
              <dt>County</dt><dd>{p.county}</dd>
              <dt>Land category</dt><dd>{human(p.land_category)}</dd>
              <dt>Land use</dt><dd>{p.land_use ?? '—'}</dd>
              <dt>Record status</dt><dd>{p.record_status}</dd>
              <dt>Calculated area</dt><dd>{Number(p.area_m2_calculated).toLocaleString()} m²</dd>
              <dt>Current since</dt><dd>{fmtDate(p.current_since)}</dd>
            </dl>
            <p className="small muted">{p.area_method}</p>
            {hasRole(...INTERNAL_ROLES) && <Link to={`/work/parcels/${p.upi}`}>Open internal record</Link>}
          </div>
        )}
        <p className="small muted">
          Identifiers are provisional prototype identifiers, not the official Liberian UPI format. County boundaries shown are simplified synthetic polygons.
        </p>
      </div>
      <div className="main-map">
        <ParcelMap
          height="calc(100vh - 120px)"
          onParcelClick={(upi) => void lookup(upi)}
          highlightUpi={(p?.upi as string) ?? null}
          overlays={selected ? [{ id: 'sel', data: selected, color: '#d1342f' }] : []}
          fitOverlays={false}
        />
      </div>
    </div>
  );
}
