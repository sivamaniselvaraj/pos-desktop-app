import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ConfirmModal, type ConfirmOptions } from '../components/ConfirmModal';

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/**
 * Hosts the one confirmation modal for the whole app. Wraps <App /> in main.tsx.
 * A second request while one is open cancels the first (resolves it false).
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { options: opts, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
  }, []);

  const onConfirm = useCallback(() => close(true), [close]);
  const onCancel = useCallback(() => close(false), [close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmModal {...pending.options} onConfirm={onConfirm} onCancel={onCancel} />}
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm();` then `if (!(await confirm({ message }))) return;`
 * Resolves true on the confirm button, false on Cancel, Escape or a click outside.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}
