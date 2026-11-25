import { useEffect, useRef } from 'react';
import type { LiveChange, LiveChangeScope } from '@shared/liveTypes';

/**
 * Calls `onChange` when this outlet's orders or tables changed, on this
 * computer or elsewhere (IPC LIVE_CHANGED, docs/LIVE_UPDATES.md). Only the
 * given scopes count. While the window is hidden the call waits and runs once
 * when it is shown again. Replaces the screens' refresh timers.
 */
export function useLiveChange(scopes: LiveChangeScope[], onChange: (change: LiveChange) => void, enabled = true): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = scopes.join(',');

  useEffect(() => {
    if (!enabled || typeof window.api?.onLiveChange !== 'function') return;
    const wanted = new Set(key.split(','));
    let missed: LiveChange | null = null;
    const off = window.api.onLiveChange((change) => {
      if (!change.scopes.some((s) => wanted.has(s))) return;
      if (document.hidden) {
        missed = change;
        return;
      }
      cb.current(change);
    });
    const onVisible = () => {
      if (!document.hidden && missed) {
        const m = missed;
        missed = null;
        cb.current(m);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (typeof off === 'function') off();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, enabled]);
}
