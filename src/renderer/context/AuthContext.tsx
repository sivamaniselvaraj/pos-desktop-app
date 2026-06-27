import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthResult, AuthUser } from '@shared/types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore a persisted session on first load.
  useEffect(() => {
    window.api
      .getSession()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

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
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
