import { useCallback, useEffect, useState } from 'react';
import type { InternalNote, Mentionable, NoteActivity, NoteKind, NotesStore } from '../../providers/gmail/notes';
import { messageTime } from '../../lib/format';
import { errorText, useToast } from '../Toast';
import { MentionBox, mentionedEmails } from './MentionBox';

interface Props {
  store: NotesStore;
  noteKey: string;
  subject: string;
  authorName: string;
  /** Called after a change, e.g. to refresh unread mentions. */
  onChanged?: () => void;
}

const ACTION: Record<string, string> = { created: 'added a note', edited: 'edited a note', deleted: 'deleted a note', mentioned: 'mentioned' };

/** Team-only discussion under a conversation. Never part of any email. */
export function InternalPanel({ store, noteKey, subject, authorName, onChanged }: Props) {
  const toast = useToast();
  const [notes, setNotes] = useState<InternalNote[] | null>(null);
  const [members, setMembers] = useState<Mentionable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<NoteKind>('comment');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [history, setHistory] = useState<NoteActivity[] | null>(null);

  const load = useCallback(() => {
    setError(null);
    store.list(noteKey).then(setNotes).catch(e => setError(errorText(e)));
  }, [store, noteKey]);
  useEffect(() => { setNotes(null); setHistory(null); load(); }, [load]);
  useEffect(() => { store.members?.().then(setMembers).catch(() => {}); }, [store]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      load();
      if (history) store.activity(noteKey).then(setHistory).catch(() => {});
      onChanged?.();
      return true;
    } catch (e) {
      toast({ text: errorText(e), error: true });
      return false;
    } finally { setBusy(false); }
  };

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    const mentions = mentionedEmails(t, members);
    if (await act(() => store.add(noteKey, t, authorName, { kind, subject, mentions }),
      mentions.length ? 'Posted; ' + mentions.length + ' teammate' + (mentions.length === 1 ? '' : 's') + ' notified in Internal' : undefined)) setText('');
  };

  return (
    <section className="internal" aria-label="Internal discussion">
      <div className="internal-head">
        <span className="mono-label">Internal</span>
        <span className="internal-badge">{store.shared ? 'Axal VC team only · never sent' : 'This device only · never sent'}</span>
        <button className="link-btn" style={{ marginLeft: 'auto', fontSize: 12 }}
          onClick={() => (history ? setHistory(null) : store.activity(noteKey).then(setHistory).catch(e => toast({ text: errorText(e), error: true })))}>
          {history ? 'Hide history' : 'History'}
        </button>
      </div>

      {error && <span className="tone-danger" style={{ fontSize: 12.5 }}>{error} <button className="link-btn" onClick={load}>Retry</button></span>}
      {!notes && !error && <span className="faint" style={{ fontSize: 12.5 }}>Loading internal notes…</span>}

      {notes?.map(n => (
        <article key={n.id} className={'internal-note ' + n.kind}>
          <div className="internal-meta">
            <b>{n.author}</b>
            <span className="pill" style={{ border: 0 }}>{n.kind === 'note' ? 'Note' : 'Comment'}</span>
            <span className="msg-time">{messageTime(n.createdAt)}{n.updatedAt ? ' · edited' : ''}</span>
            {(n.canEdit || n.canDelete) && editing?.id !== n.id && (
              <span className="internal-tools">
                {n.canEdit && <button className="link-btn" onClick={() => setEditing({ id: n.id, text: n.text })}>Edit</button>}
                {n.canDelete && <button className="link-btn" disabled={busy}
                  onClick={() => window.confirm('Delete this ' + n.kind + ' for everyone?') && act(() => store.remove(n.id), 'Deleted')}>Delete</button>}
              </span>
            )}
          </div>
          {editing?.id === n.id ? (
            <div className="internal-edit">
              <MentionBox label="Edit" value={editing.text} members={members} autoFocus onChange={v => setEditing({ id: n.id, text: v })}
                onSubmit={() => editing.text.trim() && act(() => store.edit(n.id, editing.text.trim(), mentionedEmails(editing.text, members))).then(ok => ok && setEditing(null))} />
              <div className="row-wrap">
                <button className="btn primary sm" disabled={busy || !editing.text.trim()}
                  onClick={async () => { if (await act(() => store.edit(n.id, editing.text.trim(), mentionedEmails(editing.text, members)), 'Saved')) setEditing(null); }}>Save</button>
                <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="internal-text">{highlight(n.text, n.mentions.map(m => m.name))}</div>
          )}
        </article>
      ))}
      {notes?.length === 0 && <span className="faint" style={{ fontSize: 12.5 }}>No internal discussion yet. Add context for the team; the sender never sees it.</span>}

      {history && (
        <div className="internal-history">
          {history.length === 0 && <span className="faint">No activity yet.</span>}
          {history.map((h, i) => (
            <div key={i} className="activity-row"><span className="ring" /><span className="grow">{h.actor} {ACTION[h.action] || h.action}{h.target ? ' ' + h.target : ''}</span><span className="msg-time">{messageTime(h.at)}</span></div>
          ))}
        </div>
      )}

      <div className="internal-compose">
        <div className="seg" role="radiogroup" aria-label="Type">
          {(['comment', 'note'] as const).map(k => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'comment' ? 'Comment' : 'Note'}
            </button>
          ))}
        </div>
        <MentionBox label="Internal comment" value={text} members={members} onChange={setText} onSubmit={submit}
          placeholder={kind === 'note' ? 'Context for the team (e.g. “Potential LP, interested in AI infra”)' : 'Discuss with the team. Type @ to mention someone.'} />
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <button className="btn primary sm" disabled={busy || !text.trim()} onClick={submit}>Post internally</button>
          <span className="faint" style={{ fontSize: 11.5 }}>Not sent to anyone outside Axal VC. ⌘/Ctrl+Enter to post.</span>
        </div>
      </div>
    </section>
  );
}

function highlight(text: string, names: string[]) {
  if (!names.length) return text;
  const re = new RegExp('(' + names.map(n => '@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  return text.split(re).map((part, i) => (i % 2 ? <span key={i} className="mention">{part}</span> : part));
}
