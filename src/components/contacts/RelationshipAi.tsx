import { useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { Assistant, RelationshipBrief, RelationshipConversation, Sourced } from '../../assistant/types';
import type { ConversationLink } from '../../lib/relationships';
import { errorText } from '../Toast';

/** How many recent conversations the assistant reads (their latest messages only). */
export const AI_CONVERSATIONS = 6;

interface Props {
  assistant: Assistant;
  provider: MailProvider;
  contactId: number;
  conversations: ConversationLink[];
  /** The user's own addresses, to tell their messages apart. */
  myEmails: string[];
  onOpen: (threadId: string) => void;
}

/** Reads the latest conversations from the user's mailbox (nothing is stored) and asks the assistant. */
export function RelationshipAi({ assistant, provider, contactId, conversations, myEmails, onOpen }: Props) {
  const [state, setState] = useState<{ busy?: 'summary' | 'meeting'; error?: string; brief?: RelationshipBrief }>({});
  if (!assistant.live) return <span className="faint" style={{ fontSize: 12.5 }}>Summaries and meeting briefings need the assistant (ANTHROPIC_API_KEY on the Worker).</span>;

  const mine = new Set(myEmails.map(e => e.toLowerCase()));
  const subjects = new Map(conversations.map(c => [c.id, c.subject]));

  const run = async (mode: 'summary' | 'meeting') => {
    setState({ busy: mode });
    try {
      const picked = conversations.slice(0, AI_CONVERSATIONS);
      const threads = await Promise.all(picked.map(c => provider.getThread(c.id).catch(() => null)));
      const convs: RelationshipConversation[] = threads.filter(t => t !== null).map(t => ({
        id: t.id, subject: t.subject,
        messages: t.messages.slice(-4).map(m => ({ from: m.email, fromMe: mine.has(m.email.toLowerCase()), at: m.date || 0, text: m.text.slice(0, 1500) }))
      }));
      const brief = await assistant.relationship(contactId, convs, mode);
      setState(brief ? { brief } : { error: 'The assistant could not answer.' });
    } catch (e) {
      setState({ error: errorText(e) });
    }
  };

  const src = (s: Sourced) => (
    <span className="row-wrap" style={{ display: 'inline-flex', marginLeft: 6 }}>
      {s.sources.map(id => id === 'record'
        ? <span key={id} className="pill">record</span>
        : <button key={id} className="pill accent link-like" onClick={() => onOpen(id)} title="Open the source conversation">{subjects.get(id) || 'conversation'}</button>)}
    </span>
  );
  const list = (title: string, items: Sourced[]) => !!items.length && (
    <div>
      <span className="mono-label">{title}</span>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>{items.map((x, i) => <li key={i}>{x.text}{src(x)}</li>)}</ul>
    </div>
  );
  const b = state.brief;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row-wrap">
        <button className="btn sm" disabled={!!state.busy} onClick={() => run('summary')}>{state.busy === 'summary' ? 'Reading…' : 'Summarize relationship'}</button>
        <button className="btn sm" disabled={!!state.busy} onClick={() => run('meeting')}>{state.busy === 'meeting' ? 'Reading…' : 'Prepare meeting briefing'}</button>
      </div>
      <span className="faint" style={{ fontSize: 11.5 }}>Reads the record and your latest {Math.min(AI_CONVERSATIONS, conversations.length)} conversations with them. Nothing is sent.</span>
      {state.error && <span className="tone-danger" style={{ fontSize: 12.5 }}>{state.error}</span>}
      {b && (
        <div aria-label="Relationship summary" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13 }}>{b.summary}</p>
          {list('FACTS FROM YOUR EMAIL AND RECORDS', b.facts)}
          {list('OPEN QUESTIONS', b.openQuestions)}
          {list('PRIOR COMMITMENTS', b.commitments)}
          {!!b.inferences.length && (
            <div>
              <span className="mono-label">AI INFERENCES (NOT STATED ANYWHERE)</span>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, fontStyle: 'italic' }}>{b.inferences.map((x, i) => <li key={i}>{x.text}{src(x)}</li>)}</ul>
            </div>
          )}
          {!!b.nextSteps.length && (
            <div>
              <span className="mono-label">{b.mode === 'meeting' ? 'SUGGESTED TALKING POINTS' : 'SUGGESTED NEXT STEPS'}</span>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>{b.nextSteps.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
