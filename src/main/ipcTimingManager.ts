/**
 * ipcTiming.ts: `ipcMain.handle` that also times the call (docs/TIMINGS.md).
 * Every handler in ipcHandlers.ts is registered through `timedHandle`, so the
 * About page can show how long each screen's calls to the main process take
 * (most of that is the database round trip). The handler, its arguments and
 * its answer are untouched; a thrown error is counted and thrown on.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels } from '../shared/ipc';
import { nowMs, summaryLines, SUMMARY_EVERY_MS, timings } from './apiTimingsManager';

export function timedHandle<A extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const started = nowMs();
    try {
      const result = await listener(event, ...(args as A));
      timings.record('ipc', channel, nowMs() - started);
      return result;
    } catch (err) {
      timings.record('ipc', channel, nowMs() - started, true);
      throw err;
    }
  });
}

const SCREEN_NAME = /^[\w &()/-]{1,60}$/;

/**
 * The About page's Speed section: read and reset the numbers, and take screen
 * timings from the renderer. These calls are not timed themselves. Also writes
 * a summary to main.log every 30 minutes when something new was measured.
 */
export function registerTimingHandlers(): void {
  ipcMain.handle(IpcChannels.GET_TIMINGS, () => timings.snapshot());
  ipcMain.handle(IpcChannels.RESET_TIMINGS, () => {
    timings.reset();
    console.log('[timing] reset from the About page');
  });
  // invoke (not send), so the screen gets an error back if this ever fails.
  let firstScreen = true;
  ipcMain.handle(IpcChannels.RECORD_SCREEN_TIMING, (_event, screen: unknown, ms: unknown, failed: unknown) => {
    if (typeof screen !== 'string' || !SCREEN_NAME.test(screen) || typeof ms !== 'number') {
      throw new Error(`bad screen timing: ${String(screen).slice(0, 60)}`);
    }
    timings.record('screen', screen, ms, failed === true);
    if (firstScreen) {
      firstScreen = false;
      console.log(`[timing] first screen time received: ${screen} ${Math.round(ms)}ms`);
    }
  });

  let loggedAt = 0;
  const timer = setInterval(() => {
    const total = timings.totalCount();
    if (total === loggedAt) return;
    loggedAt = total;
    for (const line of summaryLines(timings.snapshot())) console.log(line);
  }, SUMMARY_EVERY_MS);
  timer.unref();
}
