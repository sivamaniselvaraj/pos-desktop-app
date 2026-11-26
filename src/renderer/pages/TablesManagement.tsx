import { useEffect, useMemo, useState } from 'react';
import { useScreenTiming } from '../lib/timing';
import { useConfirm } from '../context/ConfirmContext';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { useAuth } from '../context/AuthContext';
import { TableFormModal, TABLE_STATUSES } from '../components/TableFormModal';
import type { ManagedTable, ManagedTableStatus, SaveManagedTablePayload } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/TablesManagement.module.css';

const STATUSES = TABLE_STATUSES;

const STATUS_CLASS: Record<ManagedTableStatus, string> = {
  available: styles.statusAvailable,
  occupied: styles.statusOccupied,
  reserved: styles.statusReserved,
  cleaning: styles.statusCleaning,
};

export function TablesManagement() {
  const { can } = useAuth();
  const confirm = useConfirm();
  // Managers add/edit and mark tables active or inactive (tables are never deleted,
  // docs/TABLE_ACTIVE.md); staff/waiters only see the list and use the
  // available <-> occupied toggle. The database enforces this too.
  const canManage = can('tables.manage');
  const canToggle = can('tables.toggle');
  const [tables, setTables] = useState<ManagedTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useScreenTiming('Tables', !loading, error !== null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [query, setQuery] = useState('');
  const [floorFilter, setFloorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ManagedTableStatus>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');

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
    for (const t of tables) if (t.isActive) c[t.effectiveStatus] += 1;
    return c;
  }, [tables]);
  const inactiveCount = useMemo(() => tables.filter((t) => !t.isActive).length, [tables]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tables.filter((t) => {
      if (floorFilter !== 'all' && t.floor !== floorFilter) return false;
      if (statusFilter !== 'all' && t.effectiveStatus !== statusFilter) return false;
      if (activeFilter === 'active' && !t.isActive) return false;
      if (activeFilter === 'inactive' && t.isActive) return false;
      if (q && !t.tableNumber.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tables, query, floorFilter, statusFilter, activeFilter]);

  async function handleSave(payload: SaveManagedTablePayload): Promise<void> {
    await window.api.saveManagedTable(payload); // throws -> shown inside the modal
    flash(
      'success',
      payload.tableId ? `Updated table ${payload.tableNumber}` : `Added table ${payload.tableNumber}`,
    );
    setFormTable(undefined);
    await load();
  }

  // Quick toggle: on = available, off = occupied. Only these two states —
  // reserved/cleaning are set by a manager via Edit. Disabled while the table
  // has a live order (cancelled orders don't count).
  async function handleToggle(t: ManagedTable) {
    const next: ManagedTableStatus = t.status === 'available' ? 'occupied' : 'available';
    try {
      setBusyId(t.tableId);
      await window.api.setManagedTableStatus(t.tableId, next);
      flash('success', `Table ${t.tableNumber} is now ${next}`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to change status');
    } finally {
      setBusyId(null);
    }
  }

  // Tables are never deleted: a table not used any more is made inactive. It stays here
  // with its past orders, but is not offered on the Dashboard, New order or phones.
  async function handleSetActive(t: ManagedTable, active: boolean) {
    if (!active && t.activeOrderCount > 0) {
      flash('error', `Table ${t.tableNumber} has an open order or a bill waiting for payment, so it can't be made inactive`);
      return;
    }
    if (
      !active &&
      !(await confirm({
        title: 'Make table inactive',
        message: `Make table ${t.tableNumber} inactive? It will no longer show on the Dashboard, New order or phones, and no orders can be placed on it. Its past orders and reports stay. You can make it active again here.`,
        confirmLabel: 'Make inactive',
        tone: 'danger',
      }))
    )
      return;
    try {
      setBusyId(t.tableId);
      await window.api.setManagedTableActive(t.tableId, active);
      flash('success', active ? `Table ${t.tableNumber} is active again` : `Table ${t.tableNumber} is now inactive`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to change the table');
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
          {canManage && (
            <button className={styles.addBtn} onClick={() => setFormTable(null)}>
              <Icon name="plus" size={16} />
              Add Table
            </button>
          )}
        </div>
      </div>

      <div className={styles.summary}>
        {STATUSES.map((s) => (
          <span key={s} className={`${styles.badge} ${STATUS_CLASS[s]}`}>
            {s}: {counts[s]}
          </span>
        ))}
        {inactiveCount > 0 && <span className={`${styles.badge} ${styles.statusInactive}`}>inactive: {inactiveCount}</span>}
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
        <select
          className={styles.statusSelect}
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')}
        >
          <option value="all">Active and inactive</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
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
              <th>Available</th>
              <th>Active</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className={pageStyles.muted}>
                  {tables.length === 0 ? 'No tables yet — add one.' : 'No tables match these filters.'}
                </td>
              </tr>
            ) : (
              filtered.map((t) => (
                <tr key={t.tableId} className={t.isActive ? undefined : styles.inactiveRow}>
                  <td>
                    <strong>{t.tableNumber}</strong>
                  </td>
                  <td>{t.floor || '—'}</td>
                  <td>{t.capacity ?? '—'}</td>
                  <td>
                    {t.isActive ? (
                      <span className={`${styles.badge} ${STATUS_CLASS[t.effectiveStatus]}`}>
                        {t.effectiveStatus}
                      </span>
                    ) : (
                      <span className={`${styles.badge} ${styles.statusInactive}`}>inactive</span>
                    )}
                    {t.activeOrderCount > 0 && (
                      <span className={styles.hintInline}>
                        {t.activeOrderCount} live order{t.activeOrderCount > 1 ? 's' : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    {!t.isActive ? (
                      <span className={styles.hintInline}>Inactive</span>
                    ) : !canToggle ? (
                      <span className={styles.hintInline}>
                        {t.effectiveStatus === 'available' ? 'Available' : t.effectiveStatus}
                      </span>
                    ) : (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={t.effectiveStatus === 'available'}
                      aria-label={`Table ${t.tableNumber} available`}
                      className={`${styles.switch} ${
                        t.effectiveStatus === 'available' ? styles.switchOn : ''
                      }`}
                      onClick={() => handleToggle(t)}
                      disabled={
                        busyId === t.tableId ||
                        t.activeOrderCount > 0 ||
                        (t.status !== 'available' && t.status !== 'occupied')
                      }
                      title={
                        t.activeOrderCount > 0
                          ? 'Has a live order — status follows the order'
                          : t.status !== 'available' && t.status !== 'occupied'
                            ? `This table is ${t.status}; a manager can change it from Edit`
                            : t.status === 'available'
                              ? 'Mark occupied'
                              : 'Mark available'
                      }
                    >
                      <span className={styles.knob} />
                    </button>
                    )}
                  </td>
                  <td>
                    {/* Active switch (tables are never deleted, docs/TABLE_ACTIVE.md): on = active. */}
                    {!canManage ? (
                      <span className={styles.hintInline}>{t.isActive ? 'Active' : 'Inactive'}</span>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={t.isActive}
                        aria-label={`Table ${t.tableNumber} active`}
                        className={`${styles.switch} ${t.isActive ? styles.switchOn : ''}`}
                        onClick={() => void handleSetActive(t, !t.isActive)}
                        disabled={busyId === t.tableId || (t.isActive && t.activeOrderCount > 0)}
                        title={
                          t.isActive && t.activeOrderCount > 0
                            ? 'Has an open order or unpaid bill, so it cannot be made inactive'
                            : t.isActive
                              ? 'Make inactive: no new orders; it stays here with its past orders'
                              : 'Make active: offer this table for orders again'
                        }
                      >
                        <span className={styles.knob} />
                      </button>
                    )}
                  </td>
                  {canManage && (
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
                    </div>
                  </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {canManage && formTable !== undefined && (
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
