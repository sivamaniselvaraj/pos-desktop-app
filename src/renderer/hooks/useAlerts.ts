import { useEffect, useState } from 'react';
import type { AlertSnapshot } from '@shared/alertTypes';
import { playAlertSound } from '../lib/alertSound';

/**
 * Desktop alerts (docs/DESKTOP_ALERTS.md): read once, then pushed by the main
 * process on every change. Pass `sound: true` in exactly one place (the
 * failed-KOT banner, always mounted) so each alert plays once.
 */
export function useAlerts(opts: { sound?: boolean } = {}): AlertSnapshot | null {
  const [snap, setSnap] = useState<AlertSnapshot | null>(null);
  const sound = opts.sound === true;

  useEffect(() => {
    let active = true;
    void window.api
      .getAlerts()
      .then((s:any) => {
        if (active) setSnap(s);
      })
      .catch(() => undefined);
    const off = window.api.onAlerts(({ snapshot, fresh }) => {
      setSnap(snapshot);
      if (sound && fresh && snapshot.settings.sound) playAlertSound(fresh.kind);
    });
    return () => {
      active = false;
      off();
    };
  }, [sound]);

  return snap;
}
