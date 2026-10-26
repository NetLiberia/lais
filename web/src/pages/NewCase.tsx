import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';

export function NewCase() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const counties = (session?.grants ?? [])
    .filter((g) => (g.role === 'gis_officer' || g.role === 'processor') && g.county)
    .map((g) => g.county!);
  const uniqueCounties = [...new Map(counties.map((c) => [c.id, c])).values()];

  const [caseType, setCaseType] = useState<'first_registration' | 'transfer'>('first_registration');
  const [countyId, setCountyId] = useState<number>(uniqueCounties[0]?.id ?? 0);
  const [landCategory, setLandCategory] = useState('private');
  const [landUse, setLandUse] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [proposedUpi, setProposedUpi] = useState('');
  const [parcelUpi, setParcelUpi] = useState('');
  const { busy, error, run } = useAction();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const body = caseType === 'transfer'
      ? { caseType, parcelUpi: parcelUpi.trim(), sourceReference: sourceReference || undefined }
      : { caseType, countyId, landCategory, landUse: landUse || undefined, sourceReference: sourceReference || undefined, proposedUpi: proposedUpi.trim() || undefined };
    let id = '';
    if (await run(async () => { id = (await api<{ id: string }>('/cases', { body })).id; })) navigate(`/work/cases/${id}`);
  };

  return (
    <div className="narrow">
      <h1>Open a case</h1>
      <form onSubmit={onSubmit} className="stack">
        <fieldset className="row">
          <legend>Case type</legend>
          <label className="inline"><input type="radio" checked={caseType === 'first_registration'} onChange={() => setCaseType('first_registration')} /> First registration of a parcel</label>
          <label className="inline"><input type="radio" checked={caseType === 'transfer'} onChange={() => setCaseType('transfer')} /> Transfer of an existing parcel</label>
        </fieldset>

        {caseType === 'first_registration' ? (
          <>
            <label>County (your assigned jurisdictions)
              <select value={countyId} onChange={(e) => setCountyId(Number(e.target.value))}>
                {uniqueCounties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>Land category (Land Rights Act 2018 categories)
              <select value={landCategory} onChange={(e) => setLandCategory(e.target.value)}>
                <option value="private">Private</option>
                <option value="customary">Customary</option>
                <option value="government">Government</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label>Land use<input value={landUse} onChange={(e) => setLandUse(e.target.value)} placeholder="residential, agricultural…" /></label>
            <label>Proposed identifier (optional; assigned at publication if blank)
              <input value={proposedUpi} onChange={(e) => setProposedUpi(e.target.value.toUpperCase())} placeholder="PROV-MO-000123" />
            </label>
          </>
        ) : (
          <label>Published parcel identifier<input value={parcelUpi} onChange={(e) => setParcelUpi(e.target.value.toUpperCase())} placeholder="PROV-MO-000001" required /></label>
        )}
        <label>Survey / source record reference<input value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} /></label>
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>Create draft case</button>
      </form>
    </div>
  );
}
