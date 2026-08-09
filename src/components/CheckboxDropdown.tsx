import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function CheckboxDropdown({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const active = selected.length > 0;
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${label} filter`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
          cursor: 'pointer', fontFamily: 'inherit',
          border: `1px solid ${active ? 'var(--blue-tag-border)' : 'var(--input-border)'}`,
          backgroundColor: active ? 'var(--blue-tag-bg)' : 'var(--input-bg)',
          color: active ? 'var(--blue-tag-text)' : 'var(--input-text)',
          transition: 'background-color 0.15s, border-color 0.15s',
        }}
      >
        {label}
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 800,
            backgroundColor: active ? 'var(--blue-tag-text)' : 'var(--track-bg)',
            color: active ? 'var(--card-bg)' : 'var(--text-muted)',
          }}
        >
          {selected.length === 0 ? 'All' : selected.length}
        </span>
        <ChevronDown size={12} style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4,
              background: 'var(--card-bg)', border: '1px solid var(--input-border)',
              borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              padding: 6, minWidth: 230, maxHeight: 280, overflowY: 'auto',
            }}
          >
            {options.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 6 }}>No options</div>
            ) : (
              <>
                <button
                  type="button"
                  className="tab-btn tab-btn-blue"
                  style={{ width: '100%', marginBottom: 4, fontSize: 11, padding: '3px 8px' }}
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
                {options.map((o) => {
                  const checked = selected.includes(o.value);
                  return (
                    <label
                      key={o.value}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                        fontSize: 12, color: 'var(--input-text)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(o.value)}
                        style={{ accentColor: '#2563eb', cursor: 'pointer' }}
                      />
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                    </label>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
