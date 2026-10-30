import type React from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { INTERNAL_ROLES, STAFF_ROLES, useAuth } from './auth';
import { ROLE_LABELS } from './api';
import { PublicPortal } from './pages/PublicPortal';
import { Login } from './pages/Login';
import { SecondFactor } from './pages/SecondFactor';
import { Skeleton } from './components/kit';

// Administration pages (and the charting library) load only when opened, keeping the public and
// landowner portals small for slow connections.
// The export name is checked against the module at compile time.
const named = <M, K extends keyof M>(load: () => Promise<M>, name: K) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType<any> })));
// Staff, landowner and account pages also load on demand: the public map ships alone.
const AppShell = named(() => import('./shell/AppShell'), 'AppShell');
const CompleteAccount = named(() => import('./pages/CompleteAccount'), 'CompleteAccount');
const CaseList = named(() => import('./pages/CaseList'), 'CaseList');
const NewCase = named(() => import('./pages/NewCase'), 'NewCase');
const CaseDetail = named(() => import('./pages/CaseDetail'), 'CaseDetail');
const ParcelRecord = named(() => import('./pages/ParcelRecord'), 'ParcelRecord');
const Parties = named(() => import('./pages/Parties'), 'Parties');
const AuditLog = named(() => import('./pages/AuditLog'), 'AuditLog');
const MyParcels = named(() => import('./pages/MyParcels'), 'MyParcels');
const Account = named(() => import('./pages/Account'), 'Account');
const DocumentRequestList = named(() => import('./pages/DocumentRequests'), 'DocumentRequestList');
const DocumentRequestDetail = named(() => import('./pages/DocumentRequests'), 'DocumentRequestDetail');
const AdminDashboard = named(() => import('./pages/admin/AdminDashboard'), 'AdminDashboard');
const UsersPage = named(() => import('./pages/admin/UsersPage'), 'UsersPage');
const RolesPage = named(() => import('./pages/admin/RolesPage'), 'RolesPage');
const CountiesPage = named(() => import('./pages/admin/CountiesPage'), 'CountiesPage');
const ApplicationsOverview = named(() => import('./pages/admin/Overviews'), 'ApplicationsOverview');
const ParcelsOverview = named(() => import('./pages/admin/Overviews'), 'ParcelsOverview');
const ConflictsOverview = named(() => import('./pages/admin/Overviews'), 'ConflictsOverview');
const GisSyncPage = named(() => import('./pages/admin/GisSyncPage'), 'GisSyncPage');
const AdminAuditPage = named(() => import('./pages/admin/SystemPages'), 'AdminAuditPage');
const DocumentCategoriesPage = named(() => import('./pages/admin/SystemPages'), 'DocumentCategoriesPage');
const HealthPage = named(() => import('./pages/admin/SystemPages'), 'HealthPage');
const HelpPage = named(() => import('./pages/admin/SystemPages'), 'HelpPage');
const ReportsPage = named(() => import('./pages/admin/SystemPages'), 'ReportsPage');
const SettingsPage = named(() => import('./pages/admin/SystemPages'), 'SettingsPage');
// Supervision.
const SupervisorDashboard = named(() => import('./pages/supervisor/SupervisorDashboard'), 'SupervisorDashboard');
const WorkQueue = named(() => import('./pages/supervisor/WorkQueue'), 'WorkQueue');
const GisReviewQueue = named(() => import('./pages/supervisor/GisReview'), 'GisReviewQueue');
const GisReviewDetailPage = named(() => import('./pages/supervisor/GisReview'), 'GisReviewDetailPage');
const ConflictReview = named(() => import('./pages/supervisor/ConflictReview'), 'ConflictReview');
const TasksPage = named(() => import('./pages/supervisor/Tasks'), 'TasksPage');
const WorkloadPage = named(() => import('./pages/supervisor/Operations'), 'WorkloadPage');
const OverduePage = named(() => import('./pages/supervisor/Operations'), 'OverduePage');
const ActivityPage = named(() => import('./pages/supervisor/Operations'), 'ActivityPage');
const SupervisionReportsPage = named(() => import('./pages/supervisor/Reports'), 'ReportsPage');
const QualityPage = named(() => import('./pages/supervisor/Reports'), 'QualityPage');
const EscalationsPage = named(() => import('./pages/supervisor/Escalations'), 'EscalationsPage');
const NotificationsPage = named(() => import('./pages/NotificationsPage'), 'NotificationsPage');
// GIS officer workspace.
const GisDashboard = named(() => import('./pages/gis/GisDashboard'), 'GisDashboard');
const GisTasks = named(() => import('./pages/gis/GisTasks'), 'GisTasks');
const GisWorkspace = named(() => import('./pages/gis/Workspace'), 'Workspace');
const ImportWizard = named(() => import('./pages/gis/ImportWizard'), 'ImportWizard');
const ArcmapSync = named(() => import('./pages/gis/ArcmapSync'), 'ArcmapSync');
const GisJobs = named(() => import('./pages/gis/Jobs'), 'GisJobs');
const ValidationCenter = named(() => import('./pages/gis/ValidationCenter'), 'ValidationCenter');
const ValidationRules = named(() => import('./pages/gis/ValidationCenter'), 'ValidationRules');
const GisConflicts = named(() => import('./pages/gis/GisConflicts'), 'GisConflicts');
const Versions = named(() => import('./pages/gis/Versions'), 'Versions');
const SubmitWizard = named(() => import('./pages/gis/Submissions'), 'SubmitWizard');
const SubmissionsPage = named(() => import('./pages/gis/Submissions'), 'SubmissionsPage');
const ReturnedPage = named(() => import('./pages/gis/Submissions'), 'ReturnedPage');
const GisReports = named(() => import('./pages/gis/GisReports'), 'GisReports');
// LAIS processor workspace.
const ProcessorDashboard = named(() => import('./pages/processor/ProcessorDashboard'), 'ProcessorDashboard');
const NewApplication = named(() => import('./pages/processor/NewApplication'), 'NewApplication');
const ApplicationsPage = named(() => import('./pages/processor/Applications'), 'ApplicationsPage');
const ApplicationWorkspacePage = named(() => import('./pages/processor/ApplicationWorkspace'), 'ApplicationWorkspacePage');
const ApplicantsPage = named(() => import('./pages/processor/Applicants'), 'ApplicantsPage');
const DocumentCenter = named(() => import('./pages/processor/DocumentCenter'), 'DocumentCenter');
const InfoRequestsPage = named(() => import('./pages/processor/InfoRequests'), 'InfoRequestsPage');
const GisQueuePage = named(() => import('./pages/processor/Tracking'), 'GisQueuePage');
const ProcessorReturnedPage = named(() => import('./pages/processor/Tracking'), 'ReturnedPage');
const DecisionsPage = named(() => import('./pages/processor/Tracking'), 'DecisionsPage');
const HistoryPage = named(() => import('./pages/processor/Tracking'), 'HistoryPage');
const ProcessorReportsPage = named(() => import('./pages/processor/ProcessorReports'), 'ProcessorReportsPage');
const ApplicationConfigPage = named(() => import('./pages/admin/ApplicationConfigPage'), 'ApplicationConfigPage');

const DOCREQUEST_ROLES = ['processor', 'registrar', 'supervisor', 'auditor'];

/**
 * Route guard. Convenience only: it decides what to render, while the API enforces every permission and
 * county scope regardless of what the interface shows. `needs` lists capabilities (any one suffices).
 */
function RequireSession({ roles, needs, children }: { roles?: string[]; needs?: string[]; children: ReactNode }) {
  const { session, hasRole, can } = useAuth();
  const location = useLocation();
  if (!session) return <p className="muted pad">Loading…</p>;
  if (!session.authenticated) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  if (session.state !== 'active') return <Navigate to="/mfa" replace />;
  const allowed = (!roles || hasRole(...roles)) && (!needs || can(...needs));
  const content = allowed
    ? <Suspense fallback={<div className="pad"><Skeleton lines={6} /></div>}>{children}</Suspense>
    : <div className="pad"><h1>No access</h1><p>Your account does not have access to this area.</p></div>;
  const loading = <div className="pad"><Skeleton lines={6} /></div>;
  return hasRole(...STAFF_ROLES)
    ? <Suspense fallback={loading}><AppShell>{content}</AppShell></Suspense>
    : <><Header /><main><Suspense fallback={loading}>{content}</Suspense></main></>;
}

/** Sends a signed-in user to the workspace that matches their role. */
function Start() {
  const { session, hasRole } = useAuth();
  if (!session) return null;
  if (!session.authenticated) return <Navigate to="/login" replace />;
  if (session.state !== 'active') return <Navigate to="/mfa" replace />;
  if (hasRole('system_admin')) return <Navigate to="/admin" replace />;
  if (hasRole('supervisor')) return <Navigate to="/supervisor" replace />;
  if (hasRole('gis_officer')) return <Navigate to="/gis" replace />;
  if (hasRole('processor')) return <Navigate to="/processor" replace />;
  if (hasRole(...INTERNAL_ROLES)) return <Navigate to="/work" replace />;
  if (hasRole('landowner')) return <Navigate to="/me" replace />;
  return <Navigate to="/" replace />;
}

/** Header for the public portal, sign-in pages and the landowner portal. Staff use the application shell. */
function Header() {
  const { session, logout, hasRole } = useAuth();
  const active = session?.authenticated && session.state === 'active';
  return (
    <header className="topbar">
      <div className="brand">
        <strong>LAIS-Liberia</strong>
        <span className="badge warn">Research prototype · synthetic data only</span>
      </div>
      <nav>
        <NavLink to="/" end>Public map</NavLink>
        {active && hasRole(...STAFF_ROLES) && <NavLink to="/start">Staff workspace</NavLink>}
        {active && hasRole('landowner') && <NavLink to="/me">My land</NavLink>}
      </nav>
      <div className="who">
        {active ? (
          <>
            <NavLink to="/account" title="Account and security">{session!.user!.displayName}</NavLink>
            <small>{session!.grants!.map((g) => `${ROLE_LABELS[g.role] ?? g.role}${g.county ? ` (${g.county.code})` : ''}`).join(', ')}</small>
            <button className="link" onClick={() => void logout()}>Sign out</button>
          </>
        ) : (
          <NavLink to="/login">Staff / landowner sign in</NavLink>
        )}
      </div>
    </header>
  );
}

function Plain({ children }: { children: ReactNode }) {
  return <><Header /><main><Suspense fallback={<div className="pad"><Skeleton lines={4} /></div>}>{children}</Suspense></main></>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Plain><PublicPortal /></Plain>} />
      <Route path="/login" element={<Plain><Login /></Plain>} />
      <Route path="/mfa" element={<Plain><SecondFactor /></Plain>} />
      <Route path="/account/complete" element={<Plain><CompleteAccount /></Plain>} />
      <Route path="/start" element={<Start />} />
      <Route path="/account" element={<RequireSession><Account /></RequireSession>} />
      <Route path="/help" element={<RequireSession><HelpPage /></RequireSession>} />

      <Route path="/admin" element={<RequireSession needs={['dashboard.view']}><AdminDashboard /></RequireSession>} />
      <Route path="/admin/users" element={<RequireSession needs={['users.read']}><UsersPage /></RequireSession>} />
      <Route path="/admin/roles" element={<RequireSession needs={['users.read']}><RolesPage /></RequireSession>} />
      <Route path="/admin/counties" element={<RequireSession needs={['counties.manage']}><CountiesPage /></RequireSession>} />
      <Route path="/admin/applications" element={<RequireSession needs={['dashboard.view']}><ApplicationsOverview /></RequireSession>} />
      <Route path="/admin/parcels" element={<RequireSession needs={['dashboard.view']}><ParcelsOverview /></RequireSession>} />
      <Route path="/admin/conflicts" element={<RequireSession needs={['dashboard.view']}><ConflictsOverview /></RequireSession>} />
      <Route path="/admin/gis-sync" element={<RequireSession needs={['gis.sync.read']}><GisSyncPage /></RequireSession>} />
      <Route path="/admin/document-categories" element={<RequireSession needs={['system.configure']}><DocumentCategoriesPage /></RequireSession>} />
      <Route path="/admin/reports" element={<RequireSession needs={['reports.export']}><ReportsPage /></RequireSession>} />
      <Route path="/admin/audit" element={<RequireSession needs={['audit.view_technical', 'audit.view_all']}><AdminAuditPage /></RequireSession>} />
      <Route path="/admin/health" element={<RequireSession needs={['system.health']}><HealthPage /></RequireSession>} />
      <Route path="/admin/settings" element={<RequireSession needs={['system.configure']}><SettingsPage /></RequireSession>} />

      <Route path="/supervisor" element={<RequireSession needs={['supervision.view']}><SupervisorDashboard /></RequireSession>} />
      <Route path="/supervisor/queue" element={<RequireSession needs={['supervision.view']}><WorkQueue /></RequireSession>} />
      <Route path="/supervisor/gis-review" element={<RequireSession needs={['supervision.view']}><GisReviewQueue /></RequireSession>} />
      <Route path="/supervisor/gis-review/:caseId" element={<RequireSession needs={['supervision.view']}><GisReviewDetailPage /></RequireSession>} />
      <Route path="/supervisor/conflicts" element={<RequireSession needs={['supervision.view']}><ConflictReview /></RequireSession>} />
      <Route path="/supervisor/tasks" element={<RequireSession needs={['task.manage']}><TasksPage mode="scope" /></RequireSession>} />
      <Route path="/supervisor/workload" element={<RequireSession needs={['supervision.view']}><WorkloadPage /></RequireSession>} />
      <Route path="/supervisor/overdue" element={<RequireSession needs={['supervision.view']}><OverduePage /></RequireSession>} />
      <Route path="/supervisor/quality" element={<RequireSession needs={['reports.supervision']}><QualityPage /></RequireSession>} />
      <Route path="/supervisor/reports" element={<RequireSession needs={['reports.supervision']}><SupervisionReportsPage /></RequireSession>} />
      <Route path="/supervisor/activity" element={<RequireSession needs={['supervision.view']}><ActivityPage /></RequireSession>} />
      <Route path="/gis" element={<RequireSession needs={['gis.workspace']}><GisDashboard /></RequireSession>} />
      <Route path="/gis/tasks" element={<RequireSession needs={['task.work']}><GisTasks /></RequireSession>} />
      <Route path="/gis/workspace" element={<RequireSession needs={['gis.workspace']}><GisWorkspace /></RequireSession>} />
      <Route path="/gis/import" element={<RequireSession needs={['case.import_geometry']}><ImportWizard /></RequireSession>} />
      <Route path="/gis/sync" element={<RequireSession needs={['gis.sync_token']}><ArcmapSync /></RequireSession>} />
      <Route path="/gis/jobs" element={<RequireSession needs={['gis.workspace']}><GisJobs /></RequireSession>} />
      <Route path="/gis/validation" element={<RequireSession needs={['gis.workspace']}><ValidationCenter /></RequireSession>} />
      <Route path="/gis/validation/rules" element={<RequireSession needs={['validation.rules_view']}><ValidationRules /></RequireSession>} />
      <Route path="/gis/conflicts" element={<RequireSession needs={['gis.workspace']}><GisConflicts /></RequireSession>} />
      <Route path="/gis/versions" element={<RequireSession needs={['gis.workspace']}><Versions /></RequireSession>} />
      <Route path="/gis/submit" element={<RequireSession needs={['case.submit']}><SubmitWizard /></RequireSession>} />
      <Route path="/gis/submissions" element={<RequireSession needs={['gis.workspace']}><SubmissionsPage /></RequireSession>} />
      <Route path="/gis/returned" element={<RequireSession needs={['gis.workspace']}><ReturnedPage /></RequireSession>} />
      <Route path="/gis/reports" element={<RequireSession needs={['gis.reports']}><GisReports /></RequireSession>} />

      <Route path="/processor" element={<RequireSession needs={['application.register']}><ProcessorDashboard /></RequireSession>} />
      <Route path="/processor/new" element={<RequireSession needs={['application.register']}><NewApplication /></RequireSession>} />
      <Route path="/processor/applications" element={<RequireSession needs={['case.view']}><ApplicationsPage preset="all" /></RequireSession>} />
      <Route path="/processor/mine" element={<RequireSession needs={['application.register']}><ApplicationsPage preset="mine" /></RequireSession>} />
      <Route path="/processor/incomplete" element={<RequireSession needs={['case.view']}><ApplicationsPage preset="incomplete" /></RequireSession>} />
      <Route path="/processor/applications/:id" element={<RequireSession needs={['case.view']}><ApplicationWorkspacePage /></RequireSession>} />
      <Route path="/processor/applicants" element={<RequireSession needs={['applicant.view']}><ApplicantsPage /></RequireSession>} />
      <Route path="/processor/documents" element={<RequireSession needs={['case.view']}><DocumentCenter mode="repository" /></RequireSession>} />
      <Route path="/processor/verification" element={<RequireSession needs={['application.review_document']}><DocumentCenter mode="verification" /></RequireSession>} />
      <Route path="/processor/info-requests" element={<RequireSession needs={['info_request.view']}><InfoRequestsPage /></RequireSession>} />
      <Route path="/processor/gis-queue" element={<RequireSession needs={['case.view']}><GisQueuePage /></RequireSession>} />
      <Route path="/processor/returned" element={<RequireSession needs={['case.view']}><ProcessorReturnedPage /></RequireSession>} />
      <Route path="/processor/decisions" element={<RequireSession needs={['case.view']}><DecisionsPage /></RequireSession>} />
      <Route path="/processor/history" element={<RequireSession needs={['case.view']}><HistoryPage /></RequireSession>} />
      <Route path="/processor/reports" element={<RequireSession needs={['reports.processing']}><ProcessorReportsPage /></RequireSession>} />
      <Route path="/admin/application-config" element={<RequireSession needs={['application_config.view']}><ApplicationConfigPage /></RequireSession>} />

      <Route path="/escalations"element={<RequireSession needs={['escalation.view', 'escalation.view_system']}><EscalationsPage /></RequireSession>} />
      <Route path="/notifications" element={<RequireSession><NotificationsPage /></RequireSession>} />
      <Route path="/work/tasks" element={<RequireSession needs={['task.work']}><TasksPage mode="mine" /></RequireSession>} />

      <Route path="/work" element={<RequireSession roles={INTERNAL_ROLES}><CaseList /></RequireSession>} />
      <Route path="/work/cases/new" element={<RequireSession roles={['gis_officer', 'processor']}><NewCase /></RequireSession>} />
      <Route path="/work/cases/:id" element={<RequireSession roles={INTERNAL_ROLES}><CaseDetail /></RequireSession>} />
      <Route path="/work/parcels/:upi" element={<RequireSession roles={INTERNAL_ROLES}><ParcelRecord /></RequireSession>} />
      <Route path="/work/document-requests" element={<RequireSession roles={DOCREQUEST_ROLES}><DocumentRequestList /></RequireSession>} />
      <Route path="/work/document-requests/:id" element={<RequireSession roles={DOCREQUEST_ROLES}><DocumentRequestDetail /></RequireSession>} />
      <Route path="/work/parties" element={<RequireSession roles={['processor', 'registrar']}><Parties /></RequireSession>} />
      <Route path="/work/audit" element={<RequireSession roles={['supervisor', 'auditor']}><AuditLog /></RequireSession>} />
      {/* Old address of the user list. */}
      <Route path="/work/admin" element={<Navigate to="/admin/users" replace />} />
      <Route path="/me" element={<RequireSession roles={['landowner']}><MyParcels /></RequireSession>} />
      <Route path="*" element={<Plain><p className="pad">Page not found.</p></Plain>} />
    </Routes>
  );
}
