import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { ThreadSummary } from '../../types';
import { ConflictError, STATUS_LABEL, type ConversationState, type SharedApi, type SharedMailbox, type SharedStatus } from '../../lib/sharedApi';
import { ago } from '../../lib/analytics';
import { errorText } from '../Toast';

interface Props {
  api: SharedApi | null;
  /** A provider reading the given shared mailbox (through the Worker's checked proxy). */
  providerFor: (mailbox: string) => MailProvider;
  /** Open the conversation in the mailbox view. */
  onOpen: (mailbox: string, threadId: string) => void;
}

type Owner = '' | 'none' | 'me' | string;

export function SharedInboxes({ api, providerFor, onOpen }: Props) {
  const [data, setData] = useState<{ enabled: boolean; you: string; mailboxes: SharedMailbox[] } | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // One provider per opened mailbox (a new one each render would reload the list forever).
  const provider = useMemo(() => (open ? providerFor(open) : null), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api) return;
    api.mailboxes().then(d => { setData(d); if (d.mailboxes.length === 1) setOpen(d.mailboxes[0].mailbox); }).catch(e => setErr(errorText(e)));
  }, [api]);

  const page = (body: React.ReactNode) => (
    <section className="admin" aria-label="Shared Inboxes">
      <div className="page-inner" style={{ gap: 14 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>Shared Inboxes</h1>
          <span className="muted">Team mailboxes you can open. Claim or assign conversations, set their team status, and see who else is on them. Your own mailbox is unchanged.</span>
        </div>
        {body}
      </div>
    </section>
  );

  if (!api) return page(<div className="card panel"><span className="muted">Shared inboxes need the Axal VC Mail backend, which this session isn’t connected to.</span></div>);
  if (err) return page(<div className="card panel"><span className="tone-danger">{err}</span></div>);
  if (!data) return page(<div className="card panel an-loading"><div className="spinner" /> Loading…</div>);
  if (!data.enabled) {
    return page(
      <div className="card panel"><span className="muted">
        Not set up yet. A super admin connects shared mailboxes through Google Workspace domain-wide delegation (the <code>GOOGLE_SERVICE_ACCOUNT</code> secret),
        or one mailbox through a stored refresh token, then grants members access in Administration → Members &amp; access. Nobody’s personal Google sign-in is shared.
      </span></div>
    );
  }
  if (!data.mailboxes.length) return page(<div className="card panel"><span className="muted">You don’t have access to any shared mailbox yet. A super admin grants it in Administration → Members &amp; access.</span></div>);

  return page(
    <>
      {data.mailboxes.map(m => <MailboxCard key={m.mailbox} m={m} open={open === m.mailbox} onToggle={() => setOpen(o => (o === m.mailbox ? null : m.mailbox))} />)}
      {open && (() => {
        const m = data.mailboxes.find(x => x.mailbox === open)!;
        return m.connection.ok
          ? <Conversations key={open} api={api} m={m} you={data.you} provider={provider!} onOpen={id => onOpen(open, id)} />
          : null;
      })()}
    </>
  );
}

function MailboxCard({ m, open, onToggle }: { m: SharedMailbox; open: boolean; onToggle: () => void }) {
  return (
    <div className="card panel" aria-label={m.mailbox}>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 15 }}>{m.mailbox}</b>
        {m.connection.ok
          ? <span className="pill ok">● Connected</span>
          : <span className="pill danger">Not connected</span>}
        <span className="pill">{m.me.canSend ? 'You can read and send' : 'You can read (no sending)'}</span>
        {m.connection.ok && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onToggle} aria-expanded={open}>{open ? 'Hide conversations' : 'Open conversations'}</button>}
      </div>
      <span className="muted" style={{ fontSize: 12.5 }}>
        {m.connection.via === 'delegation' ? 'Google Workspace domain-wide delegation' : 'Stored Gmail authorization for this mailbox'}
        {' · '}{m.connection.ok ? 'Read live from Gmail (nothing is copied), checked ' + ago(m.connection.checkedAt, Date.now()) : m.connection.error}
      </span>
      <span style={{ fontSize: 12.5 }}>
        <span className="muted">Members: </span>
        {m.members.map((x, i) => <span key={x.email}>{i ? ', ' : ''}{x.name}{!x.canSend && <span className="faint"> (read only)</span>}</span>)}
      </span>
      {m.connection.ok && (
        <span style={{ fontSize: 12.5 }}>
          <span className="muted">Sends as: </span>
          {m.sendAs.length ? m.sendAs.map(s => s.email + (s.primary ? '' : ' (alias)')).join(', ') : <span className="tone-warn">no address Gmail accepts</span>}
        </span>
      )}
    </div>
  );
}

function Conversations({ api, m, you, provider, onOpen }: { api: SharedApi; m: SharedMailbox; you: string; provider: MailProvider; onOpen: (id: string) => void }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [states, setStates] = useState<Record<string, ConversationState>>({});
  const [status, setStatus] = useState<SharedStatus | ''>('');
  const [owner, setOwner] = useState<Owner>('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const loadStates = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const s = await api.states(m.mailbox, ids);
    setStates(prev => ({ ...prev, ...s }));
  }, [api, m.mailbox]);

  const load = useCallback(async (pageToken?: string) => {
    try {
      const p = await provider.listThreads({ folder: 'inbox', pageToken });
      setThreads(t => (pageToken && t ? [...t, ...p.threads] : p.threads));
      setNext(p.nextPageToken);
      await loadStates(p.threads.map(t => t.id));
      setErr('');
    } catch (e) { setErr(errorText(e)); }
  }, [provider, loadStates]);
  useEffect(() => { load(); }, [load]);
  // Assignments and presence change under us: refresh them for what is on screen.
  useEffect(() => {
    if (!threads?.length) return;
    const t = setInterval(() => loadStates(threads.map(x => x.id)).catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [threads, loadStates]);

  const shown = useMemo(() => (threads || []).filter(t => {
    const s = states[t.id];
    if (!s) return true;
    if (status && s.status !== status) return false;
    if (owner === 'none') return !s.assignee;
    if (owner === 'me') return s.assignee === you;
    if (owner) return s.assignee === owner;
    return true;
  }), [threads, states, status, owner, you]);

  const counts = useMemo(() => {
    const c = { open: 0, pending: 0, resolved: 0, none: 0 };
    for (const t of threads || []) { const s = states[t.id]; if (!s) continue; c[s.status]++; if (!s.assignee) c.none++; }
    return c;
  }, [threads, states]);

  const change = async (id: string, c: { assignee?: string | null; status?: SharedStatus }) => {
    setNote('');
    const s = states[id];
    try {
      const st = await api.update(m.mailbox, id, s?.version ?? 0, c);
      setStates(x => ({ ...x, [id]: { ...st, presence: s?.presence || [] } }));
    } catch (e) {
      if (e instanceof ConflictError) { setStates(x => ({ ...x, [id]: e.current })); setNote(e.message); } else setNote(errorText(e));
    }
  };
  const name = (e: string | null) => (e ? (e === you ? 'You' : m.members.find(x => x.email === e)?.name || e) : '');

  return (
    <div className="card panel" aria-label={'Conversations in ' + m.mailbox}>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 14 }}>Inbox · {m.mailbox}</b>
        <span className="row-wrap" role="tablist" aria-label="Team status">
          {(['', 'open', 'pending', 'resolved'] as const).map(k => (
            <button key={k || 'all'} role="tab" aria-selected={status === k} className={'btn sm' + (status === k ? ' primary' : ' ghost')} onClick={() => setStatus(k)}>
              {k ? STATUS_LABEL[k] + ' ' + counts[k] : 'All'}
            </button>
          ))}
        </span>
        <select className="input" aria-label="Owner" value={owner} onChange={e => setOwner(e.target.value)} style={{ marginLeft: 'auto' }}>
          <option value="">Anyone</option>
          <option value="none">Unassigned ({counts.none})</option>
          <option value="me">Assigned to me</option>
          {m.members.filter(x => x.email !== you).map(x => <option key={x.email} value={x.email}>{x.name}</option>)}
        </select>
      </div>
      <span className="faint" style={{ fontSize: 11.5 }}>Filters apply to the conversations loaded below. Team status doesn’t archive or mark anything read in Gmail.</span>
      {note && <span className="tone-danger" role="alert" style={{ fontSize: 12.5 }}>{note}</span>}
      {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
      {!threads ? <div className="an-loading"><div className="spinner" /> Reading {m.mailbox}…</div> : !shown.length ? (
        <span className="faint" style={{ fontSize: 12.5 }}>No conversations match.</span>
      ) : (
        <div className="an-list">
          {shown.map(t => {
            const s = states[t.id];
            const replying = s?.presence.filter(p => p.state === 'replying') || [];
            const viewing = s?.presence.filter(p => p.state === 'viewing') || [];
            return (
              <div key={t.id} className="an-row as-div" style={{ flexWrap: 'wrap' }}>
                <button className="an-row-main link-like" onClick={() => onOpen(t.id)} style={{ flex: '1 1 260px' }}>
                  <b>{t.subject || '(no subject)'}</b>
                  <span>{t.from} · {t.time}{s?.lastReplyBy ? ' · ' + name(s.lastReplyBy) + ' replied ' + ago(s.lastReplyAt!, Date.now()) : ''}</span>
                </button>
                <span className="row-wrap" style={{ alignItems: 'center', marginLeft: 'auto' }}>
                  {!!replying.length && <span className="pill warn">{replying.map(p => name(p.email)).join(', ')} replying</span>}
                  {!!viewing.length && <span className="pill">{viewing.map(p => name(p.email)).join(', ')} viewing</span>}
                  <select className="input sm" aria-label={'Status of ' + t.subject} value={s?.status || 'open'} onChange={e => change(t.id, { status: e.target.value as SharedStatus })}>
                    {(Object.keys(STATUS_LABEL) as SharedStatus[]).map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
                  </select>
                  <select className="input sm" aria-label={'Owner of ' + t.subject} value={s?.assignee || ''} onChange={e => change(t.id, { assignee: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {m.members.map(x => <option key={x.email} value={x.email}>{x.email === you ? 'Me' : x.name}</option>)}
                  </select>
                  {!s?.assignee && <button className="btn sm" onClick={() => change(t.id, { assignee: you })}>Claim</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {next && <div><button className="btn sm" onClick={() => load(next)}>Load more</button></div>}
    </div>
  );
}
