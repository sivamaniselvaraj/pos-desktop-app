import { useEffect, useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import type { ManagedTable, ManagedTableStatus, SaveManagedTablePayload } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/TablesManagement.module.css';
import { TableFormModal } from '../components/TableFormModal';

const STATUSES: ManagedTableStatus[] = ['available', 'occupied', 'reserved', 'cleaning'];

const STATUS_CLASS: Record<ManagedTableStatus, string> = {
  available: styles.statusAvailable,
  occupied: styles.statusOccupied,
  reserved: styles.statusReserved,
  cleaning: styles.statusCleaning,
};

export function TablesManagement() {
  const [tables, setTables] = useState<ManagedTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [query, setQuery] = useState('');
  const [floorFilter, setFloorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ManagedTableStatus>('all');

  // undefined = closed, null = adding, ManagedTable = editing
  const [formTable, setFormTable] = useState<ManagedTable | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);
      setTables(await window.api.listManagedTables());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const floors = useMemo(
    () => Array.from(new Set(tables.map((t) => t.floor).filter(Boolean))).sort(),
    [tables],
  );

  const counts = useMemo(() => {
    const c: Record<ManagedTableStatus, number> = {
      available: 0,
      occupied: 0,
      reserved: 0,
      cleaning: 0,
    };
    for (const t of tables) c[t.effectiveStatus] += 1;
    return c;
  }, [tables]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tables.filter((t) => {
      if (floorFilter !== 'all' && t.floor !== floorFilter) return false;
      if (statusFilter !== 'all' && t.effectiveStatus !== statusFilter) return false;
      if (q && !t.tableNumber.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tables, query, floorFilter, statusFilter]);

  async function handleSave(payload: SaveManagedTablePayload): Promise<void> {
    await window.api.saveManagedTable(payload); // throws -> shown inside the modal
    flash(
      'success',
      payload.tableId ? `Updated table ${payload.tableNumber}` : `Added table ${payload.tableNumber}`,
    );
    setFormTable(undefined);
      await load();
  }

  async function handleDelete(t: ManagedTable) {
    if (t.activeOrderCount > 0) {
      flash('error', `Table ${t.tableNumber} has a live order and can't be deleted`);
      return;
    }
    if (!confirm(`Delete table ${t.tableNumber}? This can't be undone.`)) return;
    try {
      setBusyId(t.tableId);
      await window.api.deleteManagedTable(t.tableId);
      flash('success', `Deleted table ${t.tableNumber}`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={pageStyles.page}>
      <div className={styles.header}>
        <h2>Tables</h2>
        <div className={styles.actions}>
          <button className={styles.clearBtn} onClick={load} disabled={loading} title="Refresh">
            <Icon name="refresh" size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className={styles.addBtn} onClick={() => setFormTable(null)}>
          <Icon name="plus" size={16} />
          Add Table
        </button>
        </div>
      </div>

      <div className={styles.summary}>
        {STATUSES.map((s) => (
          <span key={s} className={`${styles.badge} ${STATUS_CLASS[s]}`}>
            {s}: {counts[s]}
          </span>
        ))}
      </div>

      <div className={styles.filters}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search table number…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className={styles.statusSelect}
          value={floorFilter}
          onChange={(e) => setFloorFilter(e.target.value)}
        >
          <option value="all">All floors</option>
          {floors.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select
          className={styles.statusSelect}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | ManagedTableStatus)}
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <Toast message={message} />
      {error && <p className={styles.error}>{error}</p>}
      {loading && tables.length === 0 && <p className={pageStyles.muted}>Loading tables…</p>}

      {!error && (loading ? tables.length > 0 : true) && (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              <th>Table</th>
              <th>Floor</th>
              <th>Capacity</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className={pageStyles.muted}>
                  {tables.length === 0 ? 'No tables yet — add one.' : 'No tables match these filters.'}
                </td>
              </tr>
            ) : (
              filtered.map((t) => (
                <tr key={t.tableId}>
                  <td>
                    <strong>{t.tableNumber}</strong>
                  </td>
                  <td>{t.floor || '—'}</td>
                  <td>{t.capacity ?? '—'}</td>
                  <td>
                    <span className={`${styles.badge} ${STATUS_CLASS[t.effectiveStatus]}`}>
                      {t.effectiveStatus}
                    </span>
                    {t.activeOrderCount > 0 && (
                      <span className={styles.hintInline}>
                        {t.activeOrderCount} live order{t.activeOrderCount > 1 ? 's' : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        className={styles.iconBtn}
                        title="Edit"
                        onClick={() => setFormTable(t)}
                        disabled={busyId === t.tableId}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button
                        className={styles.iconBtn}
                        title="Delete"
                        onClick={() => handleDelete(t)}
                        disabled={busyId === t.tableId}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {formTable !== undefined && (
        <TableFormModal
          table={formTable ?? undefined}
          floors={floors}
          onSave={handleSave}
          onClose={() => setFormTable(undefined)}
        />
      )}
    </div>
  );
}
