import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Section, useAction } from '../components/ui';

export function MfaEnrollment({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  const start = () => run(async () => setSetup(await api('/auth/mfa/enroll/start', { method: 'POST' })));
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/auth/mfa/enroll/confirm', { body: { code } }))) onDone();
  };

  return (
    <div className="stack">
      {!setup ? (
        <button onClick={() => void start()} disabled={busy}>Generate a new authenticator secret</button>
      ) : (
        <form onSubmit={confirm} className="stack">
          <p>Add this key to an authenticator app (time-based, 6 digits, 30 seconds), then enter the current code.</p>
          <code className="secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          <details><summary>otpauth URI</summary><code className="small">{setup.otpauthUri}</code></details>
          <label>Code<input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button type="submit" disabled={busy}>Confirm</button>
        </form>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

export function Account() {
  const { session, refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/auth/password', { body: { currentPassword: current, newPassword: next } }))) {
      setDone('Password changed. Your other sessions have been signed out.');
      setCurrent('');
      setNext('');
    }
  };

  return (
    <div className="narrow">
      <h1>Account and security</h1>
      <Section title="Two-factor authentication">
        {session?.user?.mfaEnrolled
          ? <p>Enrolled. You will be asked for a code at each sign-in. Re-enrolling replaces the current key.</p>
          : <p>Not enrolled.</p>}
        <MfaEnrollment onDone={() => { void refresh(); setDone('Two-factor authentication enabled.'); }} />
      </Section>
      <Section title="Change password">
        <form onSubmit={changePassword} className="stack">
          <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
          <label>New password (12+ characters)<input type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
          <button type="submit" disabled={busy}>Change password</button>
        </form>
      </Section>
      <ErrorBox error={error} />
      {done && <div className="alert ok">{done}</div>}
    </div>
  );
}
