/**
 * kotNotifierCore.ts: the pure part of phone notifications (no I/O, so it can
 * be tested on its own). Given the previous state it was told about and the
 * latest snapshot of phone-placed orders, it says which notifications to send.
 */

export interface PhoneStep {
  code: string;
  name: string;
  notifyWaiter: boolean;
  sortOrder: number;
}
export interface PhoneLevel {
  name: string;
  fromMinutes: number;
  notify: boolean;
}
export interface PhoneOrder {
  orderId: string;
  orderNumber: number;
  deviceId: string;
  tableNumber: string | null;
  orderType: string;
  /** orders.status */
  status: string;
  /** item count per order_items.status */
  statuses: Record<string, number>;
  /** When the oldest unfinished item was created (ISO). Null when everything is done. */
  since: string | null;
}
export interface PhoneSnapshot {
  steps: PhoneStep[];
  levels: PhoneLevel[];
  orders: PhoneOrder[];
}

export type NotificationType = 'status' | 'delay' | 'cancelled';
export interface PhoneNotification {
  type: NotificationType;
  deviceId: string;
  orderId: string;
  orderNumber: number;
  tableNumber: string | null;
  title: string;
  message: string;
  /** For 'status': the step code the order is now in. */
  status?: string;
  /** For 'delay': minutes the order has waited. */
  minutes?: number;
  level?: string;
}

/** What we remember per order between two looks. */
export interface OrderMemory {
  /** The order's step code the phone was last told about / saw. */
  step: string;
  cancelled: boolean;
  /** Index of the highest waiting level already announced (-1 = none). */
  levelIndex: number;
}
export type Memory = Map<string, OrderMemory>;

/** The order's step is that of its least advanced live item. Null when no item is live. */
export function currentStep(o: PhoneOrder, steps: PhoneStep[]): PhoneStep | null {
  let best: PhoneStep | null = null;
  for (const s of steps) {
    if ((o.statuses[s.code] ?? 0) > 0 && s.code !== 'cancelled') {
      if (!best || s.sortOrder < best.sortOrder) best = s;
    }
  }
  return best;
}

function levelIndexFor(minutes: number, levels: PhoneLevel[]): number {
  let idx = -1;
  levels.forEach((l, i) => {
    if (minutes >= l.fromMinutes) idx = i;
  });
  return idx;
}

function where(o: PhoneOrder): string {
  return o.tableNumber ? `Table ${o.tableNumber}` : o.orderType === 'pickup' ? 'Takeaway' : 'Order';
}

/**
 * Compares the snapshot with memory (which it updates) and returns what to
 * send. An order seen for the first time is only remembered, never announced:
 * the phone that placed it already knows, and after a desktop restart old
 * orders must not be announced again.
 */
export function diffStates(memory: Memory, snap: PhoneSnapshot, now: Date): PhoneNotification[] {
  const out: PhoneNotification[] = [];
  const seen = new Set<string>();
  const stepByCode = new Map(snap.steps.map((s) => [s.code, s]));

  for (const o of snap.orders) {
    seen.add(o.orderId);
    const cancelled = o.status === 'cancelled';
    const step = currentStep(o, snap.steps);
    const stepCode = step?.code ?? (cancelled ? 'cancelled' : 'served');
    const minutes = o.since ? Math.max(0, Math.floor((now.getTime() - new Date(o.since).getTime()) / 60000)) : 0;
    const lvl = cancelled || !step || step.code === 'served' ? -1 : levelIndexFor(minutes, snap.levels);

    const prev = memory.get(o.orderId);
    if (!prev) {
      memory.set(o.orderId, { step: stepCode, cancelled, levelIndex: lvl });
      continue;
    }

    const base = { deviceId: o.deviceId, orderId: o.orderId, orderNumber: o.orderNumber, tableNumber: o.tableNumber };

    if (cancelled && !prev.cancelled) {
      out.push({
        ...base,
        type: 'cancelled',
        title: `Order #${o.orderNumber} cancelled`,
        message: `${where(o)}: order #${o.orderNumber} was cancelled.`,
      });
      prev.cancelled = true;
      prev.step = stepCode;
      continue;
    }
    if (cancelled) continue;

    if (step && stepCode !== prev.step) {
      const def = stepByCode.get(stepCode);
      if (def?.notifyWaiter) {
        out.push({
          ...base,
          type: 'status',
          status: stepCode,
          title: `Order #${o.orderNumber}: ${def.name}`,
          message: `${where(o)}: order #${o.orderNumber} is now ${def.name}.`,
        });
      }
      prev.step = stepCode;
    }

    if (lvl > prev.levelIndex) {
      const level = snap.levels[lvl];
      if (level?.notify) {
        out.push({
          ...base,
          type: 'delay',
          minutes,
          level: level.name,
          title: `Order #${o.orderNumber} is waiting`,
          message: `${where(o)}: order #${o.orderNumber} has waited ${minutes} min (${level.name}).`,
        });
      }
      prev.levelIndex = lvl;
    } else if (lvl < prev.levelIndex) {
      prev.levelIndex = lvl; // back to a lower level or finished
    }
  }

  for (const id of [...memory.keys()]) if (!seen.has(id)) memory.delete(id);
  return out;
}
