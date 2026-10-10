import { useEffect, useMemo, useRef, useState } from 'react';
import { redactEmails, reportContext, type ReportBug } from '../lib/diagnostics';
import { errorText } from './Toast';

interface Props {
  view: string;
  report: ReportBug;
  onClose: () => void;
}

/** Files a GitHub issue. The repository is public, so it says so and keeps addresses out. */
export function BugReportDialog({ view, report, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [withContext, setWithContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ number: number; url: string } | null>(null);
  const context = useMemo(() => reportContext(view), [view]);
  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, []);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setFiled(await report({ title: title.trim(), description: description.trim(), context: withContext ? context : undefined }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const typedEmail = redactEmails(title + description) !== title + description;

  return (
    <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bug-title" ref={ref}
        onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}>
        <div className="modal-head">
          <span className="mono-label" style={{ color: 'var(--accent-strong)' }}>Report a bug</span>
          <h3 id="bug-title">{filed ? 'Thanks, it’s filed' : 'What went wrong?'}</h3>
        </div>

        {filed ? (
          <div className="bug-body">
            <p>Your report is issue <a href={filed.url} target="_blank" rel="noreferrer">#{filed.number}</a> on GitHub. The team will follow up there.</p>
          </div>
        ) : (
          <form className="bug-body" id="bug-form" onSubmit={e => { e.preventDefault(); if (title.trim().length >= 3) send(); }}>
            <div className="notice warn">
              <span>!</span>
              <span>Reports become <b>public</b> GitHub issues. Don’t paste email content, names or other private details. Email addresses are removed automatically.</span>
            </div>
            <label>Title
              <input className="input" maxLength={120} placeholder="Attachments don't download from forwarded mail" value={title} onChange={e => setTitle(e.target.value)} />
            </label>
            <label>What happened, and what did you expect?
              <textarea className="textarea" rows={6} maxLength={5000}
                placeholder={'1. Opened a thread with a PDF\n2. Clicked the attachment\n3. Nothing downloaded; expected the file'}
                value={description} onChange={e => setDescription(e.target.value)} />
            </label>
            {typedEmail && <span className="tone-warn" style={{ fontSize: 12 }}>The email address you typed will be replaced with “[email removed]”.</span>}
            <label className="check-row">
              <input type="checkbox" checked={withContext} onChange={() => setWithContext(v => !v)} />
              <span>Include technical details</span>
            </label>
            {withContext && (
              <pre className="bug-context">{[
                'Screen   ' + context.view + ' (' + context.path + ')',
                'Build    ' + context.build,
                'Browser  ' + context.userAgent,
                'Window   ' + context.viewport,
                ...(context.errors.length ? ['Errors   ' + context.errors.join('\n         ')] : [])
              ].join('\n')}</pre>
            )}
            {error && <span className="tone-danger" role="alert">{error}</span>}
          </form>
        )}

        <div className="modal-foot">
          {filed ? (
            <>
              <a className="btn lg" href={filed.url} target="_blank" rel="noreferrer">Open on GitHub</a>
              <button className="btn primary lg" onClick={onClose}>Done</button>
            </>
          ) : (
            <>
              <button className="btn lg" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn primary lg" type="submit" form="bug-form" disabled={busy || title.trim().length < 3}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
