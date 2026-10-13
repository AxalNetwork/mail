import { useState } from 'react';
import { usePopover } from './usePopover';
import { formatUntil, snoozeOptions } from '../lib/snooze';

const local = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

/** The Snooze button and its choices. Times are in the browser's time zone. */
export function SnoozeMenu({ disabled, title, onPick }: { disabled: boolean; title?: string; onPick: (until: number) => void }) {
  const { open, setOpen, toggle, ref } = usePopover<HTMLDivElement>();
  const [now, setNow] = useState(() => Date.now());
  const [custom, setCustom] = useState('');
  const pick = (t: number) => { setOpen(false); onPick(t); };
  const customAt = custom ? new Date(custom).getTime() : NaN;
  const customOk = Number.isFinite(customAt) && customAt > Date.now();

  return (
    <div className="snooze-wrap" ref={ref}>
      <button className="btn sm" disabled={disabled} title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setNow(Date.now()); setCustom(local(Date.now() + 86_400_000)); toggle(); }}>Snooze</button>
      {open && (
        <div className="card snooze-menu" role="menu" aria-label="Snooze until">
          {snoozeOptions(now).map(o => (
            <button key={o.key} role="menuitem" className="snooze-item" onClick={() => pick(o.at)}>
              <span>{o.label}</span><span className="muted">{formatUntil(o.at, now)}</span>
            </button>
          ))}
          <form className="snooze-custom" onSubmit={e => { e.preventDefault(); if (customOk) pick(customAt); }}>
            <label className="muted" style={{ fontSize: 12 }}>Pick a date and time
              <input className="input sm" type="datetime-local" value={custom} min={local(now)} onChange={e => setCustom(e.target.value)} aria-label="Snooze until date and time" />
            </label>
            <button className="btn primary sm" type="submit" disabled={!customOk}>Snooze</button>
          </form>
        </div>
      )}
    </div>
  );
}
