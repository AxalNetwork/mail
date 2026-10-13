import { useCallback, useEffect, useState } from 'react';
import type { InternalInbox, InternalNote, NotesStore } from '../../providers/gmail/notes';
import { messageTime } from '../../lib/format';
import { errorText, useToast } from '../Toast';

interface Props {
  store: NotesStore | null;
  /** Open the conversation a note belongs to (by its Message-ID). */
  onOpen: (key: string) => void;
  onChanged: () => void;
}

/** Workspace → Internal: where you were mentioned, and what the team is discussing. */
export function InternalPage({ store, onOpen, onChanged }: Props) {
  const toast = useToast();
  const [data, setData] = useState<InternalInbox | null>(null);
  const [tab, setTab] = useState<'mentions' | 'recent'>('mentions');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!store?.inbox) return;
    setError(null);
    store.inbox().then(setData).catch(e => setError(errorText(e)));
  }, [store]);
  useEffect(() => { load(); }, [load]);

  if (!store?.inbox) {
    return <section className="placeholder"><h1>Internal</h1><span className="muted">Team discussion needs the Axal VC Mail backend. Notes on this device show in each conversation.</span></section>;
  }

  const open = async (n: InternalNote & { read?: boolean }) => {
    if (n.read === false) { await store.markRead?.([n.id]).catch(() => {}); onChanged(); }
    onOpen(n.key);
  };
  const list = tab === 'mentions' ? data?.mentions || [] : data?.recent || [];

  return (
    <section className="admin" aria-label="Internal">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>Internal</h1>
          <span className="muted">Notes and comments the team adds to conversations. Only Axal VC members see them; they are never part of an email.</span>
        </div>
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={tab === 'mentions'} className={tab === 'mentions' ? 'on' : ''} onClick={() => setTab('mentions')}>
              Mentions{data?.unread ? ' · ' + data.unread + ' new' : ''}
            </button>
            <button role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Team activity</button>
          </div>
          {tab === 'mentions' && !!data?.unread && (
            <button className="btn sm" onClick={async () => { await store.markRead?.().catch(e => toast({ text: errorText(e), error: true })); load(); onChanged(); }}>Mark all read</button>
          )}
          <button className="btn ghost sm" onClick={load} aria-label="Refresh">↻</button>
        </div>
        {error && <div className="card panel"><span className="tone-danger">{error}</span><button className="btn sm" onClick={load}>Try again</button></div>}
        <div className="card">
          {!data && !error && <div className="panel muted">Loading…</div>}
          {data && !list.length && <div className="panel faint">{tab === 'mentions' ? 'Nobody has mentioned you yet.' : 'No internal discussion yet.'}</div>}
          {list.map(n => (
            <button key={n.id} className={'internal-row' + ('read' in n && !n.read ? ' unread' : '')} onClick={() => open(n)}>
              <span className="internal-row-top">
                <b>{n.subject || 'Conversation'}</b>
                <span className="msg-time">{messageTime(n.createdAt)}</span>
              </span>
              <span className="internal-row-text"><b>{n.author}</b> · {n.kind === 'note' ? 'note' : 'comment'}: {n.text.length > 220 ? n.text.slice(0, 220) + '…' : n.text}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
