import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import type {
  GroupMembership,
  ManagedUser,
  PermissionInfo,
  SaveGroupPayload,
  UserGroup,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/UserManagement.module.css';

interface Props {
  users: ManagedUser[];
  onChanged: () => void; // tell the parent to refresh memberships
  notify: (type: 'success' | 'error', text: string) => void;
}

/** Display group for a permission code, from its prefix. Unknown prefixes land in Other. */
const PERMISSION_GROUPS: [string, string[]][] = [
  ['Orders', ['orders']],
  ['Tables', ['dashboard', 'tables']],
  ['Menu', ['menu']],
  ['Reports and billing', ['reports', 'history', 'tax', 'invoicing']],
  ['Administration', ['users', 'settings', 'about']],
];

function permissionGroup(code: string): string {
  const prefix = code.split('.')[0];
  return PERMISSION_GROUPS.find(([, prefixes]) => prefixes.includes(prefix))?.[0] ?? 'Other';
}

type MemberFilter = 'all' | 'members' | 'others';

interface GroupForm {
  id?: string;
  name: string;
  description: string;
  permissions: Set<string>;
  members: Set<string>;
}

/** Groups tab: create a group, tick what it grants, choose its members. */
export function GroupsPanel({ users, onChanged, notify }: Props) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [memberships, setMemberships] = useState<GroupMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<GroupForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'access' | 'members'>('access');
  const [permQuery, setPermQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');

  function openForm(next: GroupForm) {
    setTab('access');
    setPermQuery('');
    setMemberQuery('');
    setMemberFilter('all');
    setForm(next);
  }

  // Permissions that match the search, bucketed by display group (in a stable order).
  const permissionSections = useMemo(() => {
    const q = permQuery.trim().toLowerCase();
    const order = [...PERMISSION_GROUPS.map(([name]) => name), 'Other'];
    const all = new Map<string, PermissionInfo[]>(order.map((n) => [n, []]));
    for (const p of permissions) all.get(permissionGroup(p.code))!.push(p);
    return order
      .map((name) => {
        const full = all.get(name)!;
        const shown = q
          ? full.filter(
              (p) =>
                p.code.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q) ||
                name.toLowerCase().includes(q),
            )
          : full;
        return { name, full, shown };
      })
      .filter((g) => g.shown.length > 0);
  }, [permissions, permQuery]);

  const visibleMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (memberFilter === 'members' && !form?.members.has(u.userId)) return false;
      if (memberFilter === 'others' && form?.members.has(u.userId)) return false;
      return !q || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    });
  }, [users, memberQuery, memberFilter, form?.members]);

  async function load() {
    try {
      setLoading(true);
      const [g, p, m] = await Promise.all([
        window.api.listGroups(),
        window.api.listPermissions(),
        window.api.listGroupMemberships(),
      ]);
      setGroups(g);
      setPermissions(p);
      setMemberships(m);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    openForm({ name: '', description: '', permissions: new Set(), members: new Set() });
  }

  function openEdit(g: UserGroup) {
    openForm({
      id: g.id,
      name: g.name,
      description: g.description,
      permissions: new Set(g.permissions),
      members: new Set(memberships.filter((m) => m.groupId === g.id).map((m) => m.userId)),
    });
  }

  function toggle(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  async function handleSave() {
    if (!form) return;
    if (!form.name.trim()) {
      notify('error', 'Group name is required');
      return;
    }
    try {
      setSaving(true);
      const payload: SaveGroupPayload = {
        id: form.id,
        name: form.name.trim(),
        description: form.description.trim(),
        permissions: [...form.permissions],
      };
      const id = await window.api.saveGroup(payload);
      await window.api.setGroupMembers(id, [...form.members]);
      notify('success', `Saved group ${payload.name}`);
      setForm(null);
      await load();
      onChanged();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(g: UserGroup) {
    if (!confirm(`Delete group "${g.name}"? Its ${g.memberCount} member(s) lose the access it granted.`)) return;
    try {
      await window.api.deleteGroup(g.id);
      notify('success', `Deleted group ${g.name}`);
      await load();
      onChanged();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <>
      <div className={styles.header}>
        <h3 style={{ margin: 0 }}>Groups</h3>
        <button className={styles.addBtn} onClick={openCreate}>
          <Icon name="plus" size={16} />
          Add Group
        </button>
      </div>
      <p className={pageStyles.muted}>
        A user added to a group gets everything the group allows, on top of their role. Remove
        them from the group and that access goes away.
      </p>

      {loading && <p className={pageStyles.muted}>Loading groups…</p>}
      {!loading && (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              <th>Group</th>
              <th>Description</th>
              <th>Members</th>
              {/* <th>Access granted</th> */}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={4} className={pageStyles.muted}>
                  No groups yet.
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.description || '-'}</td>
                  <td>{g.memberCount}</td>
                  {/* <td>
                    {g.permissions.length === 0
                      ? '-'
                      : g.permissions.map((p) => (
                          <span key={p} className={styles.chip}>
                            {p}
                          </span>
                        ))}
                  </td> */}
                  <td>
                    <div className={styles.actions}>
                      <button className={styles.iconBtn} title="Edit" onClick={() => openEdit(g)}>
                        <Icon name="edit" size={16} />
                      </button>
                      <button className={styles.iconBtn} title="Delete" onClick={() => handleDelete(g)}>
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

      {form && (
        <div className={styles.modalOverlay} onClick={() => setForm(null)}>
          <div className={`${styles.modal} ${styles.groupModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.gmHead}>
            <h3>{form.id ? 'Edit Group' : 'Add Group'}</h3>
              <div className={styles.gmTop}>
            <label className={styles.formLabel}>
              Name
              <input
                type="text"
                value={form.name}
                maxLength={60}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className={styles.formLabel}>
              Description
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
              </div>
              <div className={styles.gmTabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'access'}
                  className={`${styles.gmTab} ${tab === 'access' ? styles.gmTabOn : ''}`}
                  onClick={() => setTab('access')}
                >
                  Access <small>{form.permissions.size}</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'members'}
                  className={`${styles.gmTab} ${tab === 'members' ? styles.gmTabOn : ''}`}
                  onClick={() => setTab('members')}
                >
                  Members <small>{form.members.size}</small>
                </button>
              </div>
            </div>

            {tab === 'access' && (
              <div className={styles.gmBody}>
                <div className={styles.gmBar}>
                  <input
                    type="search"
                    className={styles.gmSearch}
                    placeholder='Search access, e.g. "orders" or "cancel"'
                    value={permQuery}
                    onChange={(e) => setPermQuery(e.target.value)}
                    aria-label="Search access"
                  />
                  <button
                    type="button"
                    className={styles.gmLink}
                    onClick={() =>
                      setForm({
                        ...form,
                        permissions: new Set([
                          ...form.permissions,
                          ...permissionSections.flatMap((g) => g.shown.map((p) => p.code)),
                        ]),
                      })
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className={`${styles.gmLink} ${styles.gmLinkMuted}`}
                    onClick={() => {
                      const hide = new Set(permissionSections.flatMap((g) => g.shown.map((p) => p.code)));
                      setForm({
                        ...form,
                        permissions: new Set([...form.permissions].filter((c) => !hide.has(c))),
                      });
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div className={styles.gmCount}>
                  {form.permissions.size} of {permissions.length} granted
                  {permQuery.trim() &&
                    ` · ${permissionSections.reduce((n, g) => n + g.shown.length, 0)} shown`}
                </div>
                <div className={styles.gmList}>
                  {permissionSections.length === 0 && (
                    <div className={styles.gmEmpty}>Nothing matches &ldquo;{permQuery}&rdquo;.</div>
                  )}
                  {permissionSections.map((g) => (
                    <div key={g.name}>
                      <div className={styles.gmGroup}>
                        {g.name}
                        <span>
                          {g.full.filter((p) => form.permissions.has(p.code)).length} of {g.full.length}
                        </span>
                      </div>
                      {g.shown.map((p) => (
                        <label key={p.code} className={styles.gmRow}>
                          <span className={styles.gmText}>
                            <b>{p.code}</b>
                            <i>{p.description}</i>
                          </span>
                    <input
                      type="checkbox"
                            className={styles.gmSwitch}
                      checked={form.permissions.has(p.code)}
                      onChange={() => setForm({ ...form, permissions: toggle(form.permissions, p.code) })}
                    />
                  </label>
                ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'members' && (
              <div className={styles.gmBody}>
                <div className={styles.gmBar}>
                  <input
                    type="search"
                    className={styles.gmSearch}
                    placeholder="Search by name or email"
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    aria-label="Search members"
                  />
                  <div className={styles.gmSeg}>
                    {(
                      [
                        ['all', `All ${users.length}`],
                        ['members', `Members ${form.members.size}`],
                        ['others', `Not members ${users.length - form.members.size}`],
                      ] as [MemberFilter, string][]
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={memberFilter === key ? styles.gmSegOn : ''}
                        onClick={() => setMemberFilter(key)}
                      >
                        {label}
                      </button>
                    ))}
            </div>
                </div>
                <div className={styles.gmCount}>
                  {form.members.size} member{form.members.size === 1 ? '' : 's'} selected
                </div>
                <div className={styles.gmList}>
                  {visibleMembers.length === 0 && <div className={styles.gmEmpty}>No users match.</div>}
                  {visibleMembers.map((u) => (
                    <label key={u.userId} className={styles.gmRow}>
                      <span className={styles.gmAvatar}>{(u.fullName || u.email).charAt(0).toUpperCase()}</span>
                      <span className={styles.gmText}>
                        <b>{u.fullName || u.email}</b>
                        <i>{u.email}</i>
                      </span>
                      <span className={`${styles.badge} ${styles['role_' + u.role]}`}>{u.role}</span>
                    <input
                      type="checkbox"
                      checked={form.members.has(u.userId)}
                      onChange={() => setForm({ ...form, members: toggle(form.members, u.userId) })}
                    />
                  </label>
                ))}
              </div>
            </div>
            )}

            <div className={styles.gmFoot}>
              <span>Changes apply when you save</span>
              <div className={styles.modalActions} style={{ margin: 0 }}>
              <button className={styles.cancelBtn} onClick={() => setForm(null)} disabled={saving}>
                Cancel
              </button>
              <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Group'}
              </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
