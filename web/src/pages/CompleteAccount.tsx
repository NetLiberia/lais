import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api } from '../api';
import { ErrorBanner } from '../components/kit';

const schema = z.object({
  password: z.string().min(12, 'Use at least 12 characters').max(256),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

/** Public page reached from a single-use activation or password-reset link. */
export function CompleteAccount() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<{ purpose: string; username: string; displayName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!token) { setError('This link is incomplete.'); return; }
    api<{ purpose: string; username: string; displayName: string }>('/auth/token/inspect', { body: { token } })
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  }, [token]);

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await api<{ username: string }>('/auth/token/complete', { body: { token, newPassword: v.password } });
      setDone(r.username);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <div className="narrow">
      <h1>{info?.purpose === 'password_reset' ? 'Set a new password' : 'Activate your account'}</h1>
      {done ? (
        <div className="stack">
          <div className="alert ok">Your password is set. You can now sign in as <strong>{done}</strong>.</div>
          <Link className="button" to="/login">Go to sign in</Link>
        </div>
      ) : info ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <p>Account: <strong>{info.displayName}</strong> ({info.username}). Choose a password only you know; nobody at LAIS will ever ask for it.</p>
          <label>New password<input type="password" autoComplete="new-password" {...form.register('password')} />{form.formState.errors.password && <span className="field-error">{form.formState.errors.password.message}</span>}</label>
          <label>Repeat the password<input type="password" autoComplete="new-password" {...form.register('confirm')} />{form.formState.errors.confirm && <span className="field-error">{form.formState.errors.confirm.message}</span>}</label>
          <ErrorBanner error={error} />
          <button type="submit" disabled={form.formState.isSubmitting}>Set password</button>
        </form>
      ) : (
        error ? <ErrorBanner error={error} /> : <p className="muted">Checking the link…</p>
      )}
    </div>
  );
}
