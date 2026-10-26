import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';
import { MfaEnrollment } from './Account';

/** Second sign-in step: enter a TOTP code, or enrol first when MFA is mandatory for the role. */
export function SecondFactor() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  if (!session) return null;
  if (!session.authenticated) return <Navigate to="/login" replace />;
  if (session.state === 'active') return <Navigate to="/start" replace />;

  const done = async () => {
    await refresh();
    navigate('/start', { replace: true });
  };

  if (session.state === 'enrollment_required') {
    return (
      <div className="narrow">
        <h1>Set up two-factor authentication</h1>
        <p className="muted">Your role requires a second factor before you can continue.</p>
        <MfaEnrollment onDone={done} />
      </div>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/auth/mfa/verify', { body: { code } }))) await done();
  };

  return (
    <div className="narrow">
      <h1>Enter your authentication code</h1>
      <form onSubmit={onSubmit} className="stack">
        <label>6-digit code<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>Verify</button>
      </form>
    </div>
  );
}
