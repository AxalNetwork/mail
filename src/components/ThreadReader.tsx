import type { AttachmentRef, Thread } from '../types';
import { Avatar } from './Avatar';
import { MessageBody } from './MessageBody';
import { formatSize } from '../lib/format';

interface Props {
  thread: Thread | null;
  loading: boolean;
  error: string | null;
  canSnooze: boolean;
  demoMode: boolean;
  onBack: () => void;
  onReply: (all?: boolean) => void;
  onForward: () => void;
  onArchive: () => void;
  onSnooze: () => void;
  onDelete: () => void;
  onDownload: (a: AttachmentRef) => void;
}

export function ThreadReader({ thread: t, loading, error, ...p }: Props) {
  if (!t) {
    return (
      <section className="reader" aria-label="Conversation">
        <div className="reader-empty">
          {loading ? <div className="spinner" /> : error ? <span className="tone-danger">{error}</span> : 'Select a conversation'}
        </div>
      </section>
    );
  }
  const canAct = !t.outgoing;
  const canReply = !t.outgoing && !t.noReply;
  const firstName = t.from.replace(/ \(\d+\)$/, '').split(' ')[0];
  return (
    <section className="reader" aria-label="Conversation">
      <div className="reader-head">
        <div className="reader-actions">
          <button className="btn sm back" onClick={p.onBack}>‹ Back</button>
          <button className="btn primary sm" onClick={() => p.onReply()} disabled={!canReply}>Reply</button>
          <button className="btn sm" onClick={() => p.onReply(true)} disabled={!canReply}>Reply all</button>
          <button className="btn sm" onClick={p.onForward}>Forward</button>
          <button className="btn sm" onClick={p.onArchive} disabled={!canAct}>Archive</button>
          <button className="btn sm" onClick={p.onSnooze} disabled={!canAct || !p.canSnooze}
            title={p.canSnooze ? undefined : 'Snooze is not available through the Gmail API'}>Snooze</button>
          <button className="btn sm danger" onClick={p.onDelete} disabled={!canAct}>Delete</button>
        </div>
        <h2>{t.subject}</h2>
        <div className="reader-meta">
          {t.labels.map(l => <span key={l} className="pill">{l}</span>)}
          <span>{t.linkText}</span>
        </div>
      </div>
      <div className="reader-body">
        {t.messages.map(m => (
          <article key={m.id} className="card msg">
            <div className="msg-head">
              <Avatar name={m.from} />
              <div className="msg-who">
                <div><b>{m.from}</b> {m.email && <span className="faint">&lt;{m.email}&gt;</span>}</div>
                <div className="to">To {m.to}{m.cc ? ' · Cc ' + m.cc : ''}</div>
              </div>
              <span className="msg-time">{m.time}</span>
            </div>
            <MessageBody text={m.text} html={m.html} />
            {m.demo && <div className="msg-demo">Recorded in demo mode. No delivery was attempted.</div>}
            {m.attachments.length > 0 && (
              <div className="attachments">
                {m.attachments.map((a, i) => (
                  <button key={i} className="attachment" onClick={() => p.onDownload(a)} title={'Download ' + a.name}>
                    <span className="ext-tag">{a.ext}</span>
                    <span>{a.name}</span>
                    <span className="size">{formatSize(a.size)}</span>
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
        {t.activity.length > 0 && (
          <div className="activity">
            <div className="activity-head">
              <span className="mono-label">Internal activity</span>
              <span className="rule" />
              <span className="faint">{p.demoMode ? 'Axal team only · never sent' : 'Never sent'}</span>
            </div>
            {t.activity.map((ev, i) => (
              <div key={i} className="activity-row">
                <span className="ring" />
                <span className="grow">{ev.text}</span>
                <span className="msg-time">{ev.time}</span>
              </div>
            ))}
          </div>
        )}
        {canReply && <button className="reply-stub" onClick={() => p.onReply()}>Reply to {firstName}…</button>}
      </div>
    </section>
  );
}
