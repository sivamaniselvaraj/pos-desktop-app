import type { DesktopAlertKind } from '@shared/alertTypes';

/**
 * Alert sounds (docs/DESKTOP_ALERTS.md), made with the Web Audio API: no sound
 * files to ship, nothing loaded until the first alert. One AudioContext for
 * the whole app; at most one sound every 1.5 s so a burst of late orders
 * plays once.
 *
 *  - new-order: two soft rising notes
 *  - kot-failed: three sharp beeps (the one that must be heard)
 *  - late: two falling notes
 */

type Note = { hz: number; ms: number; type: OscillatorType; gain: number };

const PATTERNS: Record<DesktopAlertKind, Note[]> = {
  'new-order': [
    { hz: 660, ms: 140, type: 'sine', gain: 0.25 },
    { hz: 880, ms: 220, type: 'sine', gain: 0.25 },
  ],
  'kot-failed': [
    { hz: 920, ms: 160, type: 'square', gain: 0.12 },
    { hz: 920, ms: 160, type: 'square', gain: 0.12 },
    { hz: 920, ms: 260, type: 'square', gain: 0.12 },
  ],
  late: [
    { hz: 600, ms: 180, type: 'triangle', gain: 0.3 },
    { hz: 450, ms: 260, type: 'triangle', gain: 0.3 },
  ],
};

const GAP_MS = 70;
const MIN_INTERVAL_MS = 1500;
let ctx: AudioContext | null = null;
let lastAt = 0;

export function playAlertSound(kind: DesktopAlertKind, force = false): void {
  const now = Date.now();
  if (!force && now - lastAt < MIN_INTERVAL_MS) return;
  lastAt = now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    let t = ctx.currentTime + 0.02;
    for (const n of PATTERNS[kind]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type;
      osc.frequency.value = n.hz;
      const end = t + n.ms / 1000;
      // Short fade in and out so the notes do not click.
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(n.gain, t + 0.015);
      g.gain.setValueAtTime(n.gain, end - 0.03);
      g.gain.linearRampToValueAtTime(0, end);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(end + 0.01);
      t = end + GAP_MS / 1000;
    }
  } catch {
    // No audio device: the banner, the bell and the Windows notification still show.
  }
}
