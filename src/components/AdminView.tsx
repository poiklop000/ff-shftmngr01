import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Trash2, Ban, Check, UserPlus, RefreshCw, Shield } from 'lucide-react';
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
}

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

export function AdminView({ currentUserId }: AdminViewProps) {
  const [users, setUsers] = useState<AppProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [showAdd, setShowAdd] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<Role>('operator');
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
    setBusy(true);
    setError(null);
    try {
      await adminUpdateUser(userId, { displayName: editDisplayName.trim(), role: editRole });
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

  return (
    <div>
      <div className="card" style={{ background: 'var(--blue-tag-bg)', borderColor: 'var(--blue-tag-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 15, color: 'var(--blue-tag-text)' }}>
          <Shield size={18} />
          User Management
        </div>
        <div style={{ fontSize: 12, color: 'var(--blue-tag-text)', marginTop: 6, lineHeight: 1.5 }}>
          Create accounts, reset passwords, change roles, and enable or disable access.
          Every user signs in with their name and password.
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

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <button type="button" className="tab-btn tab-btn-blue" onClick={() => setShowAdd((v) => !v)} disabled={busy}>
          <UserPlus size={16} />
          {showAdd ? 'Cancel' : 'Add User'}
        </button>
        <button type="button" className="tab-btn" style={{ background: 'var(--btn-sec-bg)', color: 'var(--btn-sec-text)' }} onClick={loadUsers} disabled={busy || loading}>
          <RefreshCw size={16} />
          Refresh
        </button>
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
      ) : users.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No users yet. Add the first user above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {users.map((u) => (
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
                    onClick={() => {
                      setEditingId(u.user_id);
                      setEditDisplayName(u.display_name);
                      setEditRole(u.role);
                    }}
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
    </div>
  );
}
