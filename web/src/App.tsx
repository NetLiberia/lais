import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { INTERNAL_ROLES, useAuth } from './auth';
import { ROLE_LABELS } from './api';
import { PublicPortal } from './pages/PublicPortal';
import { Login } from './pages/Login';
import { SecondFactor } from './pages/SecondFactor';
import { CaseList } from './pages/CaseList';
import { NewCase } from './pages/NewCase';
import { CaseDetail } from './pages/CaseDetail';
import { ParcelRecord } from './pages/ParcelRecord';
import { Parties } from './pages/Parties';
import { AuditLog } from './pages/AuditLog';
import { AdminUsers } from './pages/AdminUsers';
import { MyParcels } from './pages/MyParcels';
import { Account } from './pages/Account';
import { DocumentRequestDetail, DocumentRequestList } from './pages/DocumentRequests';

const DOCREQUEST_ROLES = ['processor', 'registrar', 'supervisor', 'auditor'];

function RequireSession({ roles, children }: { roles?: string[]; children: ReactNode }) {
  const { session, hasRole } = useAuth();
  const location = useLocation();
  if (!session) return <p className="muted pad">Loading…</p>;
  if (!session.authenticated) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (session.state !== 'active') return <Navigate to="/mfa" replace />;
  // Convenience only: the API enforces every permission regardless of what the UI shows.
  if (roles && !hasRole(...roles)) return <p className="pad">Your account does not have access to this workspace.</p>;
  return <>{children}</>;
}

/** Sends a signed-in user to the workspace that matches their role. */
function Start() {
  const { session, hasRole } = useAuth();
  if (!session) return null;
  if (!session.authenticated) return <Navigate to="/login" replace />;
  if (session.state !== 'active') return <Navigate to="/mfa" replace />;
  if (hasRole(...INTERNAL_ROLES)) return <Navigate to="/work" replace />;
  if (hasRole('system_admin')) return <Navigate to="/work/admin" replace />;
  if (hasRole('landowner')) return <Navigate to="/me" replace />;
  return <Navigate to="/" replace />;
}

function Header() {
  const { session, logout, hasRole } = useAuth();
  const active = session?.authenticated && session.state === 'active';
  return (
    <header className="topbar">
      <div className="brand">
        <strong>LAIS</strong>
        <span className="badge warn">Research prototype · synthetic data only</span>
      </div>
      <nav>
        <NavLink to="/" end>Public map</NavLink>
        {active && hasRole(...INTERNAL_ROLES) && <NavLink to="/work">Cases</NavLink>}
        {active && hasRole(...DOCREQUEST_ROLES) && <NavLink to="/work/document-requests">Document requests</NavLink>}
        {active && hasRole('processor', 'registrar') && <NavLink to="/work/parties">Parties</NavLink>}
        {active && hasRole('supervisor', 'auditor', 'system_admin') && <NavLink to="/work/audit">Audit</NavLink>}
        {active && hasRole('system_admin') && <NavLink to="/work/admin">Users</NavLink>}
        {active && hasRole('landowner') && <NavLink to="/me">My land</NavLink>}
      </nav>
      <div className="who">
        {active ? (
          <>
            <NavLink to="/account" title="Account and security">
              {session!.user!.displayName}
            </NavLink>
            <small>
              {session!.grants!.map((g) => `${ROLE_LABELS[g.role] ?? g.role}${g.county ? ` (${g.county.code})` : ''}`).join(', ')}
            </small>
            <button className="link" onClick={() => void logout()}>Sign out</button>
          </>
        ) : (
          <NavLink to="/login">Staff / landowner sign in</NavLink>
        )}
      </div>
    </header>
  );
}

export function App() {
  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<PublicPortal />} />
          <Route path="/login" element={<Login />} />
          <Route path="/mfa" element={<SecondFactor />} />
          <Route path="/start" element={<Start />} />
          <Route path="/account" element={<RequireSession><Account /></RequireSession>} />
          <Route path="/work" element={<RequireSession roles={INTERNAL_ROLES}><CaseList /></RequireSession>} />
          <Route path="/work/cases/new" element={<RequireSession roles={['gis_officer', 'processor']}><NewCase /></RequireSession>} />
          <Route path="/work/cases/:id" element={<RequireSession roles={INTERNAL_ROLES}><CaseDetail /></RequireSession>} />
          <Route path="/work/parcels/:upi" element={<RequireSession roles={INTERNAL_ROLES}><ParcelRecord /></RequireSession>} />
          <Route path="/work/document-requests" element={<RequireSession roles={DOCREQUEST_ROLES}><DocumentRequestList /></RequireSession>} />
          <Route path="/work/document-requests/:id" element={<RequireSession roles={DOCREQUEST_ROLES}><DocumentRequestDetail /></RequireSession>} />
          <Route path="/work/parties" element={<RequireSession roles={['processor', 'registrar']}><Parties /></RequireSession>} />
          <Route path="/work/audit" element={<RequireSession roles={['supervisor', 'auditor', 'system_admin']}><AuditLog /></RequireSession>} />
          <Route path="/work/admin" element={<RequireSession roles={['system_admin']}><AdminUsers /></RequireSession>} />
          <Route path="/me" element={<RequireSession roles={['landowner']}><MyParcels /></RequireSession>} />
          <Route path="*" element={<p className="pad">Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
