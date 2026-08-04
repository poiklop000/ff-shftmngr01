import { useCallback, useEffect, useState } from 'react';
import { Send, BellRing, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { sendTestAlert } from '@/lib/alertLog';
import { loadLiveIntervals, saveLiveIntervals } from '@/lib/liveConfig';

export function AlertsConfig() {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState('10');
  const [recurringEnabled, setRecurringEnabled] = useState(false);
  const [recurringThreshold, setRecurringThreshold] = useState('5');
  const [escalation, setEscalation] = useState('30,60,120');
  const [liveSecs, setLiveSecs] = useState('3');
  const [summarySecs, setSummarySecs] = useState('30');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
        setLiveSecs(String(Math.round(liveMs / 1000)));
        setSummarySecs(String(Math.round(summaryMs / 1000)));
      } catch {
        if (!cancelled) setError('Could not load current settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
      await saveLiveIntervals(liveSecsNum * 1000, summarySecsNum * 1000);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [webhookUrl, enabled, threshold, recurringEnabled, recurringThreshold, escalation, liveSecs, summarySecs]);

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

  return (
    <div className="card" style={{ background: 'var(--card-bg)' }}>
      {loading ? (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, margin: '12px 0' }}>Loading settings…</p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px 0', lineHeight: 1.6 }}>
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

          <div className="input-group" style={{ maxWidth: '100%', marginTop: 14 }}>
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
            <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
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
              <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
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
              <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                Comma-separated list of minutes. An unplanned downtime that is still ongoing sends an extra "still ongoing" alert each time it crosses the next level (e.g. 30, 60, 120).
              </small>
            </div>
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--app-fg)', marginBottom: 12 }}>Auto-refresh intervals</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="input-group" style={{ maxWidth: 140 }}>
                <label htmlFor="live-refresh-secs">Live refresh (sec)</label>
                <input
                  id="live-refresh-secs"
                  type="number"
                  min="1"
                  className="form-control interval-input"
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
                  className="form-control interval-input"
                  value={summarySecs}
                  onChange={(e) => setSummarySecs(e.target.value)}
                />
              </div>
            </div>
            <small style={{ display: 'block', marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>
              How often the Live and Analytics screens re-fetch data automatically.
            </small>
          </div>

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

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <button
              type="button"
              className="tab-btn tab-btn-blue"
              onClick={handleSave}
              disabled={saving}
            >
              <Send size={15} /> {saving ? 'Saving…' : 'Save Settings'}
            </button>
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
        </>
      )}
    </div>
  );
}
