import type { AiInsight, Thread } from '../types';
import type { PersonaKey, PersonaMessage } from '../lib/bulk';
import type { Assistant, AiResult, Briefing, Classification, DraftRequest, RelationshipBrief, RelationshipConversation, RewriteMode, TriageItem } from './types';
import { htmlToText } from '../lib/html';

/**
 * Client for an assistant backend. The backend owns the model and its policy
 * (only use content the user can access, never invent facts). Contract:
 *
 *   POST {base}/insight  { thread }                         → AiInsight | null
 *   POST {base}/draft    { thread, instruction, recipientFirstName } → AiResult
 *   POST {base}/rewrite  { text, mode, thread }             → AiResult
 *   POST {base}/persona  { persona, tone, brief }           → { subject, body }
 *   POST {base}/classify { items }                          → { results: Classification[] }
 *   POST {base}/briefing { items, followUps }               → Briefing
 *   POST {base}/relationship { contactId, conversations, mode } → RelationshipBrief
 *
 * The caller's Google access token is forwarded as a Bearer token so the
 * backend can verify who is asking.
 */
export class HttpAssistant implements Assistant {
  readonly live = true;
  readonly unavailableText = 'No summary for this conversation.';

  constructor(private base: string, private token: () => Promise<string | null> = async () => null) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const tok = await this.token();
    const res = await fetch(this.base.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(j?.error || 'Assistant request failed (' + res.status + ')');
    }
    return res.json() as Promise<T>;
  }

  /** Send only what the model needs: text bodies, no raw HTML. */
  private slim(t: Thread | null) {
    if (!t) return null;
    return {
      id: t.id, subject: t.subject, labels: t.labels,
      messages: t.messages.map(m => ({ from: m.from, email: m.email, to: m.to, time: m.time, text: m.text, attachments: m.attachments.map(a => a.name) }))
    };
  }

  insight(thread: Thread) { return this.post<AiInsight | null>('/insight', { thread: this.slim(thread) }); }
  draft(req: DraftRequest) { return this.post<AiResult>('/draft', { ...req, thread: this.slim(req.thread) }); }
  rewrite(html: string, mode: RewriteMode, thread: Thread | null) { return this.post<AiResult>('/rewrite', { text: htmlToText(html), mode, thread: this.slim(thread) }); }
  writePersona(persona: PersonaKey, tone: string, brief: string) { return this.post<PersonaMessage>('/persona', { persona, tone, brief }); }
  async classify(items: TriageItem[]): Promise<Classification[]> { return (await this.post<{ results: Classification[] }>('/classify', { items })).results; }
  briefing(items: TriageItem[], followUps: number) { return this.post<Briefing>('/briefing', { items, followUps }); }
  relationship(contactId: number, conversations: RelationshipConversation[], mode: 'summary' | 'meeting') {
    return this.post<RelationshipBrief>('/relationship', { contactId, conversations, mode });
  }
}
