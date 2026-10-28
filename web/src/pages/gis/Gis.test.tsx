import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFor, stubApi } from '../../test/render';
import { toUtm29n } from '../../components/WorkspaceMap';
import { GisDashboard } from './GisDashboard';
import { ImportWizard } from './ImportWizard';
import { SubmitWizard } from './Submissions';
import { ArcmapSync } from './ArcmapSync';

const MO = { id: 1, code: 'MO', name: 'Montserrado' };
const GIS = sessionFor('gis_officer', ['gis.workspace', 'gis.sync_token', 'case.import_geometry', 'case.submit', 'task.work', 'conflict.investigate', 'gis.reports'], MO);
const NOT_CONFIGURED = {
  state: 'not_configured', explanation: 'No active sync token: create one and configure the ArcMap adapter with it.', lastContact: null, activeTokens: 0,
  adapterVersion: '1.0.0', last_success: null, last_failure: null, failed_7d: 0, total_7d: 0, jobs: [],
};
const KPIS = {
  my_open_tasks: 2, my_overdue_tasks: 1, claimable_tasks: 0, cases_in_preparation: 3, returned_cases: 1, cases_with_blocking_errors: 1,
  awaiting_review: 0, accepted_30d: 0, jobs_active: 0, jobs_failed_7d: 1, versions_7d: 4, open_conflicts: 2,
};

describe('coordinate readout', () => {
  // Reference values projected with ArcPy 10.7 (EPSG:4326 -> EPSG:32629).
  it.each([
    [-10.8, 6.3, 300874.448, 696710.722],
    [-9.0, 6.3, 500000.0, 696367.404],
    [-7.5, 4.5, 666420.242, 497566.412],
  ])('converts %f, %f to UTM 29N within a centimetre', (lon, lat, x, y) => {
    const [e, n] = toUtm29n(lon, lat);
    expect(Math.abs(e - x)).toBeLessThan(0.01);
    expect(Math.abs(n - y)).toBeLessThan(0.01);
  });
});

describe('GIS officer dashboard', () => {
  it('shows the twelve indicators and an honest ArcMap status', async () => {
    stubApi({
      '/auth/session': GIS, '/gis/sync/status': NOT_CONFIGURED,
      '/gis/summary': { kpis: KPIS, lastArcmapSync: null, recentJobs: [], myTasks: [] },
    });
    renderApp(<GisDashboard />, { path: '/gis' });
    await screen.findByText('My overdue tasks');
    const cards = screen.getAllByRole('button').filter((b) => b.classList.contains('stat-card'));
    expect(cards).toHaveLength(12);
    expect(await screen.findByText('ArcMap sync not configured')).toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
    expect(screen.getByText('Last ArcMap sync: none yet')).toBeInTheDocument();
  });
});

describe('Data Import Center', () => {
  it('never previews data with an unknown CRS until it is declared, explained and confirmed', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      '/auth/session': GIS,
      '/gis/imports/options': {
        formats: [{ format: 'shapefile', label: 'Shapefile in a .zip', supported: true }, { format: '.gpkg', label: '.gpkg', supported: false, reason: 'GeoPackage needs an adapter' }],
        acceptedCrs: [{ epsg: 4326, name: 'WGS 84' }, { epsg: 32629, name: 'WGS 84 / UTM zone 29N' }],
        targetFields: [{ key: 'legacy_ref', label: 'Legacy reference', type: 'text' }], requiredFields: { migration: ['legacy_ref'] },
        limits: { maxUploadBytes: 52428800, maxFeatures: 5000 },
      },
      'POST /gis/uploads': {
        uploadKey: 'a'.repeat(32), file: 'parcels.zip', size: 2048, sha256: 'b'.repeat(64), format: 'shapefile', manifest: null, expiresInHours: 24,
        warnings: ['Layer "parcels" has no .prj file: its coordinate reference system is unknown and must be declared with a reason.'],
        layers: [{ name: 'parcels', featureCount: 3, fields: [{ name: 'PARCEL_NO', type: 'text' }], geometryTypes: ['Polygon'], crs: { epsg: null, name: null, source: 'none' }, sample: [{ PARCEL_NO: 'P-1' }] }],
        suggestedMapping: { parcels: {} },
      },
      '/gis/cases': [{ id: 'c1', case_no: 'CASE-2026-000009', case_type: 'migration', status: 'draft', county_id: 1, county_code: 'MO', version_no: null, feature_count: null }],
      'POST /gis/imports/preview': {
        caseNo: 'CASE-2026-000009', format: 'shapefile', layer: 'parcels', file: 'parcels.zip', sha256: 'b'.repeat(64),
        crs: { detected: null, declared: 4326, exceptionReason: 'Survey report SR-1 states WGS 84', name: 'WGS 84' },
        received: 3, accepted: 3, rejected: 0, withinLimits: true, limitLabel: null, rejections: [], warnings: [], extent: null, sample: [{ legacy_ref: 'P-1' }],
      },
    });
    const { container } = renderApp(<ImportWizard />, { path: '/gis/import' });
    await screen.findByText(/GeoPackage needs an adapter/);
    await user.upload(container.querySelector('input[type=file]') as HTMLInputElement, new File(['zip'], 'parcels.zip', { type: 'application/zip' }));
    await user.click(screen.getByRole('button', { name: /Upload and inspect/ }));
    expect(await screen.findByText(/has no \.prj file/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(await screen.findByLabelText('Case'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(screen.getByLabelText('Source for legacy_ref'), 'PARCEL_NO');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(screen.getByText(/LAIS will not guess/)).toBeInTheDocument();
    expect(preview).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Declared coordinate system'), '4326');
    expect(preview).toBeDisabled();
    await user.type(screen.getByLabelText(/How the coordinate system was established/), 'Survey report SR-1 states WGS 84');
    expect(preview).toBeDisabled();
    await user.click(screen.getByLabelText(/I confirm the coordinate system/));
    expect(preview).toBeEnabled();
    await user.click(preview);
    await screen.findByText(/6\. Preview/);
    const sent = calls.find((c) => c.path === '/gis/imports/preview')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ caseId: 'c1', declaredCrs: 4326, crsExceptionReason: 'Survey report SR-1 states WGS 84', fieldMapping: { legacy_ref: 'PARCEL_NO' } });
    expect(calls.some((c) => c.path === '/gis/imports' && c.method === 'POST')).toBe(false);
  });
});

describe('Submit to supervisor', () => {
  it('offers no way to submit while blocking errors remain', async () => {
    stubApi({
      '/auth/session': GIS,
      '/gis/cases': [{ id: 'c1', case_no: 'CASE-2026-000009', case_type: 'first_registration', status: 'draft', county_id: 1, county_code: 'MO', version_no: 1, feature_count: 1 }],
      '/gis/cases/c1/submission-check': {
        caseNo: 'CASE-2026-000009', status: 'draft', ready: false, canSubmit: true, previous: null, returnReason: null, ruleSetVersion: 2, boundaryStatus: 'synthetic',
        items: [{ key: 'errors', label: 'No blocking validation errors', ok: false, detail: '1 error(s)' }],
        errors: [{ code: 'CROSSES_COUNTY_BOUNDARY', severity: 'error', message: 'The parcel crosses the boundary of the case county' }], warnings: [],
      },
    });
    renderApp(<SubmitWizard />, { path: '/gis/submit?case=c1' });
    expect(await screen.findByText(/CROSSES_COUNTY_BOUNDARY/)).toBeInTheDocument();
    expect(screen.getByText(/Errors cannot be waived here/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Summary for the supervisor/), 'Ready for review please');
    await userEvent.click(screen.getByLabelText(/I confirm the checklist/));
    expect(screen.getByRole('button', { name: 'Submit to supervisor' })).toBeDisabled();
  });
});

describe('ArcMap synchronization', () => {
  it('shows a new token once and never claims a live connection', async () => {
    const user = userEvent.setup();
    stubApi({
      '/auth/session': GIS, '/gis/sync/status': NOT_CONFIGURED, '/gis/sync/tokens': [],
      'POST /gis/sync/tokens': { id: 't1', label: 'Office PC', token_hint: 'Zz9q', created_at: '2026-10-28T10:00:00Z', expires_at: '2026-11-27T10:00:00Z', last_used_at: null, revoked_at: null, status: 'active', token: 'lais_sync_secretvalueZz9q' },
    });
    renderApp(<ArcmapSync />, { path: '/gis/sync' });
    expect(await screen.findByText(/No active sync token/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Label'), 'Office PC');
    await user.click(screen.getByRole('button', { name: /Create token/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Your new sync token' });
    expect(within(dialog).getByText('lais_sync_secretvalueZz9q')).toBeInTheDocument();
    expect(within(dialog).getByText(/shown only once/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'I have stored it' }));
    await waitFor(() => expect(screen.queryByText('lais_sync_secretvalueZz9q')).not.toBeInTheDocument());
  });
});
