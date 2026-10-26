import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';

export function Login() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    let state = 'active';
    const ok = await run(async () => {
      state = (await api<{ state: string }>('/auth/login', { body: { username, password } })).state;
    });
    if (!ok) return;
    await refresh();
    const from = (location.state as { from?: string } | null)?.from;
    navigate(state === 'active' ? from ?? '/start' : '/mfa', { replace: true });
  };

  return (
    <div className="narrow">
      <h1>Sign in</h1>
      <p className="muted">Individual accounts only. Shared accounts are not permitted.</p>
      <form onSubmit={onSubmit} className="stack">
        <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
