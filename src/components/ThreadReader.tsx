import type { AttachmentRef, Thread } from '../types';
import { Avatar } from './Avatar';
import { MessageBody } from './MessageBody';
import { formatSize } from '../lib/format';
import { InternalPanel } from './internal/InternalPanel';
import { SnoozeMenu } from './SnoozeMenu';
import { SaveAttachment } from './documents/SaveAttachment';
import { formatUntil } from '../lib/snooze';
import type { NotesStore } from '../providers/gmail/notes';

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
  onSnooze: (until: number) => void;
  /** Back to the inbox now (shown for a conversation snoozed here). */
  onUnsnooze?: () => void;
  onDelete: () => void;
  onDownload: (a: AttachmentRef) => void;
  /** Internal notes for real mailboxes (the demo shows its sample activity instead). */
  internal?: { store: NotesStore; authorName: string; onChanged: () => void } | null;
  /** Assignment and team status, for a conversation in a shared mailbox. */
  shared?: React.ReactNode;
  /** Saving attachments to Documents (Google Drive), when connected. */
  documents?: {
    categories: string[];
    /** messageId|name of attachments already saved. */
    saved: Set<string>;
    busy: string | null;
    onSave: (a: AttachmentRef, category: string) => void;
    onOpen: () => void;
  } | null;
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
          {t.snoozedUntil && p.onUnsnooze
            ? <button className="btn sm" onClick={p.onUnsnooze} title={'Snoozed until ' + formatUntil(t.snoozedUntil, Date.now())}>Unsnooze</button>
            : <SnoozeMenu disabled={!canAct || !p.canSnooze} onPick={p.onSnooze}
              title={p.canSnooze ? undefined : 'Snooze needs the Axal VC Mail backend'} />}
          <button className="btn sm danger" onClick={p.onDelete} disabled={!canAct}>Delete</button>
        </div>
        <h2>{t.subject}</h2>
        {t.snoozedUntil && <div className="notice" style={{ background: 'var(--surface-2)', marginTop: 6 }}>Snoozed until {formatUntil(t.snoozedUntil, Date.now())}. It comes back to the inbox then, or sooner if someone replies.</div>}
        <div className="reader-meta">
          {t.labels.map(l => <span key={l} className="pill">{l}</span>)}
          <span>{t.linkText}</span>
        </div>
      </div>
      <div className="reader-body">
        {p.shared}
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
                  <span key={i} className="attachment-wrap">
                    <button className="attachment" onClick={() => p.onDownload(a)} title={'Download ' + a.name}>
                      <span className="ext-tag">{a.ext}</span>
                      <span>{a.name}</span>
                      <span className="size">{formatSize(a.size)}</span>
                    </button>
                    {p.documents && a.attachmentId && (
                      <SaveAttachment name={a.name} categories={p.documents.categories} saved={p.documents.saved.has((a.messageId || '') + '|' + a.name)}
                        busy={p.documents.busy === (a.messageId || '') + '|' + a.name} onSave={c => p.documents!.onSave(a, c)} onOpen={p.documents.onOpen} />
                    )}
                  </span>
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
 {t.noteKey && p.internal && (
          <InternalPanel store={p.internal.store} noteKey={t.noteKey} subject={t.subject} authorName={p.internal.authorName} onChanged={p.internal.onChanged} />
        )}
        {canReply && <button className="reply-stub" onClick={() => p.onReply()}>Reply to {firstName}…</button>}
      </div>
    </section>
  );
}
