import { useEffect, useState } from 'react';
import { ShieldOff, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';

/**
 * Master OFS kill switch. Stored in app_config as `ofs_enabled` ("true"/"false").
 * Every edge function that talks to OFS — the live read proxy plus the
 * scheduled capture/sync crons — checks this flag and short-circuits when it is
 * "false", so one toggle stops ALL data traffic to/from OFS.
 */
export function OfsKillSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'ofs_enabled')
          .maybeSingle();
        if (!cancelled) setEnabled(data?.value?.toLowerCase() !== 'false');
      } catch {
        if (!cancelled) setError('Could not load OFS status.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    if (enabled === null) return;
    const next = !enabled;
    if (!next) {
      const ok = window.confirm(
        'Stop ALL data collection from OFS? Live screens, the background sync and every scheduled capture will stop until you turn this back on.',
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: e } = await supabase
        .from('app_config')
        .upsert({ key: 'ofs_enabled', value: String(next) }, { onConflict: 'key' });
      if (e) throw new Error(e.message);
      setEnabled(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update OFS status.');
    } finally {
      setSaving(false);
    }
  };

  const off = enabled === false;
  const bg = off ? 'var(--danger-bg)' : 'var(--success-bg)';
  const border = off ? 'var(--danger-border)' : 'var(--success-border)';
  const fg = off ? 'var(--danger-text)' : 'var(--success-text)';
  const Icon = off ? ShieldOff : ShieldCheck;

  return (
    <div className="card" style={{ background: bg, borderColor: border }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 15, color: fg }}>
            <Icon size={18} />
            {enabled === null ? 'Loading OFS status…' : off ? 'OFS data collection STOPPED' : 'OFS data collection active'}
          </div>
          <div style={{ fontSize: 12, color: fg, marginTop: 4, lineHeight: 1.5, opacity: 0.9 }}>
            {enabled === null
              ? 'Checking the kill-switch setting…'
              : off
                ? 'All traffic to OFS is blocked — live screens, background sync and scheduled captures are paused.'
                : 'The app is pulling live data from OFS. Flip the switch to stop all OFS traffic in one click.'}
          </div>
        </div>
        <label className="modal-toggle-row" style={{ margin: 0 }}>
          <button
            type="button"
            className={`toggle-switch ${off ? '' : 'on'}`}
            onClick={toggle}
            disabled={enabled === null || saving}
            aria-pressed={!off}
            aria-label={off ? 'Enable OFS data collection' : 'Disable OFS data collection'}
          >
            <span className="toggle-switch-knob" />
          </button>
        </label>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--danger-text)', fontWeight: 700, marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
