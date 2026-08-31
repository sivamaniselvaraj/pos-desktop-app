import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import type {
  ManagedUser,
  OutletOption,
  UserRole,
  CreateUserPayload,
  UpdateUserPayload,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/UserManagement.module.css';

const ROLES: UserRole[] = ['staff', 'manager', 'owner', 'admin'];

type StatusFilter = 'all' | 'active' | 'inactive';

interface FormState {
  userId?: string; // present when editing, absent when creating
  email: string;
  password: string; // create only
  firstName: string;
  phone: string;
  role: UserRole;
  outletId: string; // '' = none
}

const EMPTY_FORM: FormState = {
  email: '',
  password: '',
  firstName: '',
  phone: '',
  role: 'staff',
  outletId: '',
};

export function UserManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [outlets, setOutlets] = useState<OutletOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  const [nameQuery, setNameQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [form, setForm] = useState<FormState | null>(null); // null = modal closed
  const [saving, setSaving] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  async function loadAll() {
    try {
      setLoading(true);
      setError(null);
      const [userList, outletList] = await Promise.all([
        window.api.listUsers(),
        window.api.listOutlets(),
      ]);
      setUsers(userList);
      setOutlets(outletList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === 'active' && !u.isActive) return false;
      if (statusFilter === 'inactive' && u.isActive) return false;
      if (q && !u.firstName.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [users, nameQuery, statusFilter]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(u: ManagedUser) {
    setForm({
      userId: u.userId,
      email: u.email,
      password: '',
      firstName: u.firstName,
      phone: u.phone ?? '',
      role: u.role,
      outletId: u.outletId ?? '',
    });
  }

  function closeForm() {
    setForm(null);
  }

  async function handleSave() {
    if (!form) return;
    if (!form.firstName.trim()) {
      setMessage({ type: 'error', text: 'Name is required' });
      return;
    }
    if (!form.userId && (!form.email.trim() || !form.password.trim())) {
      setMessage({ type: 'error', text: 'Email and password are required for a new user' });
      return;
    }

    try {
      setSaving(true);
      setMessage(null);
      if (form.userId) {
        const payload: UpdateUserPayload = {
          userId: form.userId,
          firstName: form.firstName.trim(),
          phone: form.phone.trim() || undefined,
          role: form.role,
          outletId: form.outletId || undefined,
        };
        await window.api.updateUser(payload);
        setMessage({ type: 'success', text: `Updated ${form.firstName}` });
      } else {
        const payload: CreateUserPayload = {
          email: form.email.trim(),
          password: form.password,
          firstName: form.firstName.trim(),
          phone: form.phone.trim() || undefined,
          role: form.role,
          outletId: form.outletId || undefined,
        };
        await window.api.createUser(payload);
        setMessage({ type: 'success', text: `Created ${form.firstName}` });
      }
      closeForm();
      await loadAll();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 4000);
    }
  }

  async function handleToggleActive(u: ManagedUser) {
    const nextActive = !u.isActive;
    const verb = nextActive ? 'reactivate' : 'deactivate';
    if (!confirm(`Are you sure you want to ${verb} ${u.firstName || u.email}?`)) return;

    try {
      setBusyUserId(u.userId);
      await window.api.setUserActive(u.userId, nextActive);
      setUsers((prev) =>
        prev.map((x) => (x.userId === u.userId ? { ...x, isActive: nextActive } : x)),
      );
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Action failed' });
      setTimeout(() => setMessage(null), 4000);
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className={pageStyles.page}>
      <div className={styles.header}>
        <h2>User Management</h2>
        <button className={styles.addBtn} onClick={openCreate}>
          <Icon name="plus" size={16} />
          Add User
        </button>
      </div>

      <div className={styles.filters}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search by name or email…"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
        />
        <select
          className={styles.statusSelect}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {message && (
        <p className={message.type === 'error' ? styles.error : styles.success}>{message.text}</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={pageStyles.muted}>Loading users…</p>}

      {!loading && !error && (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Role</th>
              <th>Outlet</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className={pageStyles.muted}>
                  No users match this search.
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.userId}>
                  <td>{u.firstName || '—'}</td>
                  <td>{u.email}</td>
                  <td>{u.phone || '-'}</td>
                  <td>
                    <span className={`${styles.badge} ${styles['role_' + u.role]}`}>
                      {u.role}
                    </span>
                  </td>
                  <td>{u.outletName || '-'}</td>
                  <td>
                    <span className={`${styles.badge} ${u.isActive ? styles.active : styles.inactive}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        className={styles.iconBtn}
                        title="Edit"
                        onClick={() => openEdit(u)}
                        disabled={busyUserId === u.userId}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button
                        className={styles.iconBtn}
                        title={u.isActive ? 'Deactivate' : 'Reactivate'}
                        onClick={() => handleToggleActive(u)}
                        disabled={busyUserId === u.userId}
                      >
                        <Icon name={u.isActive ? 'trash' : 'refresh'} size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {form && (
        <div className={styles.modalOverlay} onClick={closeForm}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>{form.userId ? 'Edit User' : 'Add User'}</h3>

            <label className={styles.formLabel}>
              Full Name
              <input
                type="text"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </label>

            <label className={styles.formLabel}>
              Email
              <input
                type="email"
                value={form.email}
                disabled={!!form.userId}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {form.userId && (
                <small className={styles.hint}>Email can&apos;t be changed here.</small>
              )}
            </label>

            {!form.userId && (
              <label className={styles.formLabel}>
                Password
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
            )}

            <label className={styles.formLabel}>
              Phone
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </label>

            <label className={styles.formLabel}>
              Role
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.formLabel}>
              Outlet
              <select
                value={form.outletId}
                onChange={(e) => setForm({ ...form, outletId: e.target.value })}
              >
                <option value="">— None —</option>
                {outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={closeForm} disabled={saving}>
                Cancel
              </button>
              <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : form.userId ? 'Save Changes' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
