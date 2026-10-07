import { useEffect, useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { GroupsPanel } from '../components/GroupsPanel';
import type {
  ManagedUser,
  OutletOption,
  UserRole,
  CreateUserPayload,
  UpdateUserPayload,
  UserGroup,
  GroupMembership,
  UserAccessEntry,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/UserManagement.module.css';


const ROLES: UserRole[] = ['staff', 'manager', 'owner', 'admin', 'editor'];

type StatusFilter = 'all' | 'active' | 'inactive';

interface FormState {
  userId?: string; // present when editing, absent when creating
  email: string;
  password: string; // create only
  firstName: string;
  phone: string;
  role: UserRole;
  outletId: string; // '' = none
  groupIds: string[]; // edit only
}

const EMPTY_FORM: FormState = {
  email: '',
  password: '',
  firstName: '',
  phone: '',
  role: 'staff',
  outletId: '',
  groupIds: [],
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

  const [tab, setTab] = useState<'users' | 'groups'>('users');
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [accessFor, setAccessFor] = useState<{ user: ManagedUser; entries: UserAccessEntry[] } | null>(null);

  const [form, setForm] = useState<FormState | null>(null); // null = modal closed
  const [saving, setSaving] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  async function loadAll() {
    try {
      setLoading(true);
      setError(null);
      const [userList, outletList, groupList, memberList] = await Promise.all([
        window.api.listUsers(),
        window.api.listOutlets(),
        window.api.listGroups(),
        window.api.listGroupMemberships(),
      ]);
      setUsers(userList);
      setOutlets(outletList);
      setGroups(groupList);
      setMemberships(memberList);
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
      if (q && !u.fullName.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) {
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
      firstName: u.fullName,
      phone: u.phone ?? '',
      role: u.role,
      outletId: u.outletId ?? '',
      groupIds: memberships.filter((m) => m.userId === u.userId).map((m) => m.groupId),
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
          fullName: form.firstName.trim(),
          phone: form.phone.trim() || undefined,
          role: form.role,
          outletId: form.outletId || undefined,
        };
        await window.api.updateUser(payload);
        await window.api.setUserGroups(form.userId, form.groupIds);
        setMessage({ type: 'success', text: `Updated ${form.firstName}` });
      } else {
        const payload: CreateUserPayload = {
          email: form.email.trim(),
          password: form.password,
          fullName: form.firstName.trim(),
          phone: form.phone.trim() || undefined,
          role: form.role,
          outletId: form.outletId || undefined,
          groupIds: form.groupIds,
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

  function groupNames(userId: string): string[] {
    const ids = new Set(memberships.filter((m) => m.userId === userId).map((m) => m.groupId));
    return groups.filter((g) => ids.has(g.id)).map((g) => g.name);
  }

  async function openAccess(u: ManagedUser) {
    try {
      const entries = await window.api.getUserAccess(u.userId);
      setAccessFor({ user: u, entries: entries.filter((e) => e.via.length > 0) });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load access' });
      setTimeout(() => setMessage(null), 4000);
    }
  }

  async function handleToggleActive(u: ManagedUser) {
    const nextActive = !u.isActive;
    const verb = nextActive ? 'reactivate' : 'deactivate';
    if (!confirm(`Are you sure you want to ${verb} ${u.fullName || u.email}?`)) return;

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
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'users' ? styles.tabActive : ''}`}
          onClick={() => setTab('users')}
        >
          Users
        </button>
        <button
          className={`${styles.tab} ${tab === 'groups' ? styles.tabActive : ''}`}
          onClick={() => setTab('groups')}
        >
          Groups
        </button>
      </div>

      <Toast message={message} />

      {tab === 'groups' && (
        <GroupsPanel
          users={users}
          onChanged={loadAll}
          notify={(type, text) => {
            setMessage({ type, text });
            setTimeout(() => setMessage(null), 4000);
          }}
        />
      )}

      {tab === 'users' && (<>
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
        <div className={styles.actionButtons}>
          <button className={styles.addBtn} onClick={openCreate}>
            <Icon name="plus" size={16} />
            Add User
          </button>
        </div>
      </div>

      <Toast message={message} />
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
              <th>Groups</th>
              <th>Outlet</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className={pageStyles.muted}>
                  No users match this search.
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.userId}>
                  <td>{u.fullName || '—'}</td>
                  <td>{u.email}</td>
                  <td>{u.phone || '-'}</td>
                  <td>
                    <span className={`${styles.badge} ${styles['role_' + u.role]}`}>
                      {u.role}
                    </span>
                  </td>
                  <td>{groupNames(u.userId).join(', ') || '-'}</td>
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
                        title="View access"
                        onClick={() => openAccess(u)}
                      >
                        <Icon name="view" size={16} />
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

            {form.userId && (
              <div className={styles.formLabel}>
                Groups
                <div className={styles.checkList}>
                  {groups.length === 0 && <small className={styles.hint}>No groups yet. Create one in the Groups tab.</small>}
                  {groups.map((g) => (
                    <label key={g.id} className={styles.checkItem}>
                      <input
                        type="checkbox"
                        checked={form.groupIds.includes(g.id)}
                        onChange={() =>
                          setForm({
                            ...form,
                            groupIds: form.groupIds.includes(g.id)
                              ? form.groupIds.filter((x) => x !== g.id)
                              : [...form.groupIds, g.id],
                          })
                        }
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
                <small className={styles.hint}>
                  Access comes only from groups. A user in no group can sign in but sees nothing.
                </small>
              </div>
            )}

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
      </>)}

      {accessFor && (
        <div className={styles.modalOverlay} onClick={() => setAccessFor(null)}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
            <h3>Access for {accessFor.user.fullName || accessFor.user.email}</h3>
            <table className={pageStyles.table}>
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>Granted by</th>
                </tr>
              </thead>
              <tbody>
                {accessFor.entries.length === 0 ? (
                  <tr>
                    <td colSpan={2} className={pageStyles.muted}>
                      No access.
                    </td>
                  </tr>
                ) : (
                  accessFor.entries.map((e) => (
                    <tr key={e.permission}>
                      <td title={e.description}>{e.permission}</td>
                      <td className={styles.sourceCell}>{e.via.join(', ')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setAccessFor(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
