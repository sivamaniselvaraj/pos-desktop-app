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

/**
 * An open order of the outlet, placed anywhere (desktop alerts and phone
 * notifications watch these). deviceId is null for orders typed on a desktop.
 * userId: orders.waiter_id (the phone's user, or the desktop's signed-in user).
 */
export type WatchOrder = Omit<PhoneOrder, 'deviceId'> & {
  deviceId: string | null;
  userId?: string | null;
};
export interface OrderWatchSnapshot {
  steps: PhoneStep[];
  levels: PhoneLevel[];
  orders: WatchOrder[];
  /** False when the database has no get_order_watch yet: only phone orders are in `orders`. */
  allOrders: boolean;
}

/** The phone-placed orders of a watch snapshot, for diffStates. */
export function phoneSnapshot(w: OrderWatchSnapshot): PhoneSnapshot {
  return {
    steps: w.steps,
    levels: w.levels,
    orders: w.orders.filter((o): o is PhoneOrder => Boolean(o.deviceId)),
  };
}

/** A paired phone, as config.apiDevices stores it. */
export interface PairedPhone {
  id: string;
  userId?: string;
}

/** Who hears about an order: the phones to tell, and whether it was typed on a desktop. */
export interface OrderRoute {
  deviceIds: string[];
  /** Typed on a desktop (at the counter), told to the waiter already serving its table. */
  fromCounter: boolean;
}

/**
 * Which phones hear about each order (docs/DESKTOP_ALERTS.md, "Phones: alerts by waiter", 2026-11-28).
 *  - An order placed from a phone: that phone, and every other phone paired with the same
 *    login (a waiter with two phones hears on both).
 *  - A dine-in order typed on a desktop: the waiters "serving" its table, i.e. the phones
 *    (and their logins' other phones) that have an open, not cancelled order on the same table.
 *  - A desktop takeaway order, or a desktop order on a table no phone has ordered for: nobody.
 * Only phones paired now are listed.
 */
export function routeOrders(orders: WatchOrder[], phones: PairedPhone[]): Map<string, OrderRoute> {
  const paired = new Set(phones.map((p) => p.id));
  const byUser = new Map<string, string[]>();
  for (const p of phones) {
    if (!p.userId) continue;
    const list = byUser.get(p.userId) ?? [];
    list.push(p.id);
    byUser.set(p.userId, list);
  }
  const userOf = new Map(phones.map((p) => [p.id, p.userId]));
  const phonesOfOrder = (o: WatchOrder): Set<string> => {
    const out = new Set<string>();
    if (!o.deviceId) return out;
    if (paired.has(o.deviceId)) out.add(o.deviceId);
    const user = o.userId || userOf.get(o.deviceId);
    for (const id of (user && byUser.get(user)) || []) out.add(id);
    return out;
  };

  const serving = new Map<string, Set<string>>(); // table number -> phones serving it
  for (const o of orders) {
    if (!o.deviceId || !o.tableNumber || o.status === 'cancelled') continue;
    const set = serving.get(o.tableNumber) ?? new Set<string>();
    for (const id of phonesOfOrder(o)) set.add(id);
    serving.set(o.tableNumber, set);
  }

  const routes = new Map<string, OrderRoute>();
  for (const o of orders) {
    if (o.deviceId) routes.set(o.orderId, { deviceIds: [...phonesOfOrder(o)], fromCounter: false });
    else if (o.tableNumber && serving.has(o.tableNumber))
      routes.set(o.orderId, {
        deviceIds: [...(serving.get(o.tableNumber) as Set<string>)],
        fromCounter: true,
      });
  }
  return routes;
}

/** 'kot-failed': the order's kitchen ticket did not print (sent by desktopAlerts.ts, 2026-11-27). */
export type NotificationType = 'status' | 'delay' | 'cancelled' | 'kot-failed';
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
  /** True when the order was typed on a desktop, not on this phone (2026-11-28). */
  fromCounter?: boolean;
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
export function currentStep(o: Pick<PhoneOrder, 'statuses'>, steps: PhoneStep[]): PhoneStep | null {
  let best: PhoneStep | null = null;
  for (const s of steps) {
    if ((o.statuses[s.code] ?? 0) > 0 && s.code !== 'cancelled') {
      if (!best || s.sortOrder < best.sortOrder) best = s;
    }
  }
  return best;
}

export function levelIndexFor(minutes: number, levels: PhoneLevel[]): number {
  let idx = -1;
  levels.forEach((l, i) => {
    if (minutes >= l.fromMinutes) idx = i;
  });
  return idx;
}

export function where(o: Pick<PhoneOrder, 'tableNumber' | 'orderType'>): string {
  return o.tableNumber ? `Table ${o.tableNumber}` : o.orderType === 'pickup' ? 'Takeaway' : 'Order';
}

/**
 * Compares the snapshot with memory (which it updates) and returns what to
 * send, one notification per phone in the order's route (routeOrders). An
 * order seen for the first time is only remembered, never announced: the phone
 * that placed it already knows, and after a desktop restart old orders must not
 * be announced again. Orders nobody hears about are still remembered, so a
 * waiter who starts serving a table later is not told old changes.
 */
export function diffStates(
  memory: Memory,
  snap: { steps: PhoneStep[]; levels: PhoneLevel[]; orders: WatchOrder[] },
  now: Date,
  routes?: Map<string, OrderRoute>,
): PhoneNotification[] {
  const out: PhoneNotification[] = [];
  const seen = new Set<string>();
  const stepByCode = new Map(snap.steps.map((s) => [s.code, s]));

  for (const o of snap.orders) {
    seen.add(o.orderId);
    const cancelled = o.status === 'cancelled';
    const step = currentStep(o, snap.steps);
    const stepCode = step?.code ?? (cancelled ? 'cancelled' : 'served');
    const minutes = o.since
      ? Math.max(0, Math.floor((now.getTime() - new Date(o.since).getTime()) / 60000))
      : 0;
    const lvl =
      cancelled || !step || step.code === 'served' ? -1 : levelIndexFor(minutes, snap.levels);

    const prev = memory.get(o.orderId);
    if (!prev) {
      memory.set(o.orderId, { step: stepCode, cancelled, levelIndex: lvl });
      continue;
    }

    const route =
      routes?.get(o.orderId) ??
      (o.deviceId ? { deviceIds: [o.deviceId], fromCounter: false } : null);
    const counter = route?.fromCounter === true;
    const label = counter
      ? `order #${o.orderNumber} (added at the counter)`
      : `order #${o.orderNumber}`;
    const emit = (
      n: Omit<PhoneNotification, 'deviceId' | 'orderId' | 'orderNumber' | 'tableNumber'>,
    ) => {
      for (const deviceId of route?.deviceIds ?? []) {
        out.push({
          deviceId,
          orderId: o.orderId,
          orderNumber: o.orderNumber,
          tableNumber: o.tableNumber,
          ...n,
          ...(counter ? { fromCounter: true } : {}),
        });
      }
    };

    if (cancelled && !prev.cancelled) {
      emit({
        type: 'cancelled',
        title: `Order #${o.orderNumber} cancelled`,
        message: `${where(o)}: ${label} was cancelled.`,
      });
      prev.cancelled = true;
      prev.step = stepCode;
      continue;
    }
    if (cancelled) continue;

    if (step && stepCode !== prev.step) {
      const def = stepByCode.get(stepCode);
      if (def?.notifyWaiter) {
        emit({
          type: 'status',
          status: stepCode,
          title: `Order #${o.orderNumber}: ${def.name}`,
          message: `${where(o)}: ${label} is now ${def.name}.`,
        });
      }
      prev.step = stepCode;
    }

    if (lvl > prev.levelIndex) {
      const level = snap.levels[lvl];
      if (level?.notify) {
        emit({
          type: 'delay',
          minutes,
          level: level.name,
          title: `Order #${o.orderNumber} is waiting`,
          message: `${where(o)}: ${label} has waited ${minutes} min (${level.name}).`,
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
