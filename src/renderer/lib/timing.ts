/**
 * lib/timing.ts: how long a screen takes to show its data (docs/TIMINGS.md).
 *
 *   useScreenTiming('Dashboard', !loading, error !== null);
 *
 * Measures from the tap that opened the screen (markScreenOpen, called by the
 * sidebar and other navigation in App.tsx, so a lazy page's download counts)
 * or else from the moment the screen mounted, until the first time `ready` is
 * true and the browser has painted. One number per opening; later reloads are
 * not screen timings (their IPC calls are timed in the main process). The
 * number goes to the main process, which keeps it with the API and IPC
 * timings for About > Speed.
 */
import { useEffect, useRef, useState } from 'react';

let opened: { screen: string; at: number } | null = null;
let appStartPending = true;

/** Call when the user taps something that opens `screen` (before it renders). */
export function markScreenOpen(screen: string): void {
  opened = { screen, at: performance.now() };
}

/** Sidebar page code -> the screen name its page records. */
const PAGE_SCREENS: Record<string, string> = {
  dashboard: 'Dashboard',
  'orders-list': 'Orders list',
  'new-order': 'New order',
  'kot-board': 'KDS board',
  tables: 'Tables',
  'menu-items': 'Menu items',
  'sales-report': 'Sales report',
};

/** markScreenOpen for a sidebar page code (pages without a timing are ignored). */
export function markPageOpen(page: string): void {
  const screen = PAGE_SCREENS[page];
  if (screen) markScreenOpen(screen);
}

/** Called by the sign-in screen: the first screen after typing a password is not "app start". */
export function skipAppStartTiming(): void {
  appStartPending = false;
}

const OPEN_MARK_MAX_MS = 30_000;

function startFor(screen: string): number {
  const t = performance.now();
  if (opened && opened.screen === screen && t - opened.at < OPEN_MARK_MAX_MS) return opened.at;
  return t;
}

export function useScreenTiming(screen: string, ready: boolean, failed = false): void {
  const [start] = useState(() => startFor(screen));
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    if (opened?.screen === screen) opened = null;
    const send = () => {
      const end = performance.now();
      const report = (name: string, ms: number) => {
        try {
          void Promise.resolve(window.api.recordScreenTiming(name, ms, failed)).catch((err: unknown) =>
            console.warn('[timing] screen time not saved:', err),
          );
        } catch (err) {
          // Measuring must never break a screen.
          console.warn('[timing] screen time not saved:', err);
        }
      };
      report(screen, end - start);
      if (appStartPending) {
        appStartPending = false;
        // performance.now() counts from the moment the window started loading.
        report('App start (to first screen)', end);
      }
    };
    // After the next paint, so the time includes drawing the data. A hidden
    // window gets no animation frames, so send at once then.
    if (document.hidden) send();
    else requestAnimationFrame(send);
  }, [ready, failed, screen, start]);
}
