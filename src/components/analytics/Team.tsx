import { useEffect, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { ConversationStat } from '../../types';
import type { SharedApi, SharedMailbox, TeamSummary } from '../../lib/sharedApi';
import { computeStats, duration } from '../../lib/analytics';
import { errorText } from '../Toast';
import { sample } from './useStats';
import { downloadCsv, toCsv } from './csv';

interface Props {
  api: SharedApi | null;
  /** Shared mailboxes the member can open (others are never requested). */
  mailboxes: SharedMailbox[];
  providerFor: ((mailbox: string) => MailProvider) | null;
  initial?: string;
  from: number;
  to: number;
  days: number;
  orgDomain: string;
}

/**
 * Workload in a shared mailbox: who holds which conversations and how fast the
 * mailbox answers. Members are listed alphabetically; this is not a ranking or
 * a performance score.
 */
export function Team({ api, mailboxes, providerFor, initial, from, to, days, orgDomain }: Props) {
  const [mailbox, setMailbox] = useState(initial && mailboxes.some(m => m.mailbox === initial) ? initial : mailboxes[0]?.mailbox || '');
  const [sum, setSum] = useState<TeamSummary | null>(null);
  const [convs, setConvs] = useState<ConversationStat[] | null>(null);
  const [tracked, setTracked] = useState<Set<string> | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!api?.summary || !mailbox || !providerFor) return;
    let live = true;
    setSum(null); setConvs(null); setTracked(null); setErr('');
    api.summary(mailbox, from, to).then(s => live && setSum(s)).catch(e => live && setErr(errorText(e)));
    sample(providerFor(mailbox), days, false).then(async r => {
      if (!live) return;
      setConvs(r.conversations);
      // Which of these conversations someone has already triaged (has a stored state).
      const ids = r.conversations.map(c => c.id);
      const seen = new Set<string>();
      for (let i = 0; i < ids.length; i += 100) {
        const st = await api.states(mailbox, ids.slice(i, i + 100));
        for (const [id, s] of Object.entries(st)) if (s.version > 0) seen.add(id);
      }
      if (live) setTracked(seen);
    }).catch(e => live && setErr(errorText(e)));
    return () => { live = false; };
  }, [api, mailbox, providerFor, from, to, days]);

  if (!api || !providerFor) return <div className="card panel"><span className="muted">Team analytics need the Axal VC Mail backend.</span></div>;
  if (!mailboxes.length) {
    return (
      <div className="card panel"><span className="muted">
        Team analytics cover shared mailboxes you can open in Shared Inboxes, and you don’t have access to one. A super admin grants it in Administration → Members &amp; access.
      </span></div>
    );
  }

  const m = mailboxes.find(x => x.mailbox === mailbox);
  const name = (e: string) => m?.members.find(x => x.email === e)?.name || e;
  const stats = convs ? computeStats(convs, { now: to, days, orgDomain, from, to }) : null;
  // Conversations in the period from people that nobody has triaged yet count as open and unassigned.
  const untouched = convs && tracked ? convs.filter(c => !tracked.has(c.id) && c.messages.some(x => !x.fromMe && !x.automated && x.at >= from && x.at <= to)).length : null;

  const exportCsv = () => sum && downloadCsv('team-' + mailbox + '.csv', toCsv([
    ['Mailbox', mailbox], ['Open (tracked)', sum.byStatus.open], ['Pending', sum.byStatus.pending], ['Resolved', sum.byStatus.resolved],
    ['Unassigned (tracked, not resolved)', sum.unassignedTracked], ['Not triaged yet', untouched ?? ''],
    ['Median time to first response (h)', stats?.firstResponseMs == null ? '' : (stats.firstResponseMs / 3_600_000).toFixed(2)],
    [],
    ['Member', 'Open', 'Pending', 'Resolved', 'Replies sent in period', 'Conversations claimed in period'],
    ...sum.workload.map(w => [name(w.email), w.open, w.pending, w.resolved, w.replies, w.assignmentsTaken])
  ]));

  return (
    <>
      <div className="card panel">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>Shared mailbox
            <select className="input sm" value={mailbox} onChange={e => setMailbox(e.target.value)}>
              {mailboxes.map(x => <option key={x.mailbox} value={x.mailbox}>{x.mailbox}</option>)}
            </select>
          </label>
          <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={exportCsv} disabled={!sum}>Export CSV</button>
        </div>
        {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
        {!sum && !err && <div className="an-loading"><div className="spinner" /> Loading…</div>}
        {sum && (
          <div className="an-tiles">
            <Tile label="Open" value={sum.byStatus.open} note="tracked conversations, now" />
            <Tile label="Pending" value={sum.byStatus.pending} note="now" />
            <Tile label="Resolved" value={sum.byStatus.resolved} note="now" />
            <Tile label="Unassigned" value={sum.unassignedTracked} note="tracked, not resolved" help="Conversations someone set a status on, with no assignee." />
            <Tile label="Not triaged yet" value={untouched ?? '…'} note="from people, in the period" help="Conversations in the period with a message from a person and no team status or assignee yet." />
            <Tile label="Time to first response" value={stats?.firstResponseMs == null ? (stats ? '—' : '…') : duration(stats.firstResponseMs)}
              note={stats ? 'median of ' + stats.firstResponseCount : ''} help="In conversations someone else started in the period, from their first message to the mailbox’s first reply." />
          </div>
        )}
      </div>

      {sum && (
        <div className="card table table-scroll" aria-label="Workload">
          <div className="trow team head"><span>MEMBER</span><span>OPEN</span><span>PENDING</span><span>RESOLVED</span><span>REPLIES</span><span>CLAIMED</span></div>
          {sum.workload.map(w => (
            <div key={w.email} className="trow team">
              <span className="user-cell"><b>{name(w.email)}</b><span>{w.email}</span></span>
              <span className="mono">{w.open}</span><span className="mono">{w.pending}</span><span className="mono">{w.resolved}</span>
              <span className="mono">{w.replies}</span><span className="mono">{w.assignmentsTaken}</span>
            </div>
          ))}
          <div className="trow team"><span className="faint" style={{ gridColumn: '1 / -1', fontSize: 11.5 }}>
            Listed alphabetically. Open, pending and resolved are what each person holds now; replies and claims are in the period. Workload depends on what each person handles, so this is not a performance score.
          </span></div>
        </div>
      )}

      <div className="card panel an-limits">
        <span className="mono-label">Tasks &amp; approvals</span>
        <span className="muted">Tasks and approval requests are in Tasks &amp; Approvals. Outreach waiting for approval is under Outreach.</span>
      </div>
    </>
  );
}

function Tile({ label, value, note, help }: { label: string; value: number | string; note: string; help?: string }) {
  return (
    <div className="card an-tile" title={help}>
      <span className="an-tile-label">{label}{help && <span className="faint" aria-hidden> ⓘ</span>}</span>
      <b className="an-tile-value">{value}</b>
      <span className="an-tile-note">{note}</span>
      {help && <span className="sr-only">{help}</span>}
    </div>
  );
}
