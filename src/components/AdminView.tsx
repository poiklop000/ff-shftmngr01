import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Trash2, Ban, Check, UserPlus, RefreshCw, Shield, Search, Users, BellRing, Database, History, Loader2 } from 'lucide-react';
import { AlertHistory } from '@/components/AlertHistory';
import { AlertsConfig } from '@/components/AlertsConfig';
import { ACCESSIBLE_PAGE_OPTIONS, roleDefaultPages, userAllowedViews, type View } from '@/lib/access';
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminResetPassword,
  adminSetActive,
  adminUpdateUser,
  type AppProfile,
  type Role,
} from '@/lib/auth';

interface AdminViewProps {
  currentUserId: string;
  syncing?: boolean;
  syncMessage?: string | null;
  syncError?: string | null;
  onSync?: () => void;
}

type AdminTab = 'users' | 'alerts' | 'sync' | 'history';

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'operator', label: 'Operator' },
  { value: 'team_lead', label: 'Team Lead' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
];

const ROLE_COLORS: Record<Role, { bg: string; color: string }> = {
  admin: { bg: 'var(--blue-tag-bg)', color: 'var(--blue-tag-text)' },
  manager: { bg: '#fdf4ff', color: '#86198f' },
  team_lead: { bg: 'var(--amber-tag-bg)', color: 'var(--amber-tag-text)' },
  operator: { bg: 'var(--green-tag-bg)', color: 'var(--green-tag-text)' },
};

const PAGE_LABELS: Record<string, string> = Object.fromEntries(
  [...ACCESSIBLE_PAGE_OPTIONS, { id: 'admin' as View, label: 'Admin' }].map((p) => [p.id, p.label]),
);

const TABS: { id: AdminTab; label: string; Icon: typeof Users }[] = [
  { id: 'users', label: 'Users & Access', Icon: Users },
  { id: 'alerts', label: 'Alerts & Refresh', Icon: BellRing },
  { id: 'sync', label: 'Sync Data', Icon: Database },
  { id: 'history', label: 'Alert History', Icon: History },
];

export function AdminView({ currentUserId, syncing = false, syncMessage, syncError, onSync }: AdminViewProps) {
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<AppProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [showAdd, setShowAdd] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<Role>('operator');
  const [editUseDefault, setEditUseDefault] = useState(true);
  const [editPages, setEditPages] = useState<View[]>([]);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await adminListUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 4000);
  };

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.display_name.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q),
    );
  }, [users, search]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !displayName.trim() || password.length < 6) {
      setError('Name, display name, and a password of at least 6 characters are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminCreateUser({ username: name.trim(), displayName: displayName.trim(), password, role });
      setName('');
      setDisplayName('');
      setPassword('');
      setRole('operator');
      setShowAdd(false);
      flash('User created.');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async (u: AppProfile) => {
    setBusy(true);
    setError(null);
    try {
      await adminSetActive(u.user_id, !u.is_active);
      flash(u.is_active ? 'User disabled.' : 'User enabled.');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user.');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (userId: string) => {
    if (resetPassword.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminResetPassword(userId, resetPassword);
      setResetId(null);
      setResetPassword('');
      flash('Password reset.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (userId: string) => {
    if (!editDisplayName.trim()) {
      setError('Display name is required.');
      return;
    }
    if (!editUseDefault && editPages.length === 0) {
      setError('Select at least one page, or use the role default.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminUpdateUser(userId, {
        displayName: editDisplayName.trim(),
        role: editRole,
        pageAccess: editUseDefault ? null : editPages,
      });
      setEditingId(null);
      flash('User updated.');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (u: AppProfile) => {
    if (!window.confirm(`Delete user "${u.display_name}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await adminDeleteUser(u.user_id);
      flash('User deleted.');
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user.');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (u: AppProfile) => {
    setEditingId(u.user_id);
    setEditDisplayName(u.display_name);
    setEditRole(u.role);
    const hasOverride = !!u.page_access && u.page_access.length > 0;
    setEditUseDefault(!hasOverride);
    setEditPages(hasOverride ? (u.page_access as View[]) : roleDefaultPages(u.role));
  };

  const badge = (u: AppProfile) => {
    const c = ROLE_COLORS[u.role];
    return (
      <span
        style={{
          background: c.bg,
          color: c.color,
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.3px',
          borderRadius: 999,
          padding: '2px 10px',
        }}
      >
        {u.role}
      </span>
    );
  };

  const pageTags = (u: AppProfile) => {
    const pages = userAllowedViews(u);
    const hasOverride = !!u.page_access && u.page_access.length > 0;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
        {pages.map((v) => (
          <span
            key={v}
            style={{ fontSize: 10, fontWeight: 700, background: 'var(--slate-tag-bg)', color: 'var(--slate-tag-text)', borderRadius: 999, padding: '2px 8px', letterSpacing: '0.2px' }}
          >
            {PAGE_LABELS[v] ?? v}
          </span>
        ))}
        {hasOverride && (
          <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--amber-tag-bg)', color: 'var(--amber-tag-text)', borderRadius: 999, padding: '2px 8px', letterSpacing: '0.2px' }}>
            CUSTOM
          </span>
        )}
      </div>
    );
  };

  const renderTab = (t: { id: AdminTab; label: string; Icon: typeof Users }) => {
    const active = tab === t.id;
    const Icon = t.Icon;
    return (
      <button
        key={t.id}
        type="button"
        className="tab-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: active ? 'var(--tab-active-bg, #1e40af)' : 'var(--btn-sec-bg)',
          color: active ? '#ffffff' : 'var(--btn-sec-text)',
        }}
        onClick={() => setTab(t.id)}
      >
        <Icon size={15} />
        {t.label}
      </button>
    );
  };

  return (
    <div>
      <div className="card" style={{ background: 'var(--blue-tag-bg)', borderColor: 'var(--blue-tag-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 15, color: 'var(--blue-tag-text)' }}>
          <Shield size={18} />
          Admin — Access & Configuration
        </div>
        <div style={{ fontSize: 12, color: 'var(--blue-tag-text)', marginTop: 6, lineHeight: 1.5 }}>
          Manage accounts and which pages each user can open, configure Microsoft Teams alerts and
          refresh intervals, pull the latest data from OFS, and review alert history. Only admins can see this page.
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 13, color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 13, color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600, marginBottom: 12 }}>
          {msg}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {TABS.map((t) => renderTab(t))}
      </div>

      {tab === 'users' && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
            <button type="button" className="tab-btn tab-btn-blue" onClick={() => setShowAdd((v) => !v)} disabled={busy}>
              <UserPlus size={16} />
              {showAdd ? 'Cancel' : 'Add User'}
            </button>
            <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)' }} onClick={loadUsers} disabled={busy || loading}>
              <RefreshCw size={16} />
              Refresh
            </button>
            <div className="input-group" style={{ maxWidth: 240, marginLeft: 'auto' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input
                  className="form-control"
                  style={{ paddingLeft: 30 }}
                  placeholder="Search users…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>

          {showAdd && (
            <div className="card" style={{ background: 'var(--card-bg)' }}>
              <h3 style={{ color: 'var(--app-fg)' }}>Add User</h3>
              <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  <div className="input-group" style={{ maxWidth: 'none' }}>
                    <label>Login name</label>
                    <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. kgman" disabled={busy} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 'none' }}>
                    <label>Display name</label>
                    <input className="form-control" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Kevin G" disabled={busy} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 'none' }}>
                    <label>Password</label>
                    <input type="text" className="form-control" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 6 characters" disabled={busy} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 'none' }}>
                    <label>Role</label>
                    <select className="form-control" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={busy}>
                      {ROLE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  New users open the pages their role allows by default. You can customise page access after creating the account.
                </div>
                <div className="sm-btn-row" style={{ justifyContent: 'flex-start' }}>
                  <button type="submit" className="tab-btn tab-btn-green" disabled={busy}>
                    {busy ? 'Creating...' : 'Create User'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {loading ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading users...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {search ? 'No users match your search.' : 'No users yet. Add the first user above.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredUsers.map((u) => (
                <div
                  key={u.user_id}
                  className="card"
                  style={{
                    background: 'var(--card-bg)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    padding: '14px 16px',
                    opacity: u.is_active ? 1 : 0.55,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--app-fg)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {u.display_name}
                        {u.user_id === currentUserId && (
                          <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--amber-tag-bg)', color: 'var(--amber-tag-text)', borderRadius: 999, padding: '2px 8px', letterSpacing: '0.3px' }}>
                            YOU
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        Login: <strong>{u.username}</strong>
                        {!u.is_active && <span style={{ color: 'var(--danger-text)', fontWeight: 700 }}> — disabled</span>}
                      </div>
                    </div>
                    {badge(u)}
                  </div>

                  {pageTags(u)}

                  {editingId === u.user_id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                        <div className="input-group" style={{ maxWidth: 'none' }}>
                          <label>Display name</label>
                          <input className="form-control" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} disabled={busy} />
                        </div>
                        <div className="input-group" style={{ maxWidth: 'none' }}>
                          <label>Role</label>
                          <select className="form-control" value={editRole} onChange={(e) => setEditRole(e.target.value as Role)} disabled={busy}>
                            {ROLE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div style={{ paddingTop: 10, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13, color: 'var(--app-fg)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={editUseDefault} onChange={(e) => setEditUseDefault(e.target.checked)} disabled={busy} />
                          Use the role's default pages
                        </label>
                        {!editUseDefault && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                            {ACCESSIBLE_PAGE_OPTIONS.map((p) => {
                              const on = editPages.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setEditPages((prev) => (on ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                                  style={{
                                    border: on ? '2px solid var(--blue-tag-bg)' : '1px solid var(--border-color, rgba(255,255,255,0.12))',
                                    background: on ? 'var(--blue-tag-bg)' : 'transparent',
                                    color: on ? 'var(--blue-tag-text)' : 'var(--text-muted)',
                                    borderRadius: 999,
                                    padding: '5px 12px',
                                    fontWeight: 700,
                                    fontSize: 12,
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {p.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                          When unchecked, only the selected pages appear in that user's bottom navigation.
                          The Admin page is always admin-only and can't be granted.
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="tab-btn tab-btn-green" style={{ padding: '8px 14px' }} onClick={() => handleSaveEdit(u.user_id)} disabled={busy}>
                          <Check size={15} /> Save
                        </button>
                        <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)', padding: '8px 14px' }} onClick={() => setEditingId(null)} disabled={busy}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="tab-btn tab-btn-blue"
                        style={{ padding: '7px 12px', fontSize: 12 }}
                        onClick={() => startEdit(u)}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      {u.user_id === currentUserId ? (
                        <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)', padding: '7px 12px', fontSize: 12 }} disabled>
                          <Ban size={14} /> Disable
                        </button>
                      ) : (
                        <button type="button" className="tab-btn tab-btn-amber" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => handleToggleActive(u)} disabled={busy}>
                          <Ban size={14} /> {u.is_active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                      {resetId === u.user_id ? (
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            className="form-control"
                            style={{ width: 160, padding: '7px 10px', fontSize: 12 }}
                            placeholder="New password"
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                            disabled={busy}
                          />
                          <button type="button" className="tab-btn tab-btn-green" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => handleReset(u.user_id)} disabled={busy}>
                            <Check size={14} /> Save
                          </button>
                          <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)', padding: '7px 12px', fontSize: 12 }} onClick={() => { setResetId(null); setResetPassword(''); }} disabled={busy}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)', padding: '7px 12px', fontSize: 12 }} onClick={() => { setResetId(u.user_id); setResetPassword(''); }} disabled={busy}>
                          <KeyRound size={14} /> Reset Password
                        </button>
                      )}
                      {u.user_id === currentUserId ? (
                        <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)', padding: '7px 12px', fontSize: 12 }} disabled>
                          <Trash2 size={14} /> Delete
                        </button>
                      ) : (
                        <button type="button" className="tab-btn tab-btn-red" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => handleDelete(u)} disabled={busy}>
                          <Trash2 size={14} /> Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'alerts' && <AlertsConfig />}

      {tab === 'sync' && (
        <div className="card" style={{ background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 15, color: 'var(--app-fg)' }}>
            <Database size={16} />
            Sync data from OFS
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '10px 0 16px 0' }}>
            Pull the latest downtime events, production counters and active job details straight from the
            OFS Express server into the database. Use this after a connection drop or to catch up on
            missed data — the background sync runs automatically every few minutes too.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="tab-btn tab-btn-blue" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {syncing ? 'Syncing…' : 'Sync data from OFS'}
            </button>
          </div>
          {syncMessage && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--success-text)', background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600 }}>
              {syncMessage}
            </div>
          )}
          {syncError && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600 }}>
              {syncError}
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div>
          <AlertHistory />
        </div>
      )}
    </div>
  );
}
