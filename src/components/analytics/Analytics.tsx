import { useEffect, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import { ago, duration, hourLabel, insights, type WaitingItem } from '../../lib/analytics';
import { Columns } from './Charts';
import { useStats } from './useStats';

export interface DnsCheck { key: string; label: string; level: 'good' | 'warning' | 'critical'; summary: string; record?: string; advice?: string }
export type Deliverability = () => Promise<{ domain: string; checkedAt: number; checks: DnsCheck[] }>;

interface Props {
  provider: MailProvider;
  orgDomain: string;
  deliverability?: Deliverability | null;
  onOpen: (threadId: string) => void;
}

const PERIODS = [7, 30, 90];
const pct = (x: number | null) => (x == null ? '—' : Math.round(x * 100) + '%');

export function Analytics({ provider, orgDomain, deliverability, onOpen }: Props) {
  const [days, setDays] = useState(30);
  const { stats: s, truncated, loading, error, reload } = useStats(provider, days, orgDomain);
  const now = Date.now();

  return (
    <section className="admin analytics" aria-label="Analytics">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title an-head">
          <div>
            <span className="mono-label">Workspace</span>
            <h1>Analytics</h1>
            <span className="muted">Computed in your browser from who wrote to whom and when. Message content is not read and nothing is stored.</span>
          </div>
          <div className="row-wrap" role="group" aria-label="Period">
            {PERIODS.map(d => (
              <button key={d} className={'btn sm' + (d === days ? ' primary' : '')} aria-pressed={d === days} onClick={() => setDays(d)}>{d} days</button>
            ))}
            <button className="btn sm ghost" onClick={reload} disabled={loading} aria-label="Refresh">↻</button>
          </div>
        </div>

        {error && <div className="card panel"><span className="tone-danger">Couldn’t load your mailbox: {error}</span><button className="btn sm" onClick={reload}>Try again</button></div>}
        {loading && !s && <div className="card panel an-loading"><div className="spinner" /> Reading the last {days} days of conversations…</div>}

        {s && (
          <>
            {truncated && <div className="notice warn">Based on your {s.conversations} most recent conversations; older ones in the period aren’t counted.</div>}

            <div className="card panel">
              <span className="mono-label">Overview</span>
              <ul className="an-insights">
                {insights(s).map((t, i) => <li key={i}>{t}</li>)}
                {!insights(s).length && <li className="muted">Not enough activity in this period for observations yet.</li>}
              </ul>
            </div>

            <div className="an-tiles">
              <Tile label="Conversations" value={String(s.conversations)} note={'active in the last ' + days + ' days'} />
              <Tile label="Sent" value={String(s.sent)} note={pct(s.internalShare) + ' internal only'} />
              <Tile label="Received from people" value={String(s.received)} note={s.receivedAutomated + ' bulk / automated not counted'} />
              <Tile label="Your response time" value={s.myResponseMs == null ? '—' : duration(s.myResponseMs)} note={'median of ' + s.myResponseCount + ' replies'}
                help="From an incoming message to your next message in the same conversation." />
              <Tile label="Their response time" value={s.theirResponseMs == null ? '—' : duration(s.theirResponseMs)} note={'median of ' + s.theirResponseCount + ' replies'}
                help="From your message to the next message from someone else in the conversation." />
              <Tile label="Message reply rate" value={pct(s.messageReplyRate)} note={'of ' + s.messageReplyBase + ' messages older than a day'}
                help="Your messages followed by someone else’s message in the same conversation." />
              <Tile label="Contact reply rate" value={pct(s.contactReplyRate)} note={s.contactsReplied + ' of ' + s.contactsWritten + ' people wrote back'}
                help="People you wrote to who wrote back in a conversation with you during the period." />
            </div>

            <div className="an-grid">
              <div className="card panel">
                <span className="mono-label">Sent per day</span>
                <Columns ariaLabel={'Messages you sent per day, last ' + days + ' days'}
                  bars={s.sentByDay.map(d => ({ key: d.day, label: d.label, value: d.count, tip: d.label + ': ' + d.count + ' sent' }))} />
              </div>
              <div className="card panel">
                <span className="mono-label">Received from people per day</span>
                <Columns ariaLabel={'Messages received from people per day, last ' + days + ' days'}
                  bars={s.receivedByDay.map(d => ({ key: d.day, label: d.label, value: d.count, tip: d.label + ': ' + d.count + ' received' }))} />
              </div>
            </div>

            <div className="an-grid">
              <WaitingList title="Waiting on you" empty="Nobody is waiting on a reply from you." items={s.waitingOnYou} now={now} onOpen={onOpen}
                note="A person wrote last and you haven’t answered. Bulk mail is excluded." />
              <WaitingList title="Waiting on others" empty="No conversation has waited more than 3 days on someone else." items={s.waitingOnOthers} now={now} onOpen={onOpen}
                note="You wrote last, more than 3 days ago." />
            </div>

            <div className="an-grid">
              <div className="card panel">
                <span className="mono-label">When you send (hour of day)</span>
                <Columns ariaLabel="Messages you sent by hour of day" labelEvery={3}
                  bars={s.sentByHour.map((v, h) => ({ key: h, label: hourLabel(h), value: v, tip: hourLabel(h) + ': ' + v + ' sent' }))} />
              </div>
              <div className="card table">
                <div className="trow contacts head"><span>TOP CONTACTS</span><span>SENT</span><span>RECEIVED</span><span>LAST</span></div>
                {s.topContacts.map(c => (
                  <div key={c.email} className="trow contacts">
                    <span className="user-cell"><b>{c.name}</b><span>{c.email}</span></span>
                    <span className="mono">{c.sent}</span><span className="mono">{c.received}</span><span className="muted">{ago(c.last, now)}</span>
                  </div>
                ))}
                {!s.topContacts.length && <div className="trow contacts"><span className="muted">No conversations in this period.</span></div>}
              </div>
            </div>
          </>
        )}

        {deliverability && <DeliverabilityCard load={deliverability} />}

        <div className="card panel an-limits">
          <span className="mono-label">Not measured</span>
          <span className="muted">Opens, link clicks, bounces and inbox placement aren’t visible from a mailbox. Measuring them needs tracking pixels or tracked links, which are unreliable (privacy proxies and security scanners trigger them) and need recipients’ consent, so they are left out for investor correspondence.</span>
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, note, help }: { label: string; value: string; note: string; help?: string }) {
  return (
    <div className="card an-tile" title={help}>
      <span className="an-tile-label">{label}{help && <span className="faint" aria-hidden> ⓘ</span>}</span>
      <b className="an-tile-value">{value}</b>
      <span className="an-tile-note">{note}</span>
      {help && <span className="sr-only">{help}</span>}
    </div>
  );
}

function WaitingList({ title, note, empty, items, now, onOpen }: { title: string; note: string; empty: string; items: WaitingItem[]; now: number; onOpen: (id: string) => void }) {
  return (
    <div className="card panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="mono-label">{title}</span><b className="mono" style={{ fontSize: 12 }}>{items.length}</b>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>{note}</span>
      <div className="an-list">
        {items.slice(0, 8).map(w => (
          <button key={w.id} className="an-row" onClick={() => onOpen(w.id)}>
            <span className="an-row-main"><b>{w.subject}</b><span>{w.who}</span></span>
            <span className="muted">{ago(w.since, now)}</span>
          </button>
        ))}
        {!items.length && <span className="faint" style={{ fontSize: 12.5 }}>{empty}</span>}
        {items.length > 8 && <span className="faint" style={{ fontSize: 12 }}>and {items.length - 8} more</span>}
      </div>
    </div>
  );
}

const LEVEL = { good: { icon: '✓', text: 'OK', cls: 'ok' }, warning: { icon: '!', text: 'Review', cls: 'warn' }, critical: { icon: '×', text: 'Fix', cls: 'danger' } } as const;

function DeliverabilityCard({ load }: { load: Deliverability }) {
  const [r, setR] = useState<Awaited<ReturnType<Deliverability>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { load().then(setR).catch(e => setError(e instanceof Error ? e.message : String(e))); }, [load]);
  return (
    <div className="card panel">
      <span className="mono-label">Deliverability{r ? ' · ' + r.domain : ''}</span>
      <span className="muted" style={{ fontSize: 12 }}>Sender authentication published in DNS. It shows what’s configured, not whether every message passes or where it lands.</span>
      {error && <span className="tone-danger">{error}</span>}
      {!r && !error && <span className="faint">Checking DNS…</span>}
      {r?.checks.map(c => (
        <div key={c.key} className="an-check">
          <span className={'pill ' + LEVEL[c.level].cls} style={{ border: 0, minWidth: 64, justifyContent: 'center' }}>{LEVEL[c.level].icon} {LEVEL[c.level].text}</span>
          <div className="an-check-main">
            <b>{c.label}</b>
            <span>{c.summary}</span>
            {c.advice && <span className="muted">{c.advice}</span>}
            {c.record && <code className="an-record">{c.record}</code>}
          </div>
        </div>
      ))}
    </div>
  );
}
