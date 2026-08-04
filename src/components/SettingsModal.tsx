import { useCallback, useEffect, useState } from 'react';
import { X, Send, CheckCircle2, AlertCircle, KeyRound, BellRing, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { changePassword } from '@/lib/auth';
import { sendTestAlert } from '@/lib/alertLog';
import { loadLiveIntervals, saveLiveIntervals } from '@/lib/liveConfig';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  kiosk?: boolean;
  onKioskChange?: (value: boolean) => void;
}

export function SettingsModal({ open, onClose, isAdmin, kiosk = false, onKioskChange }: SettingsModalProps) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState('10');
  const [recurringEnabled, setRecurringEnabled] = useState(false);
  const [recurringThreshold, setRecurringThreshold] = useState('5');
  const [escalation, setEscalation] = useState('30,60,120');
  const [defaultCans, setDefaultCans] = useState('24000');
  const [liveSecs, setLiveSecs] = useState('3');
  const [summarySecs, setSummarySecs] = useState('30');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPwError(null);
    setPwSaved(false);
    setTestMsg(null);
    setTestError(null);
    if (!isAdmin) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: webhookRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_webhook_url')
          .maybeSingle();
        const { data: enabledRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_alerts_enabled')
          .maybeSingle();
        const { data: thresholdRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_alert_threshold_minutes')
          .maybeSingle();
        const { data: recurringEnabledRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_recurring_alerts_enabled')
          .maybeSingle();
        const { data: recurringThresholdRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_recurring_alert_initial_threshold')
          .maybeSingle();
        const { data: escalationRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_alert_escalation_minutes')
          .maybeSingle();
        const { data: defaultCansRow } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'teams_default_cans_per_hour')
          .maybeSingle();
        let liveMs = 3000;
        let summaryMs = 30000;
        try {
          const intervals = await loadLiveIntervals();
          liveMs = intervals.liveMs;
          summaryMs = intervals.summaryMs;
        } catch {
          // keep defaults
        }
        if (cancelled) return;
        setWebhookUrl(webhookRow?.value ?? '');
        setEnabled(enabledRow?.value?.toLowerCase() === 'true');
        const parsedThreshold = parseInt(thresholdRow?.value ?? '10', 10);
        setThreshold(Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? String(parsedThreshold) : '10');
        setRecurringEnabled(recurringEnabledRow?.value?.toLowerCase() === 'true');
        const parsedRecurring = parseInt(recurringThresholdRow?.value ?? '5', 10);
        setRecurringThreshold(Number.isFinite(parsedRecurring) && parsedRecurring >= 2 ? String(parsedRecurring) : '5');
        setEscalation(escalationRow?.value ?? '30,60,120');
        const parsedCans = parseInt(defaultCansRow?.value ?? '24000', 10);
        setDefaultCans(Number.isFinite(parsedCans) && parsedCans > 0 ? String(parsedCans) : '24000');
        setLiveSecs(String(Math.round(liveMs / 1000)));
        setSummarySecs(String(Math.round(summaryMs / 1000)));
      } catch {
        if (!cancelled) setError('Could not load current settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, isAdmin]);

  const handleSave = useCallback(async () => {
    const trimmed = webhookUrl.trim();
    if (enabled && !trimmed) {
      setError('Paste a Microsoft Teams webhook URL before enabling alerts.');
      return;
    }
    const parsedEscalation = escalation
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parsedEscalation.length === 0) {
      setError('Escalation levels must be a comma-separated list of minutes, e.g. 30,60,120.');
      return;
    }
    const safeEscalation = parsedEscalation.join(',');
    const parsedCans = parseInt(defaultCans, 10);
    const safeCans = Number.isFinite(parsedCans) && parsedCans > 0 ? String(parsedCans) : '24000';
    const liveSecsNum = parseInt(liveSecs, 10);
    const summarySecsNum = parseInt(summarySecs, 10);
    if (!Number.isFinite(liveSecsNum) || liveSecsNum < 1 || !Number.isFinite(summarySecsNum) || summarySecsNum < 1) {
      setError('Refresh intervals must be at least 1 second.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const upsert = async (key: string, value: string) => {
        const { error: e } = await supabase
          .from('app_config')
          .upsert({ key, value }, { onConflict: 'key' });
        if (e) throw new Error(e.message);
      };
      await upsert('teams_webhook_url', trimmed);
      await upsert('teams_alerts_enabled', String(enabled));
      const parsedThreshold = parseInt(threshold, 10);
      await upsert('teams_alert_threshold_minutes', Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? String(parsedThreshold) : '10');
      await upsert('teams_recurring_alerts_enabled', String(recurringEnabled));
      const parsedRecurring = parseInt(recurringThreshold, 10);
      await upsert('teams_recurring_alert_initial_threshold', Number.isFinite(parsedRecurring) && parsedRecurring >= 2 ? String(parsedRecurring) : '5');
      await upsert('teams_alert_escalation_minutes', safeEscalation);
      await upsert('teams_default_cans_per_hour', safeCans);
      await saveLiveIntervals(liveSecsNum * 1000, summarySecsNum * 1000);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [webhookUrl, enabled, threshold, recurringEnabled, recurringThreshold, escalation, defaultCans, liveSecs, summarySecs]);

  const handleSendTest = useCallback(async () => {
    if (!webhookUrl.trim()) {
      setTestError('Paste a Microsoft Teams webhook URL before sending a test alert.');
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestMsg(null);
    try {
      await sendTestAlert();
      setTestMsg('Test alert sent — check Microsoft Teams.');
      setTimeout(() => setTestMsg(null), 6000);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Could not send test alert.');
    } finally {
      setTesting(false);
    }
  }, [webhookUrl]);

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

        {isAdmin && loading ? (
          <p className="modal-loading">Loading settings…</p>
        ) : (
          <>
            {isAdmin && (
              <>
            <p className="modal-description">
              Get a Microsoft Teams message when a downtime event starts and when it ends.
              Create an incoming webhook in your Teams channel (Apps → Workflows → Post to a channel
              when a webhook request is received), pick a channel, and paste the URL below.
            </p>

            <div className="input-group" style={{ maxWidth: '100%' }}>
              <label htmlFor="teams-webhook">Microsoft Teams Webhook URL</label>
              <input
                id="teams-webhook"
                type="url"
                className="form-control"
                placeholder="https://*.webhook.office.com/webhookb2/…"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
            </div>

            <div className="input-group" style={{ maxWidth: '100%' }}>
              <label htmlFor="teams-threshold">Alert threshold (minutes)</label>
              <input
                id="teams-threshold"
                type="number"
                min="1"
                className="form-control"
                placeholder="10"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
              <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                Two alerts are sent: one when downtime starts and one when it ends. Alerts are only sent if the downtime lasts at least this many minutes.
              </small>
            </div>

            <label className="modal-toggle-row">
              <span>Enable Microsoft Teams alerts</span>
              <button
                type="button"
                className={`toggle-switch ${enabled ? 'on' : ''}`}
                onClick={() => setEnabled((v) => !v)}
                aria-pressed={enabled}
                aria-label="Toggle Microsoft Teams alerts"
              >
                <span className="toggle-switch-knob" />
              </button>
            </label>

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
              <label className="modal-toggle-row">
                <span>Enable recurring issue alerts</span>
                <button
                  type="button"
                  className={`toggle-switch ${recurringEnabled ? 'on' : ''}`}
                  onClick={() => setRecurringEnabled((v) => !v)}
                  aria-pressed={recurringEnabled}
                  aria-label="Toggle recurring issue alerts"
                >
                  <span className="toggle-switch-knob" />
                </button>
              </label>

              <div className="input-group" style={{ maxWidth: '100%', marginTop: 12 }}>
                <label htmlFor="recurring-threshold">Recurring alert threshold (occurrences)</label>
                <input
                  id="recurring-threshold"
                  type="number"
                  min="2"
                  className="form-control"
                  placeholder="5"
                  value={recurringThreshold}
                  onChange={(e) => setRecurringThreshold(e.target.value)}
                />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                  Sends an alert when the same downtime reason + category occurs this many times within a rolling 1-hour window. Re-fires at escalating intervals (+2 each time: 5, 7, 9, 11…).
                </small>
              </div>

              <div className="input-group" style={{ maxWidth: '100%', marginTop: 12 }}>
                <label htmlFor="escalation-levels">Escalation levels (minutes)</label>
                <input
                  id="escalation-levels"
                  type="text"
                  className="form-control"
                  placeholder="30,60,120"
                  value={escalation}
                  onChange={(e) => setEscalation(e.target.value)}
                />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                  Comma-separated list of minutes. An unplanned downtime that is still ongoing sends an extra "still ongoing" alert each time it crosses the next level (e.g. 30, 60, 120).
                </small>
              </div>

              <div className="input-group" style={{ maxWidth: '100%', marginTop: 12 }}>
                <label htmlFor="default-cans">Default cans per hour</label>
                <input
                  id="default-cans"
                  type="number"
                  min="1"
                  className="form-control"
                  placeholder="24000"
                  value={defaultCans}
                  onChange={(e) => setDefaultCans(e.target.value)}
                />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                  Used to estimate "cans lost" in alerts when the current job's rated speed is unknown.
                </small>
              </div>
            </div>

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
              <label className="modal-toggle-row" style={{ marginTop: 0 }}>
                <span>Auto-refresh intervals</span>
              </label>
              <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <div className="input-group" style={{ maxWidth: 140 }}>
                  <label htmlFor="live-refresh-secs">Live refresh (sec)</label>
                  <input
                    id="live-refresh-secs"
                    type="number"
                    min="1"
                    className="form-control"
                    value={liveSecs}
                    onChange={(e) => setLiveSecs(e.target.value)}
                  />
                </div>
                <div className="input-group" style={{ maxWidth: 140 }}>
                  <label htmlFor="summary-refresh-secs">Summary refresh (sec)</label>
                  <input
                    id="summary-refresh-secs"
                    type="number"
                    min="1"
                    className="form-control"
                    value={summarySecs}
                    onChange={(e) => setSummarySecs(e.target.value)}
                  />
                </div>
              </div>
              <small style={{ display: 'block', marginTop: 8, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                How often the Live and Analytics screens re-fetch data automatically.
              </small>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
              <button
                type="button"
                className="tab-btn tab-btn-purple"
                onClick={handleSendTest}
                disabled={testing}
              >
                {testing ? <Loader2 size={15} className="animate-spin" /> : <BellRing size={15} />}
                {testing ? 'Sending…' : 'Send Test Alert'}
              </button>
            </div>
            {testError && (
              <div className="modal-status modal-status-error">
                <AlertCircle size={16} /> {testError}
              </div>
            )}
            {testMsg && (
              <div className="modal-status modal-status-success">
                <CheckCircle2 size={16} /> {testMsg}
              </div>
            )}

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

            <div className="sm-btn-row" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="tab-btn tab-btn-blue"
                onClick={handleSave}
                disabled={saving}
              >
                <Send size={15} /> {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
              </>
            )}

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
          </>
        )}
      </div>
    </div>
  );
}
