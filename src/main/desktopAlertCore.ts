/**
 * desktopAlertCore.ts: the pure part of the desktop's late-order alerts (no
 * I/O, tested on its own in tests/alerts). Given what it remembered and the
 * latest look at the outlet's open orders, it says which orders just became
 * late. docs/DESKTOP_ALERTS.md.
 */
import { currentStep, levelIndexFor, where, type OrderWatchSnapshot } from './kotNotifierCore';

export interface LateAlert {
  orderId: string;
  orderNumber: number;
  tableNumber: string | null;
  minutes: number;
  level: string;
  title: string;
  message: string;
}

/** Per order: index of the highest waiting level already seen (-1 = none). */
export type LateMemory = Map<string, number>;

/**
 * Every waiting-time level that starts after 0 minutes (by default "Getting
 * late" at 10 and "Late" at 20) raises one alert per order when the order
 * reaches it. An order seen for the first time is only remembered, so a
 * restart does not announce every order that is already late. Cancelled
 * orders, and orders with every dish served, are never late. The "Tell phone"
 * ticks are for phones only and do not matter here.
 */
export function lateAlerts(memory: LateMemory, snap: OrderWatchSnapshot, now: Date): LateAlert[] {
  const out: LateAlert[] = [];
  const seen = new Set<string>();
  for (const o of snap.orders) {
    seen.add(o.orderId);
    const step = o.status === 'cancelled' ? null : currentStep(o, snap.steps);
    const live = step && step.code !== 'served' && o.since;
    const minutes = live
      ? Math.max(0, Math.floor((now.getTime() - new Date(o.since as string).getTime()) / 60000))
      : 0;
    const lvl = live ? levelIndexFor(minutes, snap.levels) : -1;
    const prev = memory.get(o.orderId);
    memory.set(o.orderId, lvl);
    if (prev === undefined || lvl <= prev) continue;
    const level = snap.levels[lvl];
    if (!level || level.fromMinutes <= 0) continue;
    out.push({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      tableNumber: o.tableNumber,
      minutes,
      level: level.name,
      title: `${where(o)}: order #${o.orderNumber} is ${level.name.toLowerCase()}`,
      message: `Waiting ${minutes} min in the kitchen (${step?.name ?? 'open'}).`,
    });
  }
  for (const id of [...memory.keys()]) if (!seen.has(id)) memory.delete(id);
  return out;
}
