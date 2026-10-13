import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTION_TEXT, ConflictError, STATUS_LABEL, type ConversationState, type SharedActivity, type SharedApi, type SharedStatus } from '../../lib/sharedApi';
import { ago } from '../../lib/analytics';
import { errorText } from '../Toast';

const REFRESH_MS = 20_000;
const HEARTBEAT_MS = 45_000;

type Members = { email: string; name: string }[];
const nameOf = (members: Members, e: string | null) => (e === 'axal-mail' ? 'Axal VC Mail' : e ? members.find(m => m.email === e)?.name || e : '');

/**
 * Tells the team who has which conversation of a shared mailbox open. Replying
 * wins over viewing for the same conversation; closing it sends "gone".
 */
export function useSharedPresence(api: SharedApi | null, mailbox: string | undefined, entries: Record<string, 'viewing' | 'replying'>) {
  const key = JSON.stringify(entries);
  const last = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!api || !mailbox) return;
    const now: Record<string, 'viewing' | 'replying'> = JSON.parse(key);
    for (const id of Object.keys(last.current)) if (!now[id]) api.presence(mailbox, id, 'gone').catch(() => {});
    const beat = () => { for (const [id, st] of Object.entries(now)) api.presence(mailbox, id, st).catch(() => {}); };
    beat();
    last.current = now;
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [api, mailbox, key]);
  // Leaving the mailbox (or the app) says goodbye for whatever is still open.
  useEffect(() => () => {
    if (!api || !mailbox) return;
    for (const id of Object.keys(last.current)) api.presence(mailbox, id, 'gone').catch(() => {});
  }, [api, mailbox]);
}

interface Props {
  api: SharedApi;
  mailbox: string;
  threadId: string;
  members: Members;
}

/** Assignment, team status, who else is here, and history, above a shared mailbox conversation. */
export function SharedBar({ api, mailbox, threadId, members }: Props) {
  const [data, setData] = useState<{ state: ConversationState; activity: SharedActivity[]; you: string } | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);

  const load = useCallback(() => {
    api.get(mailbox, threadId).then(d => { setData(d); setErr(''); }).catch(e => setErr(errorText(e)));
  }, [api, mailbox, threadId]);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return err ? <div className="shared-bar notice warn">{err}</div> : null;
  const { state: s, you } = data;

  const change = async (c: { assignee?: string | null; status?: SharedStatus }) => {
    setBusy(true); setNote('');
    try {
      const state = await api.update(mailbox, threadId, s.version, c);
      setData(d => d && { ...d, state });
      load();
    } catch (e) {
      if (e instanceof ConflictError) {
        setData(d => d && { ...d, state: e.current });
        setNote(e.message);
      } else setNote(errorText(e));
    } finally { setBusy(false); }
  };

  const replying = s.presence.filter(p => p.state === 'replying');
  const viewing = s.presence.filter(p => p.state === 'viewing');
  const recentReply = s.lastReplyBy && s.lastReplyBy !== you && s.lastReplyAt && Date.now() - s.lastReplyAt < 24 * 3600_000;

  return (
    <div className="shared-bar" aria-label="Shared conversation">
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <span className="mono-label">{mailbox}</span>
        <select className="input sm" aria-label="Team status" value={s.status} disabled={busy} onChange={e => change({ status: e.target.value as SharedStatus })}>
          {(Object.keys(STATUS_LABEL) as SharedStatus[]).map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
        </select>
        {s.assignee
          ? <span className="pill accent">{s.assignee === you ? 'Assigned to you' : 'Assigned to ' + nameOf(members, s.assignee)}</span>
          : <span className="pill">Unassigned</span>}
        {!s.assignee && <button className="btn sm" disabled={busy} onClick={() => change({ assignee: you })}>Claim</button>}
        {s.assignee === you && <button className="btn ghost sm" disabled={busy} onClick={() => change({ assignee: null })}>Release</button>}
        <select className="input sm" aria-label="Assign to" value="" disabled={busy} onChange={e => e.target.value && change({ assignee: e.target.value === '-' ? null : e.target.value })}>
          <option value="">{s.assignee ? 'Reassign…' : 'Assign to…'}</option>
          {members.filter(m => m.email !== s.assignee).map(m => <option key={m.email} value={m.email}>{m.email === you ? 'Me' : m.name}</option>)}
          {s.assignee && s.assignee !== you && <option value="-">Unassign</option>}
        </select>
        <button className="btn ghost sm" onClick={() => setHistory(h => !h)} aria-expanded={history}>History</button>
      </div>
      {!!replying.length && <span className="tone-warn" role="status" style={{ fontSize: 12.5 }}>{replying.map(p => nameOf(members, p.email)).join(', ')} {replying.length > 1 ? 'are' : 'is'} writing a reply right now.</span>}
      {!!viewing.length && <span className="muted" style={{ fontSize: 12 }}>{viewing.map(p => nameOf(members, p.email)).join(', ')} also {viewing.length > 1 ? 'have' : 'has'} this open.</span>}
      {recentReply && <span className="tone-warn" style={{ fontSize: 12.5 }}>{nameOf(members, s.lastReplyBy)} replied from {mailbox} {ago(s.lastReplyAt!, Date.now())}.</span>}
      {note && <span className="tone-danger" role="alert" style={{ fontSize: 12.5 }}>{note}</span>}
      <span className="faint" style={{ fontSize: 11.5 }}>Team status and assignment are kept by Axal VC Mail; Gmail’s read, label and archive state is not changed by them.</span>
      {history && (
        <ul className="shared-history" aria-label="Assignment history">
          {data.activity.length ? data.activity.map((a, i) => (
            <li key={i}><b>{nameOf(members, a.actor)}</b> {(ACTION_TEXT[a.action] || (() => a.action))(a.action === 'assigned' || a.action === 'unassigned' ? nameOf(members, a.detail) : a.detail)} · {ago(a.at, Date.now())}</li>
          )) : <li className="faint">Nothing recorded yet.</li>}
        </ul>
      )}
    </div>
  );
}
