import { useState } from 'react';
import type { ManagedTable, ManagedTableStatus, SaveManagedTablePayload } from '@shared/types';
import styles from '../styles/TableFormModal.module.css';

export const TABLE_STATUSES: ManagedTableStatus[] = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
];

export interface TableFormModalProps {
  /** Table being edited; omit to add a new one. */
  table?: ManagedTable;
  /** Existing floor names, offered as suggestions. */
  floors?: string[];
  /** Persist the table. Throw to show the message in the modal and keep it open; resolve to close it. */
  onSave: (payload: SaveManagedTablePayload) => Promise<void>;
  onClose: () => void;
}

/**
 * Add / edit table dialog, shared by the Dashboard ("Add Table") and the
 * Tables page (add + edit). Validates locally, then hands the payload to
 * onSave; the caller owns the actual write and any list refresh.
 */
export function TableFormModal({ table, floors = [], onSave, onClose }: TableFormModalProps) {
  const [tableNumber, setTableNumber] = useState(table?.tableNumber ?? '');
  const [floor, setFloor] = useState(table?.floor ?? '');
  const [capacity, setCapacity] = useState(table?.capacity != null ? String(table.capacity) : '');
  const [status, setStatus] = useState<ManagedTableStatus>(table?.status ?? 'available');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    const number = tableNumber.trim();
    if (!number) {
      setError('Table number is required');
      return;
    }
    let cap: number | null = null;
    if (capacity.trim() !== '') {
      cap = Number(capacity);
      if (!Number.isInteger(cap) || cap <= 0) {
        setError('Capacity must be a whole number greater than 0');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ tableId: table?.tableId, tableNumber: number, floor: floor.trim(), capacity: cap, status });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
    // On success the parent unmounts this modal.
  }

  return (
    <div className={styles.overlay} onClick={() => !saving && onClose()}>
      <form
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{table ? 'Edit Table' : 'Add Table'}</h3>

        <label className={styles.formLabel}>
          Table number
          <input
            type="text"
            value={tableNumber}
            onChange={(e) => setTableNumber(e.target.value)}
            placeholder="e.g. 1, 1A, 2a"
            autoFocus
          />
        </label>

        <div className={styles.row2}>
          <label className={styles.formLabel}>
            Floor
            <input
              type="text"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              placeholder="e.g. Ground, First"
              list="table-form-floors"
            />
            <datalist id="table-form-floors">
              {floors.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
          <label className={styles.formLabel}>
            Capacity
            <input
              type="number"
              min={1}
              step={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="Seats"
            />
          </label>
        </div>

        <label className={styles.formLabel}>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ManagedTableStatus)}>
            {TABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <small className={styles.hint}>
            A table with a live order always shows as occupied, whatever is set here.
          </small>
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.modalActions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving…' : table ? 'Save Changes' : 'Add Table'}
          </button>
        </div>
      </form>
    </div>
  );
}
