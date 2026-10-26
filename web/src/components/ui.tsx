import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABELS } from '../api';

/** Loads data on mount and exposes a reload function. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    return loader().then(setData).catch((e: Error) => setError(e.message));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Runs an action, tracking busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="alert error" role="alert">{error}</div>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
