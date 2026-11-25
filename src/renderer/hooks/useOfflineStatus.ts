import { useEffect, useState } from 'react';
import type { OfflineStatus } from '@shared/offlineTypes';

/** Offline mode status (docs/OFFLINE_MODE.md): read once, then pushed by the main process on every change. */
export function useOfflineStatus(): OfflineStatus | null {
  const [status, setStatus] = useState<OfflineStatus | null>(null);

  useEffect(() => {
    let active = true;
    void window.api
      .getOfflineStatus()
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => undefined);
    const off = window.api.onOfflineStatus(setStatus);
    return () => {
      active = false;
      off();
    };
  }, []);

  return status;
}
