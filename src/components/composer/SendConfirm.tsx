import { useEffect, useRef, useState } from 'react';

interface Props {
  reasons: string[];
  rows: { k: string; v: string }[];
  action: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Review step shown before a send that has something worth double-checking. */
export function SendConfirm({ reasons, rows, action, busy, onCancel, onConfirm }: Props) {
  const [reviewed, setReviewed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="modal-scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabIndex={-1} ref={ref}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
        <div className="modal-head">
          <span className="mono-label">Review before sending</span>
          <h3 id="confirm-title">{reasons.length === 1 ? 'One thing to check' : reasons.length + ' things to check'}</h3>
        </div>
        <div className="reasons">
          {reasons.map((r, i) => <div key={i} className="notice danger reason"><span>!</span><span>{r}</span></div>)}
        </div>
        <div className="kv">
          {rows.map(r => (
            <div key={r.k} className="kv-row"><span className="mono-key">{r.k}</span><span>{r.v}</span></div>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={reviewed} onChange={() => setReviewed(v => !v)} />
          <span>I've checked the recipients, sender and attachments.</span>
        </label>
        <div className="modal-foot">
          <button className="btn lg" onClick={onCancel}>Back to draft</button>
          <button className={'btn primary lg' + (reviewed ? '' : ' off')} disabled={!reviewed || busy} onClick={onConfirm}>
            {busy ? 'Sending…' : action}
          </button>
        </div>
      </div>
    </div>
  );
}
