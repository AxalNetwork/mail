import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { ThreadSummary } from '../../types';
import type { Assistant, Briefing, Classification, TriageItem } from '../../assistant/types';
import { ago, type WaitingItem } from '../../lib/analytics';
import { waitingKey, type DismissalStore, type DismissKind, type Dismissed } from '../../lib/automationsApi';
import { useStats } from '../analytics/useStats';
import { errorText } from '../Toast';

interface Props {
  provider: MailProvider;
  orgDomain: string;
  assistant: Assistant;
  dismissals: DismissalStore;
  onOpen: (threadId: string) => void;
  /** Opens a reply to the conversation with an assistant draft. */
  onDraftReply: (threadId: string) => void;
  onGo: (view: 'analytics' | 'sequences') => void;
}

const DAY = 86_400_000;
/** How many of the latest inbox conversations the inbox manager and briefing read. */
const TRIAGE_COUNT = 20;
/** Labels the inbox manager writes live under this parent, so they are easy to find and remove. */
export const LABEL_PREFIX = 'AI/';

type Status = 'Operational' | 'Partial' | 'Needs setup' | 'Blocked' | 'Planned' | 'Off';
const TONE: Record<Status, string> = { Operational: 'ok', Partial: 'warn', 'Needs setup': 'warn', Blocked: 'danger', Planned: '', Off: '' };

function audit(live: boolean): { name: string; status: Status; note: string }[] {
  const ai = 'needs the assistant (ANTHROPIC_API_KEY on the Worker)';
  return [
    { name: 'Daily briefing', status: live ? 'Operational' : 'Partial', note: live ? 'Counts from your mailbox, plus an AI summary with linked priorities on request.' : 'Counts work; the written summary ' + ai + '.' },
    { name: 'Intelligent inbox manager', status: live ? 'Operational' : 'Needs setup', note: (live ? 'Suggests a category, priority and action items' : 'Suggestions ' + ai) + '. Labels change only after you confirm each one.' },
    { name: 'Reply assistant', status: live ? 'Operational' : 'Partial', note: live ? 'Drafts from the conversation; you review and send.' : 'Drafts start from templates until the assistant is connected.' },
    { name: 'Follow-up agent', status: 'Operational', note: 'Finds conversations where you wrote last more than 3 days ago. Dismissed ones stay hidden until the conversation moves on.' },
    { name: 'Investor outreach sequences', status: 'Operational', note: 'Admin approval, then server sends from your Gmail once you connect sending. Replies and unsubscribes stop them.' },
    { name: 'Security & deliverability monitoring', status: 'Operational', note: 'SPF, DKIM, DMARC and MX checks in Analytics.' },
    { name: 'Email-to-CRM', status: 'Blocked', note: 'Waits on Contacts (issue #5): there is no contact store to write people, companies and next steps to.' },
    { name: 'Meeting scheduling agent', status: 'Planned', note: 'Needs Google Calendar access, a new permission every member would grant.' },
    { name: 'Support agent', status: 'Planned', note: 'Needs a shared support inbox (issue #6) and an approved answer base.' },
    { name: 'Document processing', status: 'Planned', note: 'Needs Documents (issue #7) and confidentiality rules per document.' },
    { name: 'Automatic sending', status: 'Off', note: 'Off by design. Every automation prepares work for you; an email can never authorize a send by itself.' }
  ];
}

const toItem = (t: ThreadSummary): TriageItem => ({ id: t.id, subject: t.subject, from: t.from, email: t.email, snippet: t.snippet, labels: t.labels, when: t.time });
const triageKey = (t: ThreadSummary) => t.id + ':' + (t.date || t.time);

export function Automations({ provider, orgDomain, assistant, dismissals, onOpen, onDraftReply, onGo }: Props) {
  const { stats: s, loading, error, reload } = useStats(provider, 30, orgDomain);
  const now = Date.now();
  const [dismissed, setDismissed] = useState<Dismissed>({ follow_up: [], reply: [], triage: [] });
  const [dismissError, setDismissError] = useState('');

  useEffect(() => {
    let live = true;
    dismissals.load().then(d => { if (live) setDismissed(d); }).catch(e => { if (live) setDismissError(errorText(e)); });
    return () => { live = false; };
  }, [dismissals]);

  const dismiss = useCallback((kind: DismissKind, key: string) => {
    setDismissed(d => ({ ...d, [kind]: [...d[kind], key] }));
    dismissals.dismiss(kind, key).catch(e => {
      setDismissed(d => ({ ...d, [kind]: d[kind].filter(k => k !== key) }));
      setDismissError(errorText(e));
    });
  }, [dismissals]);

  const visible = (kind: DismissKind, list: WaitingItem[]) => list.filter(w => !dismissed[kind].includes(waitingKey(w.id, w.since)));
  const followUps = s ? visible('follow_up', s.waitingOnOthers) : [];
  const replies = s ? visible('reply', s.waitingOnYou) : [];
  const today = replies.filter(w => now - w.since < DAY);

  return (
    <section className="admin" aria-label="AI automations">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>AI Automations</h1>
          <span className="muted">
            Automations prepare work for you to approve; nothing is sent on its own.
            {assistant.live ? ' Suggestions and drafts come from the assistant.' : ' The assistant isn’t connected yet, so drafts start from templates and AI suggestions are off.'}
          </span>
        </div>

        {error && <div className="card panel"><span className="tone-danger">Couldn’t load your mailbox: {error}</span><button className="btn sm" onClick={reload}>Try again</button></div>}
        {dismissError && <div className="notice warn" role="alert">Couldn’t save a dismissal: {dismissError}</div>}
        {loading && !s && <div className="card panel an-loading"><div className="spinner" /> Looking through the last 30 days…</div>}

        {s && (
          <>
            <div className="card panel">
              <Head name="Daily briefing" status={assistant.live ? 'Operational' : 'Partial'} />
              <span className="muted" style={{ fontSize: 12.5 }}>Last 24 hours, from people (bulk mail left out).</span>
              <div className="an-tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <Mini label="New, waiting on you" value={today.length} />
                <Mini label="Waiting on you, total" value={replies.length} />
                <Mini label="Follow-ups due" value={followUps.length} />
              </div>
              <AiBriefing provider={provider} assistant={assistant} followUps={followUps.length} onOpen={onOpen} />
            </div>

            <InboxManager provider={provider} assistant={assistant} dismissed={dismissed.triage} onDismiss={k => dismiss('triage', k)}
              onOpen={onOpen} onDraftReply={onDraftReply} />

            <div className="card panel">
              <Head name="Follow-up agent" status="Operational" />
              <span className="muted" style={{ fontSize: 12.5 }}>Conversations where you wrote last, more than 3 days ago. Draft a follow-up, review it, send it yourself. A dismissed one comes back only if the conversation moves on.</span>
              <Rows items={followUps.slice(0, 10)} empty="No follow-ups due." onOpen={onOpen}
                reason={w => 'You wrote last, ' + ago(w.since, now) + '; no reply from ' + w.who + '.'}
                action={{ label: 'Draft follow-up', run: onDraftReply }} onDismiss={w => dismiss('follow_up', waitingKey(w.id, w.since))} />
            </div>

            <div className="card panel">
              <Head name="Reply assistant" status={assistant.live ? 'Operational' : 'Partial'} />
              <span className="muted" style={{ fontSize: 12.5 }}>People waiting on an answer, oldest first. Each draft uses the conversation and your signature.</span>
              <Rows items={replies.slice(0, 10)} empty="Nobody is waiting on you." onOpen={onOpen}
                reason={w => w.who + ' wrote last, ' + ago(w.since, now) + '.'}
                action={{ label: 'Draft reply', run: onDraftReply }} onDismiss={w => dismiss('reply', waitingKey(w.id, w.since))} />
            </div>

            <div className="card panel">
              <Head name="Investor outreach sequences" status="Operational" />
              <span className="muted" style={{ fontSize: 12.5 }}>A first email and timed follow-ups, approved by an admin, sent by the server from your Gmail. Replies and unsubscribes stop them.</span>
              <div><button className="btn sm" onClick={() => onGo('sequences')}>Open sequences</button></div>
            </div>

            <div className="card panel">
              <Head name="Security & deliverability monitoring" status="Operational" />
              <span className="muted" style={{ fontSize: 12.5 }}>SPF, DKIM, DMARC and MX checks for {orgDomain || 'your domain'}.</span>
              <div><button className="btn sm" onClick={() => onGo('analytics')}>Open in Analytics</button></div>
            </div>
          </>
        )}

        <div className="card table" aria-label="Automation status">
          <div className="trow plans head"><span>AUTOMATION</span><span>STATUS</span><span>NOTES</span></div>
          {audit(assistant.live).map(p => (
            <div key={p.name} className="trow plans">
              <b>{p.name}</b><span><span className={'pill ' + TONE[p.status]}>{p.status}</span></span><span className="muted">{p.note}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Inbox conversations from people, newest first, as the assistant should see them. */
async function latestInbox(provider: MailProvider): Promise<ThreadSummary[]> {
  const page = await provider.listThreads({ folder: 'inbox' });
  return page.threads.filter(t => !t.draftId && !t.outgoing).slice(0, TRIAGE_COUNT);
}

function AiBriefing({ provider, assistant, followUps, onOpen }: { provider: MailProvider; assistant: Assistant; followUps: number; onOpen: (id: string) => void }) {
  const [state, setState] = useState<{ busy?: boolean; error?: string; result?: Briefing; threads?: Map<string, ThreadSummary> }>({});
  if (!assistant.live) return <span className="faint" style={{ fontSize: 12.5 }}>A written briefing needs the assistant.</span>;

  const run = async () => {
    setState({ busy: true });
    try {
      const list = await latestInbox(provider);
      if (!list.length) { setState({ error: 'Your inbox is empty.' }); return; }
      const result = await assistant.briefing(list.map(toItem), followUps);
      if (!result) { setState({ error: 'The assistant could not write a briefing.' }); return; }
      setState({ result, threads: new Map(list.map(t => [t.id, t])) });
    } catch (e) {
      setState({ error: errorText(e) });
    }
  };

  const { result, threads } = state;
  const link = (id: string, text: string) => {
    const t = threads?.get(id);
    return (
      <div key={id + text} className="an-row as-div">
        <button className="an-row-main link-like" onClick={() => onOpen(id)}><b>{t?.subject || '(conversation)'}</b><span>{t?.from} · {text}</span></button>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div><button className="btn sm" onClick={run} disabled={state.busy}>{state.busy ? 'Writing…' : result ? 'Rewrite briefing' : 'Write today’s briefing'}</button></div>
      {state.error && <span className="tone-danger" style={{ fontSize: 12.5 }}>{state.error}</span>}
      {result && (
        <div aria-label="Briefing" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13 }}>{result.summary}</p>
          {!!result.priorities.length && <><span className="mono-label">HANDLE FIRST</span><div className="an-list">{result.priorities.map(p => link(p.id, p.why))}</div></>}
          {!!result.commitments.length && <><span className="mono-label">DATES AND COMMITMENTS</span><div className="an-list">{result.commitments.map(c => link(c.id, c.text))}</div></>}
          <span className="faint" style={{ fontSize: 11.5 }}>From the latest {threads?.size} inbox conversations (previews only). Check the conversation before acting.</span>
        </div>
      )}
    </div>
  );
}

function InboxManager({ provider, assistant, dismissed, onDismiss, onOpen, onDraftReply }: {
  provider: MailProvider; assistant: Assistant; dismissed: string[]; onDismiss: (key: string) => void;
  onOpen: (id: string) => void; onDraftReply: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<{ t: ThreadSummary; c: Classification }[] | null>(null);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const canLabel = !!provider.applyLabel;

  const run = async () => {
    setBusy(true); setErr('');
    try {
      const list = (await latestInbox(provider)).filter(t => !dismissed.includes(triageKey(t)));
      if (!list.length) { setRows([]); return; }
      const results = await assistant.classify(list.map(toItem));
      if (!results) { setErr('Suggestions need the assistant.'); return; }
      const byId = new Map(results.map(r => [r.id, r]));
      setRows(list.filter(t => byId.has(t.id)).map(t => ({ t, c: byId.get(t.id)! })));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = async (t: ThreadSummary, c: Classification) => {
    const name = LABEL_PREFIX + c.category;
    if (!window.confirm('Add the Gmail label "' + name + '" to "' + t.subject + '"?')) return;
    try {
      await provider.applyLabel!(t.id, name);
      setApplied(a => ({ ...a, [t.id]: name }));
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const shown = useMemo(() => rows?.filter(r => !dismissed.includes(triageKey(r.t))) || null, [rows, dismissed]);

  return (
    <div className="card panel">
      <Head name="Intelligent inbox manager" status={assistant.live ? 'Operational' : 'Needs setup'} />
      <span className="muted" style={{ fontSize: 12.5 }}>
        Suggests a category, priority and action items for your latest {TRIAGE_COUNT} inbox conversations, from sender and preview only.
        Nothing changes in Gmail until you confirm a label{canLabel ? ' (they go under ' + LABEL_PREFIX + ')' : ''}.
      </span>
      {assistant.live
        ? <div><button className="btn sm" onClick={run} disabled={busy}>{busy ? 'Reading your inbox…' : rows ? 'Refresh suggestions' : 'Suggest labels and priorities'}</button></div>
        : <span className="faint" style={{ fontSize: 12.5 }}>Suggestions need the assistant (ANTHROPIC_API_KEY on the Worker).</span>}
      {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
      {shown && !shown.length && <span className="faint" style={{ fontSize: 12.5 }}>No new conversations to sort.</span>}
      {shown && !!shown.length && (
        <div className="an-list" aria-label="Inbox suggestions">
          {shown.map(({ t, c }) => (
            <div key={t.id} className="an-row as-div" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div className="an-row-main" style={{ gap: 4, flex: '1 1 280px' }}>
                <button className="link-like" style={{ textAlign: 'left', padding: 0 }} onClick={() => onOpen(t.id)}><b>{t.subject}</b></button>
                <span>{t.from} · {t.time}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="pill accent">{c.category}</span>
                  <span className={'pill ' + (c.priority === 'high' ? 'warn' : '')}>{c.priority} priority</span>
                  {c.urgent && <span className="pill danger">urgent</span>}
                  {c.needsResponse && <span className="pill">needs a reply</span>}
                  <span className="pill" title="The assistant's confidence in the category">{Math.round(c.confidence * 100)}% sure</span>
                </span>
                <span>{c.explanation}</span>
                {!!c.actionItems.length && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{c.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                {canLabel && (applied[t.id]
                  ? <span className="pill ok">Labeled {applied[t.id]}</span>
                  : <button className="btn sm" onClick={() => label(t, c)}>Label {LABEL_PREFIX + c.category}</button>)}
                {c.needsResponse && <button className="btn sm" onClick={() => onDraftReply(t.id)}>Draft reply</button>}
                <button className="btn sm ghost" onClick={() => onDismiss(triageKey(t))}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Head({ name, status }: { name: string; status: Status }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <b style={{ fontSize: 15 }}>{name}</b>
      <span className={'pill ' + TONE[status]} style={{ border: 0 }}>● {status}</span>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return <div className="an-tile card"><span className="an-tile-label">{label}</span><b className="an-tile-value">{value}</b></div>;
}

function Rows({ items, empty, onOpen, action, reason, onDismiss }: {
  items: WaitingItem[]; empty: string; onOpen: (id: string) => void; action: { label: string; run: (id: string) => void };
  reason: (w: WaitingItem) => string; onDismiss: (w: WaitingItem) => void;
}) {
  if (!items.length) return <span className="faint" style={{ fontSize: 12.5 }}>{empty}</span>;
  return (
    <div className="an-list">
      {items.map(w => (
        <div key={w.id} className="an-row as-div">
          <button className="an-row-main link-like" onClick={() => onOpen(w.id)}><b>{w.subject}</b><span>{reason(w)}</span></button>
          <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button className="btn sm" onClick={() => action.run(w.id)}>{action.label}</button>
            <button className="btn sm ghost" onClick={() => onDismiss(w)} aria-label={'Dismiss ' + w.subject}>Dismiss</button>
          </span>
        </div>
      ))}
    </div>
  );
}
