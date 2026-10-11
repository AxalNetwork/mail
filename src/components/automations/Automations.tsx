import type { MailProvider } from '../../providers/types';
import { ago, type WaitingItem } from '../../lib/analytics';
import { useStats } from '../analytics/useStats';

interface Props {
  provider: MailProvider;
  orgDomain: string;
  /** The AI assistant is connected (otherwise drafts come from templates). */
  aiReady: boolean;
  onOpen: (threadId: string) => void;
  /** Opens a reply to the conversation with an assistant draft. */
  onDraftReply: (threadId: string) => void;
  onGo: (view: 'analytics') => void;
}

const DAY = 86_400_000;

const PLANNED: { name: string; what: string; needs: string }[] = [
  { name: 'Intelligent inbox manager', what: 'Classify, prioritize and label incoming mail.', needs: 'Gmail filters and labels written on your behalf; needs a review step before it changes your mailbox.' },
  { name: 'Email-to-CRM', what: 'Extract contacts, companies, opportunities and next steps.', needs: 'A CRM to write to (none is connected yet).' },
  { name: 'Investor outreach sequences', what: 'Personalized outreach with follow-up steps.', needs: 'Builds on Bulk email; sequences need scheduled sends, which the Gmail API doesn’t offer, so they need a sending job on the Worker.' },
  { name: 'Meeting scheduling agent', what: 'Handle scheduling requests and coordinate availability.', needs: 'Google Calendar access (a new permission).' },
  { name: 'Support agent', what: 'Answer routine questions, escalate the rest.', needs: 'A shared support inbox and an approved answer base.' },
  { name: 'Document processing', what: 'Pull terms and figures from PDFs, decks and contracts.', needs: 'Attachment reading by the assistant, with confidentiality rules per document.' }
];

export function Automations({ provider, orgDomain, aiReady, onOpen, onDraftReply, onGo }: Props) {
  const { stats: s, loading, error, reload } = useStats(provider, 30, orgDomain);
  const now = Date.now();
  const today = s ? s.waitingOnYou.filter(w => now - w.since < DAY) : [];

  return (
    <section className="admin" aria-label="AI automations">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>AI Automations</h1>
          <span className="muted">
            Automations prepare work for you to approve; nothing is sent on its own.
            {aiReady ? ' Drafts come from the assistant.' : ' The assistant isn’t connected yet, so drafts start from templates.'}
          </span>
        </div>

        {error && <div className="card panel"><span className="tone-danger">Couldn’t load your mailbox: {error}</span><button className="btn sm" onClick={reload}>Try again</button></div>}
        {loading && !s && <div className="card panel an-loading"><div className="spinner" /> Looking through the last 30 days…</div>}

        {s && (
          <>
            <div className="card panel">
              <Head name="Daily briefing" status="Active" />
              <span className="muted" style={{ fontSize: 12.5 }}>Last 24 hours, from people (bulk mail left out).</span>
              <div className="an-tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <Mini label="New, waiting on you" value={today.length} />
                <Mini label="Waiting on you, total" value={s.waitingOnYou.length} />
                <Mini label="Follow-ups due" value={s.waitingOnOthers.length} />
              </div>
              <Rows items={today.slice(-5).reverse()} now={now} empty="Nothing new from people in the last 24 hours." onOpen={onOpen}
                action={{ label: 'Draft reply', run: onDraftReply }} />
            </div>

            <div className="card panel">
              <Head name="Follow-up agent" status="Active" />
              <span className="muted" style={{ fontSize: 12.5 }}>Conversations where you wrote last, more than 3 days ago. Draft a follow-up, review it, send it yourself.</span>
              <Rows items={s.waitingOnOthers.slice(0, 10)} now={now} empty="No follow-ups due." onOpen={onOpen}
                action={{ label: 'Draft follow-up', run: onDraftReply }} />
            </div>

            <div className="card panel">
              <Head name="Reply assistant" status="Active" />
              <span className="muted" style={{ fontSize: 12.5 }}>People waiting on an answer, oldest first. Each draft uses the conversation and your signature.</span>
              <Rows items={s.waitingOnYou.slice(0, 10)} now={now} empty="Nobody is waiting on you." onOpen={onOpen}
                action={{ label: 'Draft reply', run: onDraftReply }} />
            </div>

            <div className="card panel">
              <Head name="Security & deliverability monitoring" status="Active" />
              <span className="muted" style={{ fontSize: 12.5 }}>SPF, DKIM, DMARC and MX checks for {orgDomain || 'your domain'}.</span>
              <div><button className="btn sm" onClick={() => onGo('analytics')}>Open in Analytics</button></div>
            </div>
          </>
        )}

        <div className="card table">
          <div className="trow plans head"><span>PLANNED</span><span>WHAT IT DOES</span><span>WHAT IT NEEDS FIRST</span></div>
          {PLANNED.map(p => (
            <div key={p.name} className="trow plans">
              <b>{p.name}</b><span>{p.what}</span><span className="muted">{p.needs}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Head({ name, status }: { name: string; status: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <b style={{ fontSize: 15 }}>{name}</b>
      <span className="pill ok" style={{ border: 0 }}>● {status}</span>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return <div className="an-tile card"><span className="an-tile-label">{label}</span><b className="an-tile-value">{value}</b></div>;
}

function Rows({ items, now, empty, onOpen, action }: { items: WaitingItem[]; now: number; empty: string; onOpen: (id: string) => void; action: { label: string; run: (id: string) => void } }) {
  if (!items.length) return <span className="faint" style={{ fontSize: 12.5 }}>{empty}</span>;
  return (
    <div className="an-list">
      {items.map(w => (
        <div key={w.id} className="an-row as-div">
          <button className="an-row-main link-like" onClick={() => onOpen(w.id)}><b>{w.subject}</b><span>{w.who} · {ago(w.since, now)}</span></button>
          <button className="btn sm" onClick={() => action.run(w.id)}>{action.label}</button>
        </div>
      ))}
    </div>
  );
}
