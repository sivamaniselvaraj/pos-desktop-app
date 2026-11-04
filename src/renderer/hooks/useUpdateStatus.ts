import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/types';

/** The app-update status from the main process (updateManager.ts), kept current by its push. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let active = true;
    void window.api.getUpdateStatus().then((s) => {
      if (active) setStatus(s);
    });
    const off = window.api.onUpdateStatus(setStatus);
    return () => {
      active = false;
      off();
    };
  }, []);
  return status;
}
