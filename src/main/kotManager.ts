import { db } from './data';
import { orderManager } from './orderManager';
import { printQueue } from './printQueue';
import type { KotBoard, KotWorkflow, UnprintedKot } from '../shared/types';

/**
 * kotManager.ts: the KOT board and its workflow settings. Who may view / move /
 * configure is enforced in the database (kot.view, kot.move, kot.manage);
 * checks here only give friendlier messages.
 */

export function getKotBoard(userId:string): Promise<KotBoard> {
  return db.kots.getBoard(userId);
}

export function moveKot(orderId: string, toStatusId: string, fromStatusId: string, userId:string): Promise<void> {
  if (!orderId || !toStatusId || !fromStatusId) throw new Error('Choose the order and the step to move it to.');
  return db.kots.move(orderId, toStatusId, fromStatusId, userId);
}

export function getKotWorkflow(): Promise<KotWorkflow> {
  return db.kots.getWorkflow();
}

export function saveKotWorkflow(w: KotWorkflow): Promise<void> {
  if (!w || !Array.isArray(w.steps) || !Array.isArray(w.levels)) throw new Error('Nothing to save.');
  if (w.steps.length < 2) throw new Error('A workflow needs at least 2 steps.');
  for (const s of w.steps) {
    if (!s.name?.trim()) throw new Error('Every step needs a name.');
  }
  return db.kots.saveWorkflow(w);
}

export function getUnprintedKots(): Promise<UnprintedKot[]> {
  return db.orders.listUnprintedKots();
}

/**
 * Manual print from the Unprinted KOTs page. Same path as an Android confirm
 * and the 30-second sweep: shared print queue, then orderManager 'kot', which
 * claims the unprinted items in the database first, so a click can never print
 * the same items twice even if the sweep prints them at the same moment.
 */
export async function printKotNow(orderId: string): Promise<string> {
  if (!orderId) throw new Error('Choose an order to print.');
  const result = await printQueue.enqueue(() => orderManager.handleIncoming(orderId, 'kot'));
  if (!result.success) throw new Error(result.message || 'Print failed');
  return result.message;
}
