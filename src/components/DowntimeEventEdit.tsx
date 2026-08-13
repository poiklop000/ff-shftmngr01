import { useState } from 'react';
import { AlertCircle, Check, Loader2, Pencil, RotateCcw, X } from 'lucide-react';
import {
  correctDowntimeEvent,
  epochToLocalMilitaryText,
  formatDuration,
  formatEventTime,
  isUserEditableEvent,
  localDateTimeToEpoch,
  parseDurationInput,
  resetDowntimeEvent,
  type DowntimeEvent,
} from '@/lib/downtime';

interface DowntimeEventEditProps {
  event: DowntimeEvent;
  onSaved: () => void | Promise<void>;
}

/**
 * Pencil trigger + modal for correcting a setup/running-slow event's duration
 * and end time. The correction is saved to downtime_events with `user_edited`
 * set so capture-downtime / sync-spans-history stop managing the row. A reset
 * restores the OFS-captured figures and unlocks the row again.
 */
export function DowntimeEventEdit({ event, onSaved }: DowntimeEventEditProps) {
  const [open, setOpen] = useState(false);
  const [durationText, setDurationText] = useState('');
  const [endText, setEndText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isUserEditableEvent(event)) return null;

  const openEditor = () => {
    setDurationText(formatDuration(event.duration_ms ?? 0));
    setEndText(
      event.end_epoch != null
        ? epochToLocalMilitaryText(event.end_epoch)
        : epochToLocalMilitaryText(event.start_epoch + (event.duration_ms ?? 0)),
    );
    setError(null);
    setOpen(true);
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    setError(null);
  };

  const handleDurationChange = (text: string) => {
    setDurationText(text);
    const ms = parseDurationInput(text);
    if (ms != null && ms >= 0) setEndText(epochToLocalMilitaryText(event.start_epoch + ms));
  };

  const handleEndChange = (text: string) => {
    setEndText(text);
    const endEpoch = localDateTimeToEpoch(text);
    if (!Number.isNaN(endEpoch) && endEpoch > event.start_epoch) {
      setDurationText(formatDuration(endEpoch - event.start_epoch));
    }
  };

  const save = async () => {
    const endEpoch = localDateTimeToEpoch(endText);
    if (Number.isNaN(endEpoch)) {
      setError('Enter a valid end date and time.');
      return;
    }
    if (endEpoch <= event.start_epoch) {
      setError('End time must be after the start time.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await correctDowntimeEvent(event.id, endEpoch - event.start_epoch, endEpoch);
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the correction.');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      await resetDowntimeEvent(event.id);
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the correction.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        title={event.user_edited ? 'Corrected — click to edit again' : 'Correct duration / end time'}
        onClick={openEditor}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-slate-200 text-slate-400 hover:text-brand-700 hover:border-brand-300 hover:bg-brand-50 transition-colors"
      >
        {event.user_edited ? <Check size={13} /> : <Pencil size={13} />}
      </button>

      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Correct {event.downtime_type?.toLowerCase() ?? 'event'}</h2>
              <button type="button" className="modal-close-btn" onClick={close} aria-label="Close">
                <X size={20} />
              </button>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-muted, #888)', margin: '0 0 14px 0' }}>
              Fix the duration or end time for this {event.downtime_type?.toLowerCase() ?? 'event'}. The
              correction is saved to the database and the live capture stops adjusting it.
            </p>

            <div className="input-group" style={{ marginBottom: 12 }}>
              <label>Start time</label>
              <input type="text" className="form-control" readOnly value={formatEventTime(event.start_epoch)} />
            </div>

            <div className="input-group" style={{ marginBottom: 12 }}>
              <label>Duration</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. 47:30"
                value={durationText}
                onChange={(e) => handleDurationChange(e.target.value)}
                disabled={saving}
              />
              <small style={{ color: 'var(--text-muted, #888)', fontSize: 11 }}>
                Accepts HH:MM:SS, MM:SS, or minutes (e.g. 47.5)
              </small>
            </div>

            <div className="input-group" style={{ marginBottom: 12 }}>
              <label>End time</label>
              <input
                type="text"
                className="form-control"
                placeholder="YYYY-MM-DD HH:MM:SS"
                value={endText}
                onChange={(e) => handleEndChange(e.target.value)}
                disabled={saving}
              />
              <small style={{ color: 'var(--text-muted, #888)', fontSize: 11 }}>
                Factory local time (Auckland), 24-hour format e.g. 2026-08-13 19:30:05. Start time
                is fixed; duration = end − start.
              </small>
            </div>

            {error && (
              <div className="modal-status modal-status-error">
                <AlertCircle size={16} /> {error}
              </div>
            )}

            <div className="sm-btn-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              {event.user_edited && (
                <button type="button" className="tab-btn" onClick={reset} disabled={saving}>
                  <RotateCcw size={14} /> Reset to OFS
                </button>
              )}
              <button type="button" className="tab-btn" onClick={close} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="tab-btn tab-btn-green" onClick={save} disabled={saving}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
