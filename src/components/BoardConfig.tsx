import { useCallback, useEffect, useState } from 'react';
import { Send, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { loadBoardConfig, saveBoardConfig } from '@/lib/boardConfig';

export function BoardConfig() {
  const [enabled, setEnabled] = useState(true);
  const [transitionSecs, setTransitionSecs] = useState('20');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const cfg = await loadBoardConfig();
        if (cancelled) return;
        setEnabled(cfg.enabled);
        setTransitionSecs(String(Math.max(1, Math.round(cfg.transitionMs / 1000))));
      } catch {
        if (!cancelled) setError('Could not load current settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = useCallback(async () => {
    const secs = parseInt(transitionSecs, 10);
    if (!Number.isFinite(secs) || secs < 1) {
      setError('Transition time must be at least 1 second.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveBoardConfig(enabled, secs * 1000);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [enabled, transitionSecs]);

  return (
    <div className="card" style={{ background: 'var(--card-bg)' }}>
      {loading ? (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, margin: '12px 0' }}>Loading settings…</p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px 0', lineHeight: 1.6 }}>
            Control the big-screen Board: hide it from every user's navigation when it's not in use,
            and set how long each view stays before switching between Live Status and the Production table.
          </p>

          <label className="modal-toggle-row">
            <span>Show the Board page in navigation</span>
            <button
              type="button"
              className={`toggle-switch ${enabled ? 'on' : ''}`}
              onClick={() => setEnabled((v) => !v)}
              aria-pressed={enabled}
              aria-label="Toggle the Board page"
            >
              <span className="toggle-switch-knob" />
            </button>
          </label>
          <small style={{ display: 'block', marginTop: 4, color: 'var(--text-muted)', fontSize: 12 }}>
            Turn off to remove the Board from the bottom navigation for all users. Anyone already on the
            Board falls back to their next available page.
          </small>

          <div className="input-group" style={{ maxWidth: 140, marginTop: 18 }}>
            <label htmlFor="board-transition-secs">View transition (sec)</label>
            <input
              id="board-transition-secs"
              type="number"
              min="1"
              className="form-control interval-input"
              value={transitionSecs}
              onChange={(e) => setTransitionSecs(e.target.value)}
            />
          </div>
          <small style={{ display: 'block', marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>
            How many seconds each Board view stays on screen before rotating to the other.
          </small>

          {error && (
            <div className="modal-status modal-status-error">
              <AlertCircle size={16} /> {error}
            </div>
          )}
          {saved && (
            <div className="modal-status modal-status-success">
              <CheckCircle2 size={16} /> Settings saved.
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <button
              type="button"
              className="tab-btn tab-btn-blue"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
