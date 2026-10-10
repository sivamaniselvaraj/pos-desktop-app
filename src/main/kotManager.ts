import { db } from './data';
import type { KotBoard, KotWorkflow } from '../shared/types';

/**
 * kotManager.ts: the KOT board and its workflow settings. Who may view / move /
 * configure is enforced in the database (kot.view, kot.move, kot.manage);
 * checks here only give friendlier messages.
 */

export function getKotBoard(): Promise<KotBoard> {
  return db.kots.getBoard();
}

export function moveKot(orderId: string, toStatusId: string, fromStatusId: string): Promise<void> {
  if (!orderId || !toStatusId || !fromStatusId) throw new Error('Choose the order and the step to move it to.');
  return db.kots.move(orderId, toStatusId, fromStatusId);
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
