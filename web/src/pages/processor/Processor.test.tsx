import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFor, stubApi } from '../../test/render';
import { ProcessorDashboard } from './ProcessorDashboard';
import { NewApplication } from './NewApplication';
import { DocumentViewer } from './common';
import { DecisionsPage } from './Tracking';

const MO = { id: 1, code: 'MO', name: 'Montserrado' };
const PROC = sessionFor('processor', ['application.register', 'case.view', 'applicant.view', 'applicant.manage', 'info_request.manage', 'application.handoff', 'application.review_document'], MO);
const KPIS = {
  total_registered: 7, new_in_period: 3, awaiting_document_review: 2, complete: 1, incomplete: 4, awaiting_information: 1, awaiting_gis: 1,
  gis_processing: 0, returned: 0, awaiting_registrar: 2, completed_in_period: 0, overdue_tasks: 1, my_open: 5,
};
const EMPTY_LIST = { items: [], total: 0, page: 1, pageSize: 8, stageLabels: {}, completenessLabels: {} };

describe('Processor dashboard', () => {
  it('shows the twelve figures from the server and the officer\'s own workload', async () => {
    stubApi({ '/auth/session': PROC, '/processor/summary': { kpis: KPIS, range: { from: '2026-10-01', to: '2026-10-30' }, refreshedAt: '2026-10-30T10:00:00Z' }, '/applications': EMPTY_LIST });
    renderApp(<ProcessorDashboard />, { path: '/processor' });
    const incomplete = (await screen.findByText('Incomplete applications')).closest('.stat-card') as HTMLElement;
    expect(within(incomplete).getByText('4')).toBeInTheDocument();
    expect(screen.getAllByRole('button').filter((b) => b.classList.contains('stat-card'))).toHaveLength(12);
    expect(screen.getByText(/application\(s\) under your responsibility/)).toBeInTheDocument();
    expect(screen.getByText(/not legal verification/)).toBeInTheDocument();
    expect(await screen.findByText('No applications assigned to you')).toBeInTheDocument();
  });

  it('shows the server error instead of figures', async () => {
    stubApi({ '/auth/session': PROC, '/applications': EMPTY_LIST, '/processor/summary': () => { throw { status: 403, error: 'This record is outside your assigned jurisdiction' }; } });
    renderApp(<ProcessorDashboard />, { path: '/processor' });
    expect(await screen.findByText(/outside your assigned jurisdiction/)).toBeInTheDocument();
    expect(screen.queryByText('Total applications registered')).not.toBeInTheDocument();
  });
});

describe('Registration wizard', () => {
  it('stops at a possible duplicate and registers only with a recorded reason', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = stubApi({
      '/auth/session': PROC,
      '/applications/categories': { categories: [{ code: 'first_registration', label: 'First registration of a parcel', description: null, case_type: 'first_registration', requirements: [] }] },
      'POST /applications': () => {
        attempts++;
        if (attempts === 1) throw { status: 409, error: 'This may duplicate an application already registered.', details: { duplicates: [{ caseNo: 'CASE-2026-000003', applicantNo: 'APL-000001', matchReason: 'same declared parcel reference' }] } };
        return { id: 'c1', caseNo: 'CASE-2026-000009', applicantNo: 'APL-000004' };
      },
      '/applications/c1': { documents: [], application: {}, applicant: null, completeness: null },
    });
    renderApp(<NewApplication />, { path: '/processor/new' });
    await user.type(await screen.findByLabelText('Full name or registered name (required)'), 'Test Applicant');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(await screen.findByLabelText('Application category (required)'), 'first_registration');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('3. Declared parcel information')).toBeInTheDocument();
    expect(screen.getByText((_, el) => !!el?.classList.contains('alert') && /applicant's declaration.*unverified/.test(el.textContent ?? ''))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft and continue' }));
    expect(await screen.findByText(/CASE-2026-000003 \(applicant APL-000001\): same declared parcel reference/)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Register anyway as a separate application' });
    expect(retry).toBeDisabled();
    await user.type(screen.getByLabelText('Why this is not a duplicate'), 'Different plot of the same family');
    await user.click(retry);
    expect(await screen.findByText(/4\. Supporting documents for CASE-2026-000009/)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/applications').map((c) => c.body as Record<string, unknown>);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ mode: 'draft', categoryCode: 'first_registration', countyId: 1, applicant: expect.objectContaining({ name: 'Test Applicant', phone: null }) });
    expect(posts[0]).not.toHaveProperty('duplicateReview');
    expect(posts[1].duplicateReview).toEqual({ reason: 'Different plot of the same family' });
  });
});

describe('Document viewer', () => {
  it('hides a highly sensitive document from an officer without that permission', async () => {
    stubApi({
      '/auth/session': PROC,
      '/documents/d1': {
        document: { id: 'd1', document_no: 'DOC-000001', doc_type: 'id_document', doc_label: 'Identity document', title: null, description: null, reference_no: null, issuer: null, issued_on: null,
          classification: 'highly_sensitive', mime_type: 'application/pdf', size_bytes: 2048, original_name: null, sha256: 'a'.repeat(64), version_no: 1, review_status: 'not_reviewed',
          uploaded_at: '2026-10-30T10:00:00Z', uploaded_by: 'proc.mo', uploaded_by_id: 'u9', case_id: 'c1', case_no: 'CASE-2026-000001', previewable: true, restricted: true },
        versions: [{ id: 'd1', document_no: 'DOC-000001', version_no: 1, review_status: 'not_reviewed', uploaded_at: '2026-10-30T10:00:00Z', replacement_reason: null, uploaded_by: 'proc.mo' }],
        history: [], can: { download: false, review: false, replace: false }, notice: 'Review statuses describe administrative processing only; they do not establish legal validity.',
      },
    });
    renderApp(<DocumentViewer id="d1" onClose={() => undefined} />);
    expect(await screen.findByText('hidden (highly sensitive)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record review' })).not.toBeInTheDocument();
    expect(screen.getByText(/do not establish legal validity/)).toBeInTheDocument();
  });
});

describe('Registrar decision tracking', () => {
  it('is read-only: it shows the registrar\'s records and offers no decision controls', async () => {
    stubApi({
      '/auth/session': PROC,
      '/processor/decisions': {
        items: [{ id: 'c1', case_no: 'CASE-2026-000001', county_code: 'MO', parcel_upi: null, declared_parcel_ref: 'DECL-1', submitted_at: '2026-10-29T10:00:00Z', decision: 'approved',
          decided_at: '2026-10-30T09:00:00Z', decision_summary: 'Evidence reviewed and consistent', registrar: 'reg.mo', supervisor_decision: null, supervisor_at: null, tracking_status: 'approved', status: 'approved' }],
        labels: { approved: 'Approved', awaiting_registrar_review: 'Awaiting Registrar review' }, notice: 'Read-only.',
      },
    });
    renderApp(<DecisionsPage />, { path: '/processor/decisions' });
    expect(await screen.findByText('Evidence reviewed and consistent')).toBeInTheDocument();
    expect(screen.getByText('reg.mo')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /approve|reject|decide/i })).toHaveLength(0));
  });
});
