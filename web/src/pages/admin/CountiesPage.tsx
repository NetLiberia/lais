import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Upload } from 'lucide-react';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { ParcelMap } from '../../components/ParcelMap';
import { Badge, DataTable, Drawer, ErrorBanner, fmtDateTime, Panel, QueryState, ReasonDialog, useToast, type Column } from '../../components/kit';

interface County {
  id: number; code: string; name: string; enabled: boolean; boundary_status: string; boundary_source: string | null; is_synthetic: boolean;
  boundary_verified_at: string | null; boundary_verified_by: string | null; area_km2: string | null; staff: number; parcels: number; open_cases: number; updated_at: string;
}

const boundarySchema = z.object({
  crs: z.enum(['4326', '32629']),
  source: z.string().trim().min(3, 'Name the authoritative source of this boundary'),
  reason: z.string().trim().min(5, 'Give a reason (5+ characters)'),
  file: z.custom<FileList>((v) => v instanceof FileList && v.length === 1, 'Choose one GeoJSON file'),
});

function CountyDrawer({ county, onClose }: { county: County; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const boundary = useQuery({ queryKey: ['admin', 'county-boundary', county.id, county.updated_at], queryFn: () => api<GeoJSON.Feature>(`/admin/counties/${county.id}/boundary`), enabled: county.boundary_status !== 'unconfigured' });
  const [dialog, setDialog] = useState<null | 'enable' | 'disable' | 'verify'>(null);
  const [verifySource, setVerifySource] = useState(county.boundary_source ?? '');
  const [serverError, setServerError] = useState<string | null>(null);
  const [outside, setOutside] = useState<number | null>(null);
  const form = useForm<z.infer<typeof boundarySchema>>({ resolver: zodResolver(boundarySchema), defaultValues: { crs: '4326', source: '', reason: '' } });
  useEffect(() => { setOutside(null); setServerError(null); }, [county.id]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'counties'] });
  const manage = can('counties.manage');

  const importBoundary = form.handleSubmit(async (v) => {
    setServerError(null);
    const body = new FormData();
    body.append('crs', v.crs);
    body.append('source', v.source);
    body.append('reason', v.reason);
    if (outside !== null) body.append('acknowledgeParcelsOutside', 'true');
    body.append('file', v.file[0]);
    try {
      const r = await api<{ areaKm2: number; parcelsOutside: number }>(`/admin/counties/${county.id}/boundary`, { form: body });
      await refresh();
      toast('success', `Boundary imported as provisional (${r.areaKm2} km²)`);
      form.reset({ crs: v.crs, source: '', reason: '' });
      setOutside(null);
    } catch (e) {
      const details = (e as ApiError).details as { parcelsOutside?: number } | undefined;
      if ((e as ApiError).status === 409 && details?.parcelsOutside) setOutside(details.parcelsOutside);
      setServerError((e as Error).message);
    }
  });

  return (
    <Drawer open title={county.name} subtitle={`Internal code ${county.code}`} onClose={onClose}>
      <div className="stack">
        <div className="row wrap">
          <Badge value={county.enabled ? 'active' : 'unknown'} label={county.enabled ? 'enabled for operations' : 'not enabled'} />
          <Badge value={county.boundary_status} label={`boundary: ${county.boundary_status}`} />
        </div>
        <dl className="facts">
          <dt>Boundary source</dt><dd>{county.boundary_source ?? '—'}</dd>
          <dt>Verified</dt><dd>{county.boundary_verified_at ? `${fmtDateTime(county.boundary_verified_at)} by ${county.boundary_verified_by}` : 'not verified'}</dd>
          <dt>Area</dt><dd>{county.area_km2 ? `${Number(county.area_km2).toLocaleString()} km²` : '—'}</dd>
          <dt>Staff assigned</dt><dd>{county.staff}</dd>
          <dt>Parcels / open cases</dt><dd>{county.parcels} / {county.open_cases}</dd>
        </dl>
        {county.boundary_status === 'synthetic' && <div className="alert info small">This is a synthetic rectangle for the prototype, not an official boundary. It can never be marked verified.</div>}
        {county.boundary_status === 'unconfigured' && <div className="alert info small">No boundary has been imported. The county cannot be enabled until one is, because parcels are validated against it.</div>}
        {boundary.data?.geometry && <ParcelMap height={240} showParcels={false} overlays={[{ id: `c${county.id}`, data: boundary.data, color: '#3b6fb6', label: `${county.name} boundary` }]} />}

        {manage && (
          <>
            <Panel title="Operations">
              <p className="muted small">Enabling a county lets staff open cases there. It does not give anyone legal authority; title decisions stay with the county's assigned Land Registrar.</p>
              <div className="row wrap">
                {county.enabled
                  ? <button className="secondary" onClick={() => setDialog('disable')}>Stop new cases (disable)</button>
                  : <button onClick={() => setDialog('enable')} disabled={county.boundary_status === 'unconfigured'}>Enable for operations</button>}
                {county.boundary_status === 'provisional' && <button className="secondary" onClick={() => setDialog('verify')}>Record boundary verification</button>}
              </div>
            </Panel>
            <Panel title="Import boundary">
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void importBoundary(); }} noValidate>
                <label>Coordinate reference system
                  <select {...form.register('crs')}><option value="4326">EPSG:4326 (WGS 84 longitude/latitude)</option><option value="32629">EPSG:32629 (UTM zone 29N, metres)</option></select>
                </label>
                <label>GeoJSON file (one Polygon or MultiPolygon)<input type="file" accept=".geojson,.json" {...form.register('file')} />{form.formState.errors.file && <span className="field-error">{String(form.formState.errors.file.message)}</span>}</label>
                <label>Authoritative source<input {...form.register('source')} placeholder="e.g. LISGIS county boundaries, 2024 edition" />{form.formState.errors.source && <span className="field-error">{form.formState.errors.source.message}</span>}</label>
                <label>Reason<input {...form.register('reason')} />{form.formState.errors.reason && <span className="field-error">{form.formState.errors.reason.message}</span>}</label>
                <ErrorBanner error={serverError} />
                {outside !== null && <div className="alert info small">Submitting again will import the boundary anyway and record that {outside} published parcel(s) fall outside it.</div>}
                <button type="submit" disabled={form.formState.isSubmitting}><Upload size={16} /> {outside !== null ? 'Import anyway' : 'Import as provisional'}</button>
                <p className="muted tiny">Imported boundaries are provisional until someone records their verification. Invalid geometries are refused, never repaired.</p>
              </form>
            </Panel>
          </>
        )}

        <ReasonDialog
          open={dialog === 'enable' || dialog === 'disable'} title={dialog === 'enable' ? `Enable ${county.name}` : `Disable ${county.name}`}
          description={dialog === 'enable' ? 'Staff assigned to this county will be able to open cases.' : 'No new cases can be opened. Open cases continue and published records are unaffected.'}
          confirmLabel={dialog === 'enable' ? 'Enable' : 'Disable'} danger={dialog === 'disable'} onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await api(`/admin/counties/${county.id}`, { method: 'PATCH', body: { enabled: dialog === 'enable', reason } }); await refresh(); toast('success', `${county.name} ${dialog === 'enable' ? 'enabled' : 'disabled'}`); }}
        />
        <ReasonDialog
          open={dialog === 'verify'} title={`Verify ${county.name} boundary`}
          description={<div className="stack"><span>Record that this boundary has been checked against an authoritative source.</span><label>Source<input value={verifySource} onChange={(e) => setVerifySource(e.target.value)} /></label></div>}
          confirmLabel="Record verification" onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await api(`/admin/counties/${county.id}/verify-boundary`, { body: { source: verifySource, reason } }); await refresh(); toast('success', 'Boundary recorded as verified'); }}
        />
      </div>
    </Drawer>
  );
}

export function CountiesPage() {
  const [params, setParams] = useSearchParams();
  const counties = useQuery({ queryKey: ['admin', 'counties'], queryFn: () => api<County[]>('/admin/counties') });
  const selected = counties.data?.find((c) => String(c.id) === params.get('county'));
  const columns: Column<County>[] = [
    { key: 'name', header: 'County', render: (c) => <><strong>{c.name}</strong><div className="muted tiny">{c.code}</div></> },
    { key: 'enabled', header: 'Operations', render: (c) => <Badge value={c.enabled ? 'active' : 'unknown'} label={c.enabled ? 'enabled' : 'not enabled'} /> },
    { key: 'boundary', header: 'Boundary', render: (c) => <Badge value={c.boundary_status} /> },
    { key: 'source', header: 'Source', render: (c) => <span className="small">{c.boundary_source ?? '—'}</span>, className: 'hide-sm' },
    { key: 'staff', header: 'Staff', render: (c) => c.staff },
    { key: 'parcels', header: 'Parcels', render: (c) => c.parcels },
    { key: 'cases', header: 'Open cases', render: (c) => c.open_cases },
  ];
  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>County Management</h1><p className="muted">All 15 counties of Liberia. Only counties with an imported boundary can be enabled. No boundary is invented: unconfigured counties have none.</p></div>
      </div>
      <Panel>
        <QueryState query={counties}>
          {(rows) => (
            <>
              <p className="muted small">{rows.filter((c) => c.enabled).length} enabled · {rows.filter((c) => c.boundary_status === 'verified').length} verified boundaries · {rows.filter((c) => c.boundary_status === 'unconfigured').length} unconfigured</p>
              <DataTable caption="Counties" columns={columns} rows={rows} rowKey={(c) => String(c.id)} onRowClick={(c) => setParams({ county: String(c.id) }, { replace: true })} />
            </>
          )}
        </QueryState>
      </Panel>
      {selected && <CountyDrawer county={selected} onClose={() => setParams({}, { replace: true })} />}
    </div>
  );
}
