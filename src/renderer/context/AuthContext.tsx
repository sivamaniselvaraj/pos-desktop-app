import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthResult, AuthUser, MyAccess } from '@shared/types';
import { setOrgFormat } from '../lib/format';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Permissions and sidebar menus from the database; null until loaded. */
  access: MyAccess | null;
  /** True when the signed-in user has the permission (UI only; the database enforces it). */
  can: (permission: string) => boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<MyAccess | null>(null);

  // Restore a persisted session on first load.
  useEffect(() => {
    window.api
      .getSession()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  // (Re)load permissions and menus whenever the signed-in user changes.
  useEffect(() => {
    if (!user) {
      setAccess(null);
      setOrgFormat(null);
      return;
    }
    let cancelled = false;
    window.api
      .getMyAccess()
      .then((a) => {
        if (cancelled) return;
        const next = a ?? { role: user.role, org: null, permissions: [], menus: [] };
        setOrgFormat(next.org); // before the pages render, so money/dates use the organization's settings
        setAccess(next);
      })
      .catch(() => {
        if (!cancelled) setAccess({ role: user.role, org: null, permissions: [], menus: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const can = (permission: string): boolean => !!access?.permissions.includes(permission);

  const signIn = async (email: string, password: string): Promise<AuthResult> => {
    const result = await window.api.signIn(email, password);
    if (result.success && result.user) setUser(result.user);
    return result;
  };

  const signOut = async (): Promise<void> => {
    await window.api.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, access, can, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
