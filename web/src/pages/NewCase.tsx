import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';

type CaseType = 'first_registration' | 'transfer' | 'subdivision' | 'consolidation' | 'correction' | 'migration';

const TYPES: { value: CaseType; label: string; hint: string }[] = [
  { value: 'first_registration', label: 'First registration', hint: 'Record a parcel that is not yet in the register.' },
  { value: 'transfer', label: 'Transfer', hint: 'Change who holds the interest in a published parcel. The boundary is unchanged.' },
  { value: 'subdivision', label: 'Subdivision', hint: 'Split one published parcel into two or more new parcels.' },
  { value: 'consolidation', label: 'Consolidation', hint: 'Merge two or more published parcels into one.' },
  { value: 'correction', label: 'Correction', hint: 'Fix an error in a published boundary or record. Rights are not changed.' },
  { value: 'migration', label: 'Legacy migration', hint: 'Bring a batch of parcels from an existing register or GIS layer into LAIS.' },
];

/** Splits a list of identifiers typed with commas, spaces or new lines. */
const parseUpis = (text: string) => text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

export function NewCase() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const counties = (session?.grants ?? [])
    .filter((g) => (g.role === 'gis_officer' || g.role === 'processor') && g.county)
    .map((g) => g.county!);
  const uniqueCounties = [...new Map(counties.map((c) => [c.id, c])).values()];

  const [caseType, setCaseType] = useState<CaseType>('first_registration');
  const [countyId, setCountyId] = useState<number>(uniqueCounties[0]?.id ?? 0);
  const [landCategory, setLandCategory] = useState('private');
  const [landUse, setLandUse] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [proposedUpi, setProposedUpi] = useState('');
  const [parcelUpi, setParcelUpi] = useState('');
  const [parcelUpis, setParcelUpis] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const { busy, error, run } = useAction();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const reference = sourceReference || undefined;
    const body =
      caseType === 'migration'
        ? { caseType, countyId, sourceReference: reference }
        : caseType === 'first_registration'
        ? { caseType, countyId, landCategory, landUse: landUse || undefined, sourceReference: reference, proposedUpi: proposedUpi.trim() || undefined }
        : caseType === 'consolidation'
          ? { caseType, parcelUpis: parseUpis(parcelUpis), sourceReference: reference }
          : caseType === 'correction'
            ? { caseType, parcelUpi: parcelUpi.trim(), correctionReason: correctionReason || undefined }
            : { caseType, parcelUpi: parcelUpi.trim(), sourceReference: reference };
    let id = '';
    if (await run(async () => { id = (await api<{ id: string }>('/cases', { body })).id; })) navigate(`/work/cases/${id}`);
  };

  return (
    <div className="narrow">
      <h1>Open a case</h1>
      <form onSubmit={onSubmit} className="stack">
        <fieldset className="stack compact-fieldset">
          <legend>Case type</legend>
          {TYPES.map((t) => (
            <label key={t.value} className="inline">
              <input type="radio" name="caseType" checked={caseType === t.value} onChange={() => setCaseType(t.value)} />
              <span><strong>{t.label}</strong> <span className="muted small">{t.hint}</span></span>
            </label>
          ))}
        </fieldset>

        {(caseType === 'first_registration' || caseType === 'migration') && (
          <label>County (your assigned jurisdictions)
            <select value={countyId} onChange={(e) => setCountyId(Number(e.target.value))}>
              {uniqueCounties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {caseType === 'migration' && (
          <p className="small muted">
            Each feature in the GeoJSON file needs <code>legacy_ref</code> and <code>land_category</code>; it may also have <code>land_use</code>,
            {' '}<code>surveyed_area_m2</code>, <code>holder_names</code> (separated by ";") and <code>holder_type</code>.
            Holders become documented interests to be verified later, not registered ones.
          </p>
        )}
        {caseType === 'first_registration' && (
          <>
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
        )}
        {(caseType === 'transfer' || caseType === 'subdivision' || caseType === 'correction') && (
          <label>Published parcel identifier<input value={parcelUpi} onChange={(e) => setParcelUpi(e.target.value.toUpperCase())} placeholder="PROV-MO-000001" required /></label>
        )}
        {caseType === 'consolidation' && (
          <label>Parcels to merge (two or more identifiers, separated by commas or new lines)
            <textarea value={parcelUpis} onChange={(e) => setParcelUpis(e.target.value)} placeholder={'PROV-MO-000011\nPROV-MO-000012'} required />
          </label>
        )}
        {(caseType === 'subdivision' || caseType === 'consolidation') && (
          <p className="small muted">The new parcel(s) start with the land category and use of the source; you can change them before submitting. New identifiers are assigned at publication.</p>
        )}
        {caseType === 'correction' ? (
          <>
            <label>What is wrong, and how was it established?
              <textarea value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="e.g. Land use was transcribed incorrectly from the 2019 register" />
            </label>
            <p className="small muted">The case starts with the current record. Change only what is wrong; the published version is kept in the history.</p>
          </>
        ) : (
          <label>{caseType === 'migration' ? 'Legacy register or dataset name' : 'Survey / source record reference'}
            <input value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} />
          </label>
        )}
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>Create draft case</button>
      </form>
    </div>
  );
}
