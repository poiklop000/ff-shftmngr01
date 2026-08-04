import { useState } from 'react';
import { LogIn, Loader2 } from 'lucide-react';
import { signIn, type AppProfile } from '@/lib/auth';

interface LoginViewProps {
  onSuccess: (profile: AppProfile) => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password) {
      setError('Enter your name and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await signIn(name.trim(), password);
      onSuccess(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  };

  return (
    <div className="login-backdrop">
      <div
        className="card login-card"
      >
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--app-fg)', lineHeight: 1.3 }}>
            Free-Flow Manufacturing
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--blue-tag-text)', marginTop: 2 }}>
            Krones Canning Line Console
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Sign in to continue</div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="input-group" style={{ maxWidth: 'none' }}>
            <label htmlFor="login-name">Name</label>
            <input
              id="login-name"
              className="form-control"
              style={{ padding: '10px 12px', fontSize: 15 }}
              autoComplete="username"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              disabled={busy}
            />
          </div>
          <div className="input-group" style={{ maxWidth: 'none' }}>
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              className="form-control"
              style={{ padding: '10px 12px', fontSize: 15 }}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              disabled={busy}
            />
          </div>

          {error && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--danger-text)',
                background: 'var(--danger-bg)',
                border: '1px solid var(--danger-border)',
                borderRadius: 8,
                padding: '8px 10px',
                fontWeight: 600,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className="tab-btn tab-btn-blue"
            style={{ width: '100%', padding: '11px 12px', fontSize: 15 }}
            disabled={busy}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />}
            {busy ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 16 }}>
          Accounts are assigned by your administrator.
        </div>
      </div>
    </div>
  );
}
