import { useEffect, useMemo, useRef, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { ConversationSample } from '../../types';
import type { SharedApi, SharedMailbox } from '../../lib/sharedApi';
import { ago, computeStats, duration, hourLabel, insights, statsCsv, type MailboxStats, type WaitingItem } from '../../lib/analytics';
import { Columns, HBars, PairedColumns } from './Charts';
import { sample } from './useStats';
import { downloadCsv } from './csv';
import { Outreach, type OutreachLoader } from './Outreach';
import { Team } from './Team';

export interface DnsCheck { key: string; label: string; level: 'good' | 'warning' | 'critical'; summary: string; record?: string; advice?: string }
export type Deliverability = () => Promise<{ domain: string; checkedAt: number; checks: DnsCheck[] }>;

interface Props {
  provider: MailProvider;
  orgDomain: string;
  deliverability?: Deliverability | null;
  onOpen: (threadId: string) => void;
  /** Shared mailboxes the member can open: for the mailbox filter and Team. */
  shared?: SharedApi | null;
  providerFor?: (mailbox: string) => MailProvider;
  outreach?: OutreachLoader | null;
}

const DAY = 86_400_000;
const PERIODS = [7, 30, 90];
/** Gmail search reaches back as far as you like, but the sample is capped, so custom ranges stop at 180 days. */
export const MAX_DAYS = 180;
const pct = (x: number | null) => (x == null ? '—' : Math.round(x * 100) + '%');
const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isoDay = (t: number) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1).getTime(); };

type Tab = 'communication' | 'outreach' | 'team';

export function Analytics({ provider, orgDomain, deliverability, onOpen, shared, providerFor, outreach }: Props) {
  const [now] = useState(() => Date.now());
  const [period, setPeriod] = useState<number | 'custom'>(30);
  const [custom, setCustom] = useState({ from: isoDay(now - 29 * DAY), to: isoDay(now) });
  const [tab, setTab] = useState<Tab>('communication');
  const [nonce, setNonce] = useState(0);
  const [sharedBoxes, setSharedBoxes] = useState<SharedMailbox[]>([]);
  const [current, setCurrent] = useState(provider.mailbox || '');
  const [sel, setSel] = useState<string>('current');

  useEffect(() => { if (!provider.mailbox) provider.account().then(a => setCurrent(a.email)).catch(() => {}); }, [provider]);
  useEffect(() => {
    if (!shared) return;
    shared.mailboxes().then(r => setSharedBoxes(r.mailboxes.filter(m => m.connection.ok))).catch(() => setSharedBoxes([]));
  }, [shared]);

  // One provider per mailbox, so samples are cached and effects don't loop.
  // (The parent hands a new providerFor on each render, so it is read through a ref.)
  const cache = useRef(new Map<string, MailProvider>());
  const makeRef = useRef(providerFor);
  makeRef.current = providerFor;
  const canShare = !!providerFor;
  const providerOf = useMemo(() => (canShare ? (m: string) => {
    if (m === provider.mailbox) return provider;
    let p = cache.current.get(m);
    if (!p) cache.current.set(m, p = makeRef.current!(m));
    return p;
  } : null), [canShare, provider]);

  // The window: a preset ends now; a custom range runs from the first day's midnight to the end of the last day.
  const range = useMemo(() => {
    if (period !== 'custom') return { from: midnight(now - (period - 1) * DAY), to: now, error: '' };
    const f = parseDay(custom.from), t = Math.min(now, parseDay(custom.to) + DAY - 1);
    if (!custom.from || !custom.to || f > t) return { from: 0, to: 0, error: 'Pick a start date before the end date.' };
    if (now - f > MAX_DAYS * DAY) return { from: 0, to: 0, error: 'Ranges reach back at most ' + MAX_DAYS + ' days.' };
    return { from: f, to: t, error: '' };
  }, [period, custom, now]);
  const fetchDays = range.error ? 0 : Math.ceil((now - range.from) / DAY) + 1;

  const others = useMemo(() => sharedBoxes.filter(m => m.mailbox !== provider.mailbox), [sharedBoxes, provider.mailbox]);
  const targets = useMemo(() => {
    const own = { label: current || 'This mailbox', provider };
    if (sel === 'current' || !providerOf) return [own];
    if (sel === 'all') return [own, ...others.map(m => ({ label: m.mailbox, provider: providerOf(m.mailbox) }))];
    return [{ label: sel, provider: providerOf(sel) }];
  }, [sel, current, provider, providerOf, others]);

  const [data, setData] = useState<{ samples: { label: string; s: ConversationSample }[]; errors: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!fetchDays) return;
    let live = true;
    setLoading(true);
    Promise.allSettled(targets.map(t => sample(t.provider, fetchDays, nonce > 0))).then(rs => {
      if (!live) return;
      setData({
        samples: rs.flatMap((r, i) => (r.status === 'fulfilled' ? [{ label: targets[i].label, s: r.value }] : [])),
        errors: rs.flatMap((r, i) => (r.status === 'rejected' ? [targets[i].label + ': ' + (r.reason instanceof Error ? r.reason.message : String(r.reason))] : []))
      });
      setLoading(false);
    });
    return () => { live = false; };
  }, [targets, fetchDays, nonce]);

  const opts = { now, days: fetchDays, orgDomain, from: range.from, to: range.to };
  const s = data && data.samples.length && !range.error ? computeStats(data.samples.flatMap(x => x.s.conversations), opts) : null;
  const perMailbox = data && data.samples.length > 1 && !range.error ? data.samples.map(x => ({ label: x.label, st: computeStats(x.s.conversations, opts) })) : null;
  const truncated = !!data?.samples.some(x => x.s.truncated);
  const mailboxLabel = sel === 'current' ? current : sel === 'all' ? 'All mailboxes' : sel;

  return (
    <section className="admin analytics" aria-label="Analytics">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title an-head">
          <div>
            <span className="mono-label">Workspace</span>
            <h1>Analytics</h1>
            <span className="muted">Mail figures are computed in your browser from who wrote to whom and when. Message content is not read and nothing is stored.</span>
          </div>
        </div>

        <div className="an-controls" aria-label="Analytics filters">
          <div className="row-wrap" role="group" aria-label="Period">
            {PERIODS.map(d => (
              <button key={d} className={'btn sm' + (d === period ? ' primary' : '')} aria-pressed={d === period} onClick={() => setPeriod(d)}>{d} days</button>
            ))}
            <button className={'btn sm' + (period === 'custom' ? ' primary' : '')} aria-pressed={period === 'custom'} onClick={() => setPeriod('custom')}>Custom</button>
          </div>
          {period === 'custom' && (
            <span className="row-wrap" style={{ alignItems: 'center' }}>
              <input className="input sm" type="date" aria-label="From" value={custom.from} min={isoDay(now - (MAX_DAYS - 1) * DAY)} max={isoDay(now)} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
              <span className="muted">to</span>
              <input className="input sm" type="date" aria-label="To" value={custom.to} min={isoDay(now - (MAX_DAYS - 1) * DAY)} max={isoDay(now)} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
            </span>
          )}
          {!!others.length && providerOf && (
            <select className="input sm" aria-label="Mailbox" value={sel} onChange={e => setSel(e.target.value)}>
              <option value="current">{current || 'This mailbox'}</option>
              {others.map(m => <option key={m.mailbox} value={m.mailbox}>{m.mailbox}</option>)}
              <option value="all">All mailboxes</option>
            </select>
          )}
          <button className="btn sm ghost" onClick={() => setNonce(n => n + 1)} disabled={loading} aria-label="Refresh">↻</button>
          {tab === 'communication' && <button className="btn sm ghost" disabled={!s} onClick={() => s && downloadCsv('analytics.csv', statsCsv(s, mailboxLabel))}>Export CSV</button>}
        </div>

        <div className="an-tabs" role="tablist" aria-label="Analytics sections">
          {([['communication', 'Communication'], ['outreach', 'Outreach'], ['team', 'Team']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={'btn sm' + (tab === k ? ' primary' : ' ghost')} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {range.error && <div className="notice warn" role="alert">{range.error}</div>}
        {data?.errors.map(e => <div key={e} className="card panel"><span className="tone-danger">Couldn’t read {e}</span><button className="btn sm" onClick={() => setNonce(n => n + 1)}>Try again</button></div>)}

        {tab === 'communication' && !range.error && (
          <>
            {loading && !s && <div className="card panel an-loading"><div className="spinner" /> Reading conversations…</div>}
            {s && <Communication s={s} perMailbox={perMailbox} truncated={truncated} now={now} onOpen={sel === 'current' ? onOpen : null} />}
            {deliverability && <DeliverabilityCard load={deliverability} />}
          </>
        )}
        {tab === 'outreach' && !range.error && <Outreach load={outreach} from={range.from} to={range.to} provider={provider} days={fetchDays} />}
        {tab === 'team' && !range.error && (
          <Team api={shared || null} mailboxes={sharedBoxes} providerFor={providerOf} initial={sel !== 'current' && sel !== 'all' ? sel : provider.mailbox}
            from={range.from} to={range.to} days={fetchDays} orgDomain={orgDomain} />
        )}
      </div>
    </section>
  );
}

function Communication({ s, perMailbox, truncated, now, onOpen }: {
  s: MailboxStats; perMailbox: { label: string; st: MailboxStats }[] | null; truncated: boolean; now: number; onOpen: ((id: string) => void) | null;
}) {
  const range = new Date(s.from).toLocaleDateString() + ' – ' + new Date(s.to).toLocaleDateString();
  const empty = !s.conversations;
  return (
    <>
      {truncated && <div className="notice warn">Based on the most recent conversations only (the sample is capped); older ones in the period aren’t counted.</div>}
      {(s.duplicates > 0 || s.missingTime > 0) && (
        <span className="faint" style={{ fontSize: 11.5 }}>
          {s.duplicates > 0 && s.duplicates + ' message' + (s.duplicates === 1 ? '' : 's') + ' seen in more than one place counted once. '}
          {s.missingTime > 0 && s.missingTime + ' message' + (s.missingTime === 1 ? '' : 's') + ' without a date left out.'}
        </span>
      )}

      {empty ? (
        <div className="card panel"><span className="muted">No conversations between {range}. Try a longer period or another mailbox.</span></div>
      ) : (
        <>
          <div className="card panel">
            <span className="mono-label">Overview · {range}</span>
            <ul className="an-insights">
              {insights(s).map((t, i) => <li key={i}>{t}</li>)}
              {!insights(s).length && <li className="muted">Not enough activity in this period for observations yet.</li>}
            </ul>
          </div>

          <div className="an-tiles">
            <Tile label="Conversations" value={String(s.conversations)} note={'active in ' + s.days + ' days'} />
            <Tile label="Sent (outbound)" value={String(s.sent)} note={pct(s.internalShare) + ' internal only'} />
            <Tile label="Received from people (inbound)" value={String(s.received)} note={s.receivedAutomated + ' bulk / automated not counted'} />
            <Tile label="Time to first response" value={s.firstResponseMs == null ? '—' : duration(s.firstResponseMs)} note={'median of ' + s.firstResponseCount + ' conversations'}
              help="In conversations someone else started in the period: from their first message to your first message." />
            <Tile label="Your response time" value={s.myResponseMs == null ? '—' : duration(s.myResponseMs)} note={'median of ' + s.myResponseCount + ' replies'}
              help="Time between replies: from each incoming message to your next message in the same conversation." />
            <Tile label="Their response time" value={s.theirResponseMs == null ? '—' : duration(s.theirResponseMs)} note={'median of ' + s.theirResponseCount + ' replies'}
              help="From your message to the next message from someone else in the conversation." />
            <Tile label="Message reply rate" value={pct(s.messageReplyRate)} note={'of ' + s.messageReplyBase + ' messages older than a day'}
              help="Your messages followed by someone else’s message in the same conversation." />
            <Tile label="Contact reply rate" value={pct(s.contactReplyRate)} note={s.contactsReplied + ' of ' + s.contactsWritten + ' people wrote back'}
              help="People you wrote to who wrote back in a conversation with you during the period." />
            <Tile label="Unanswered" value={String(s.waitingOnYou.length)} note="a person wrote last"
              help="Conversations where a person wrote last and nobody answered. Not every message needs a reply, so this is not a count of missed commitments." />
          </div>

          {perMailbox && (
            <div className="card table table-scroll" aria-label="Volume by mailbox">
              <div className="trow mailboxes head"><span>MAILBOX</span><span>CONVERSATIONS</span><span>SENT</span><span>RECEIVED</span><span>UNANSWERED</span><span>FIRST RESPONSE</span></div>
              {perMailbox.map(m => (
                <div key={m.label} className="trow mailboxes">
                  <b>{m.label}</b><span className="mono">{m.st.conversations}</span><span className="mono">{m.st.sent}</span><span className="mono">{m.st.received}</span>
                  <span className="mono">{m.st.waitingOnYou.length}</span><span className="mono">{m.st.firstResponseMs == null ? '—' : duration(m.st.firstResponseMs)}</span>
                </div>
              ))}
              <div className="trow mailboxes"><span className="faint" style={{ gridColumn: '1 / -1', fontSize: 11.5 }}>A message between two of these mailboxes is counted once in the totals above and in each mailbox here.</span></div>
            </div>
          )}

          <div className="an-grid">
            <div className="card panel">
              <span className="mono-label">Sent per day</span>
              <Columns ariaLabel={'Messages you sent per day, ' + range}
                bars={s.sentByDay.map(d => ({ key: d.day, label: d.label, value: d.count, tip: d.label + ': ' + d.count + ' sent' }))} />
            </div>
            <div className="card panel">
              <span className="mono-label">Received from people per day</span>
              <Columns ariaLabel={'Messages received from people per day, ' + range}
                bars={s.receivedByDay.map(d => ({ key: d.day, label: d.label, value: d.count, tip: d.label + ': ' + d.count + ' received' }))} />
            </div>
          </div>

          <div className="an-grid">
            <div className="card panel">
              <span className="mono-label">Inbound and outbound per week</span>
              <PairedColumns names={['Sent', 'Received from people']} ariaLabel={'Sent and received per week, ' + range}
                bars={s.sentByWeek.map((w, i) => ({ key: w.day, label: w.label.replace('Week of ', ''), a: w.count, b: s.receivedByWeek[i].count, tip: w.label + ': ' + w.count + ' sent, ' + s.receivedByWeek[i].count + ' received' }))} />
            </div>
            <div className="card panel">
              <span className="mono-label">Active conversations per week</span>
              <Columns ariaLabel={'Conversations with a message each week, ' + range}
                bars={s.activeByWeek.map(w => ({ key: w.day, label: w.label.replace('Week of ', ''), value: w.count, tip: w.label + ': ' + w.count + ' conversations' }))} />
            </div>
          </div>

          <div className="an-grid">
            <div className="card panel">
              <span className="mono-label">Time to first response</span>
              <span className="muted" style={{ fontSize: 12 }}>Conversations someone else started, by how long the first answer took.</span>
              <HBars ariaLabel="Time to first response distribution" rows={s.firstResponseDist} />
            </div>
            <div className="card panel">
              <span className="mono-label">Time between replies</span>
              <span className="muted" style={{ fontSize: 12 }}>Every reply you sent, by how long after the message it answered.</span>
              <HBars ariaLabel="Your response time distribution" rows={s.replyDist} />
            </div>
          </div>

          <div className="an-grid">
            <WaitingList title="Waiting on you" empty="Nobody is waiting on a reply from you." items={s.waitingOnYou} now={now} onOpen={onOpen}
              note="A person wrote last and nobody answered. Bulk mail is excluded." />
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
            </div>
          </div>
        </>
      )}

      <details className="card panel an-limits">
        <summary className="mono-label" style={{ cursor: 'pointer' }}>How these are measured</summary>
        <ul className="an-insights" style={{ fontSize: 12.5 }}>
          <li><b>Sent / received:</b> messages in the period from you (any of your send-as addresses) and from people. Bulk and automated mail (list headers, no-reply senders) is counted apart.</li>
          <li><b>Time to first response:</b> in a conversation someone else started in the period, from their first message to your first message after it.</li>
          <li><b>Your response time:</b> time between replies: from each incoming message to your next message in the conversation. A run of messages from them counts once.</li>
          <li><b>Their response time:</b> from your message to the next message from someone else.</li>
          <li><b>Message reply rate:</b> your messages older than a day that someone answered in the same conversation.</li>
          <li><b>Unanswered:</b> a person wrote last and nobody answered. Many messages need no reply; this is not a list of missed commitments.</li>
          <li><b>Days and weeks</b> are in your browser’s time zone; weeks start on Monday. A message seen twice (same Message-ID, for example in two mailboxes) counts once.</li>
          <li><b>Mailboxes:</b> only mailboxes you can open are offered; shared ones are read through the same checked access as in the mail view.</li>
        </ul>
      </details>
    </>
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

function WaitingList({ title, note, empty, items, now, onOpen }: { title: string; note: string; empty: string; items: WaitingItem[]; now: number; onOpen: ((id: string) => void) | null }) {
  return (
    <div className="card panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="mono-label">{title}</span><b className="mono" style={{ fontSize: 12 }}>{items.length}</b>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>{note}</span>
      <div className="an-list">
        {items.slice(0, 8).map(w => (
          <button key={w.id + ":" + w.since} className="an-row" onClick={() => onOpen?.(w.id)} disabled={!onOpen} title={onOpen ? undefined : 'Switch to that mailbox to open it'}>
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
