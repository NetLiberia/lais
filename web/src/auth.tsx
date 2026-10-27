import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrfToken, type Session } from './api';

interface AuthValue {
  session: Session | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (...roles: string[]) => boolean;
  /** True if the account may perform any of the actions somewhere (interface only; the server decides). */
  can: (...actions: string[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const refresh = useCallback(async () => {
    const s = await api<Session>('/auth/session').catch(() => ({ authenticated: false }) as Session);
    setCsrfToken(s.csrfToken ?? null);
    setSession(s);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    await refresh();
  }, [refresh]);

  const hasRole = useCallback(
    (...roles: string[]) => !!session?.grants?.some((g) => roles.includes(g.role)),
    [session],
  );

  const can = useCallback(
    (...actions: string[]) => !!session?.capabilities?.some((c) => actions.includes(c)),
    [session],
  );

  return <AuthContext.Provider value={{ session, refresh, logout, hasRole, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export const INTERNAL_ROLES = ['gis_officer', 'processor', 'registrar', 'supervisor', 'auditor'];
/** Roles that work inside the staff application shell. */
export const STAFF_ROLES = [...INTERNAL_ROLES, 'system_admin'];
