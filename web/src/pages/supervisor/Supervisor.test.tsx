import type { ReactElement, ReactNode } from 'react';
import { screen, within } from '@testing-library/react';
import { useAuth } from '../../auth';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFor, stubApi } from '../../test/render';
import { SupervisorDashboard } from './SupervisorDashboard';
import { ReturnDialog } from './CasePanel';
import { TaskDrawer } from './Tasks';
import { SupervisionScopeProvider } from './common';

const SUP = sessionFor('supervisor', ['supervision.view', 'supervision.review', 'task.manage', 'reports.supervision'], { id: 1, code: 'MO', name: 'Montserrado' });
const SCOPE = {
  national: false,
  counties: [{ id: 1, code: 'MO', name: 'Montserrado', enabled: true, boundary_status: 'synthetic' }],
  reviewMode: 'optional',
  stageTargets: null,
  issueCategories: [{ code: 'geometry_invalid', label: 'Invalid or empty geometry', applies_to: 'gis' }, { code: 'other', label: 'Other', applies_to: 'any' }],
  taskTypes: [{ key: 'document_review', label: 'Document completeness review', roles: ['processor'] }],
  stages: [{ key: 'preparation', label: 'Draft / in preparation', statuses: ['draft'] }],
};
const SUMMARY = {
  range: { from: '2026-09-28', to: '2026-10-27', countyId: null }, reviewMode: 'optional', applications_total: 4, applications_open: 4,
  awaiting_processing: 1, awaiting_quality_review: 2, returned_for_correction: 0, awaiting_registrar: 2, under_review: 2, overdue_tasks: 0,
  tasks_completed: 0, avg_processing_days: null, decided_count: 0, submissions_validated: 0, submissions_passed: 0, unresolved_conflicts: 0,
  quality_pass_rate: null, refreshedAt: '2026-10-27T10:00:00Z',
};
const EMPTY_CHARTS = {
  range: SUMMARY.range, stages: [{ key: 'preparation', label: 'Draft / in preparation', count: 0 }], workCompleted: [],
  gisQuality: { valid: 0, invalid: 0, warnings: 0, duplicate_identifiers: 0, invalid_geometries: 0, potential_overlaps: 0, out_of_boundary: 0, features: 0, boundariesVerified: false },
  stageDurations: [], staffWorkload: [], conflictStatus: [],
};
/** Like the app's route guard: render once the session has loaded. */
function Gate({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}
const inScope = (ui: ReactElement) => <Gate><SupervisionScopeProvider>{ui}</SupervisionScopeProvider></Gate>;

describe('Supervisor dashboard', () => {
  it('shows "no data" instead of inventing a rate or an average', async () => {
    stubApi({ '/auth/session': SUP, '/supervision/scope': SCOPE, '/supervision/dashboard/summary': SUMMARY, '/supervision/dashboard/charts': EMPTY_CHARTS });
    renderApp(inScope(<SupervisorDashboard />), { path: '/supervisor' });
    const rate = (await screen.findByText('Data-quality pass rate')).closest('.stat-card') as HTMLElement;
    expect(within(rate).getByText('—')).toBeInTheDocument();
    expect(within(rate).getByText('No submission was validated in the period')).toBeInTheDocument();
    const avg = screen.getByText('Average processing time').closest('.stat-card') as HTMLElement;
    expect(within(avg).getByText('No case was decided in the period')).toBeInTheDocument();
    expect(await screen.findByText('No submitted GIS records in scope')).toBeInTheDocument();
    expect(screen.getByText('No spatial conflicts detected in scope')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /./ }).filter((b) => b.classList.contains('stat-card'))).toHaveLength(10);
  });

  it('shows the server error with a retry instead of figures', async () => {
    stubApi({
      '/auth/session': SUP, '/supervision/scope': SCOPE, '/supervision/dashboard/charts': EMPTY_CHARTS,
      '/supervision/dashboard/summary': () => { throw { status: 403, error: 'This record is outside your assigned jurisdiction' }; },
    });
    renderApp(inScope(<SupervisorDashboard />), { path: '/supervisor' });
    expect(await screen.findByText(/outside your assigned jurisdiction/)).toBeInTheDocument();
    expect(screen.queryByText('Applications in scope')).not.toBeInTheDocument();
  });
});

describe('Return for correction', () => {
  it('requires an issue category and a reason before anything is sent', async () => {
    const user = userEvent.setup();
    const calls = stubApi({ '/auth/session': SUP, '/supervision/scope': SCOPE, 'POST /supervision/cases/c1/return': { task: { taskNo: 'TSK-000001', assignee: 'gis.mo' } } });
    renderApp(inScope(<ReturnDialog open caseId="c1" caseNo="CASE-1" onClose={() => undefined} records={[{ index: 0, label: 'Record 1' }]} />));
    const dialog = await screen.findByRole('dialog', { name: 'Return CASE-1 for correction' });
    await within(dialog).findByLabelText('Invalid or empty geometry');
    await user.click(within(dialog).getByRole('button', { name: /Return for correction/ }));
    expect(within(dialog).getByText('Select at least one issue category')).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Invalid or empty geometry'));
    await user.click(within(dialog).getByRole('button', { name: /Return for correction/ }));
    expect(within(dialog).getByText(/Explain what must be corrected/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(within(dialog).getByLabelText('Record 1'));
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Boundary does not follow the plan');
    await user.click(within(dialog).getByRole('button', { name: /Return for correction/ }));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ issueCategories: ['geometry_invalid'], affectedFeatures: [0], reason: 'Boundary does not follow the plan' });
  });
});

describe('Task drawer', () => {
  it('offers only the moves the server permits', async () => {
    stubApi({
      '/auth/session': SUP, '/supervision/scope': SCOPE,
      '/tasks/t1': {
        task: { id: 't1', task_no: 'TSK-000009', title: 'Check scans', task_type: 'document_review', type_label: 'Document completeness review', status: 'completed',
          priority: 'normal', county_id: 1, county_name: 'Montserrado', created_at: '2026-10-27T08:00:00Z', created_by_username: 'sup.mo', assignee: 'proc.mo',
          assignee_id: 'u2', due_date: null, overdue: false, completion_note: 'All checked', case_id: null, case_no: null },
        events: [{ id: '1', action: 'created', from_value: null, to_value: 'u2', note: null, reference: null, at: '2026-10-27T08:00:00Z', actor: 'sup.mo' }],
        permitted: { moves: ['returned'], assign: false, edit: false, comment: true, followUp: false },
      },
    });
    renderApp(inScope(<TaskDrawer id="t1" onClose={() => undefined} />));
    const drawer = await screen.findByRole('dialog', { name: 'TSK-000009: Check scans' });
    expect(await within(drawer).findByRole('button', { name: 'Return for more work' })).toBeInTheDocument();
    for (const name of ['Cancel task', 'Mark completed', 'Assign', 'Reassign', 'Priority / due date', 'Escalate']) {
      expect(within(drawer).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(drawer).getByText(/All checked/)).toBeInTheDocument();
  });
});
