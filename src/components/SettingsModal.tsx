import { useCallback, useState } from 'react';
import { X, AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';
import { changePassword } from '@/lib/auth';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  kiosk?: boolean;
  onKioskChange?: (value: boolean) => void;
}

export function SettingsModal({ open, onClose, kiosk = false, onKioskChange }: SettingsModalProps) {
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const handleChangePassword = useCallback(async () => {
    if (pwNew.length < 6) {
      setPwError('New password must be at least 6 characters.');
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError('Passwords do not match.');
      return;
    }
    setPwSaving(true);
    setPwError(null);
    setPwSaved(false);
    try {
      await changePassword(pwNew);
      setPwNew('');
      setPwConfirm('');
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 3000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Could not change password. Please try again.');
    } finally {
      setPwSaving(false);
    }
  }, [pwNew, pwConfirm]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <label className="modal-toggle-row">
          <span>Kiosk mode (auto fullscreen on load)</span>
          <button
            type="button"
            className={`toggle-switch ${kiosk ? 'on' : ''}`}
            onClick={() => onKioskChange?.(!kiosk)}
            aria-pressed={kiosk}
            aria-label="Toggle kiosk mode"
          >
            <span className="toggle-switch-knob" />
          </button>
        </label>
        <small style={{ display: 'block', marginTop: 4, color: 'var(--text-muted, #888)', fontSize: 12 }}>
          Best for wall displays or tablets: opens the console in fullscreen automatically whenever it loads.
        </small>

        <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
            <KeyRound size={16} />
            Change Password
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', margin: '0 0 12px 0' }}>
            Update the password used to sign in to this account.
          </p>

          <div className="input-group" style={{ maxWidth: '100%', marginBottom: 12 }}>
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              className="form-control"
              placeholder="At least 6 characters"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              disabled={pwSaving}
            />
          </div>

          <div className="input-group" style={{ maxWidth: '100%', marginBottom: 12 }}>
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              className="form-control"
              placeholder="Re-enter the new password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              disabled={pwSaving}
            />
          </div>

          {pwError && (
            <div className="modal-status modal-status-error">
              <AlertCircle size={16} /> {pwError}
            </div>
          )}
          {pwSaved && (
            <div className="modal-status modal-status-success">
              <CheckCircle2 size={16} /> Password updated.
            </div>
          )}

          <div className="sm-btn-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="tab-btn tab-btn-green"
              onClick={handleChangePassword}
              disabled={pwSaving}
            >
              <KeyRound size={15} /> {pwSaving ? 'Updating…' : 'Change Password'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
