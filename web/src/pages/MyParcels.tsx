import { api, fmtDate, human } from '../api';
import { ParcelMap } from '../components/ParcelMap';
import { ErrorBox, Section, useLoad } from '../components/ui';

/** Landowner portal: registered interests of the parties verified as linked to this account. */
export function MyParcels() {
  const { data, error } = useLoad(() => api<any[]>('/me/parcels'));
  return (
    <div className="page">
      <h1>My registered interests</h1>
      <p className="muted">
        This list shows interests registered to the people linked to your account after identity checks. Your account itself is not proof of ownership.
        Supporting documents are released only through the approved request process.
      </p>
      <ErrorBox error={error} />
      {data?.length === 0 && <p>No registered interests are linked to your account.</p>}
      <div className="grid-2">
        <div className="stack">
          {data?.map((p) => (
            <Section key={p.upi} title={p.upi}>
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
            </Section>
          ))}
        </div>
        {data && data.length > 0 && (
          <ParcelMap
            showParcels={false}
            overlays={data.map((p) => ({ id: p.upi, data: p.geometry, color: '#d1342f', label: p.upi }))}
            height={420}
          />
        )}
      </div>
    </div>
  );
}
