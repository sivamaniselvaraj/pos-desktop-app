import { getAuthedClient } from './sessionClient';
import type { KotRepository } from '../ports';
import type { KotBoard, KotWorkflow } from '../../../shared/types';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Every call is authorized (and scoped to the caller's outlet) in the database. */
export const kots: KotRepository = {
  async getBoard(): Promise<KotBoard> {
    const { data, error } = await getAuthedClient().rpc('get_kot_board');
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as Row;
    const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
    return {
      now: str(d.now),
      statuses: list(d.statuses).map((s) => ({
        id: str(s.id),
        name: str(s.name),
        color: str(s.color),
        actionLabel: strOrNull(s.action_label),
        sortOrder: Number(s.sort_order ?? 0),
        isInitial: Boolean(s.is_initial),
        isFinal: Boolean(s.is_final),
        showOnBoard: Boolean(s.show_on_board),
      })),
      transitions: list(d.transitions).map((t) => ({ from: str(t.from), to: str(t.to) })),
      levels: list(d.levels).map((l) => ({ name: str(l.name), fromMinutes: Number(l.from_minutes ?? 0), color: str(l.color) })),
      kots: list(d.kots).map((k) => ({
        id: `${str(k.order_id)}:${str(k.status_id)}`,
        statusId: str(k.status_id),
        createdAt: str(k.created_at),
        orderId: str(k.order_id),
        orderNumber: Number(k.order_number ?? 0),
        orderType: str(k.order_type),
        tableNumber: strOrNull(k.table_number),
        customerName: strOrNull(k.customer_name),
        notes: strOrNull(k.notes),
        items: list(k.items).map((i) => ({
          id: str(i.id),
          name: str(i.name),
          quantity: Number(i.quantity ?? 1),
          note: strOrNull(i.note),
          isDeleted: Boolean(i.is_deleted),
        })),
      })),
    };
  },

  async move(orderId, toStatusId, fromStatusId) {
    const { error } = await getAuthedClient().rpc('move_kot', {
      p_order_id: orderId,
      p_to_status: toStatusId,
      p_from_status: fromStatusId,
    });
    if (error) throw new Error(error.message);
  },

  async getWorkflow(): Promise<KotWorkflow> {
    const { data, error } = await getAuthedClient().rpc('get_kot_workflow');
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as Row;
    const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
    return {
      steps: list(d.steps).map((s) => ({
        id: str(s.id),
        code: str(s.code),
        name: str(s.name),
        color: str(s.color),
        actionLabel: str(s.action_label),
        showOnBoard: Boolean(s.show_on_board),
        backTo: Array.isArray(s.back_to) ? (s.back_to as unknown[]).map(Number) : [],
        kotCount: Number(s.kot_count ?? 0),
      })),
      levels: list(d.levels).map((l) => ({ name: str(l.name), fromMinutes: Number(l.from_minutes ?? 0), color: str(l.color) })),
    };
  },

  async saveWorkflow(w) {
    const { error } = await getAuthedClient().rpc('save_kot_workflow', {
      p_steps: w.steps.map((s) => ({
        id: s.id || null,
        code: s.code,
        name: s.name,
        color: s.color,
        action_label: s.actionLabel,
        show_on_board: s.showOnBoard,
        back_to: s.backTo,
      })),
      p_levels: w.levels.map((l) => ({ name: l.name, from_minutes: l.fromMinutes, color: l.color })),
    });
    if (error) throw new Error(error.message);
  },
};
