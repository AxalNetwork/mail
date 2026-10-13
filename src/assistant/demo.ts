import type { Thread } from '../types';
import { INSIGHTS } from '../providers/demo/data';
import { writePersona, type PersonaKey } from '../lib/bulk';
import { instructionDraft } from './offline';
import type { Assistant, AiResult, Briefing, Classification, DraftRequest, RewriteMode, TriageCategory, TriageItem } from './types';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Keyword rules standing in for the model in demo mode. */
const RULES: [RegExp, TriageCategory][] = [
  [/unsubscribe|newsletter|digest|weekly/i, 'Newsletter'],
  [/\b(LP|limited partner|capital call|fund (I|II|III|IV)|commitment)\b/i, 'Investor'],
  [/deck|pitch|raising|seed|series [abc]|pre-seed/i, 'Investment opportunity'],
  [/board|portfolio|update|KPI|MRR|ARR/i, 'Portfolio company'],
  [/founder/i, 'Founder'],
  [/partner(ship)?|co-invest|syndicate/i, 'Partnership'],
  [/event|summit|conference|dinner|panel|invite/i, 'Event'],
  [/invoice|contract|signature|legal|tax|compliance|KYC/i, 'Administrative']
];

export function demoClassify(i: TriageItem): Classification {
  const text = i.subject + ' ' + i.snippet;
  const hit = RULES.find(([re]) => re.test(text));
  const category = hit ? hit[1] : 'Other';
  const urgent = /urgent|asap|today|by (mon|tue|wed|thu|fri)|deadline|eod/i.test(text);
  const asks = text.match(/(?:can you|could you|please|would you)[^.?!]*[.?!]?/gi) || [];
  const needsResponse = category !== 'Newsletter' && (asks.length > 0 || /\?/.test(i.snippet));
  return {
    id: i.id, category, urgent, needsResponse,
    priority: urgent || category === 'Investor' ? 'high' : category === 'Newsletter' ? 'low' : 'normal',
    confidence: hit ? 0.7 : 0.4,
    explanation: hit ? 'Demo rule: the subject or preview mentions "' + (text.match(hit[0]) || [''])[0] + '".' : 'Demo rule: no keyword matched, so this is a guess.',
    actionItems: asks.slice(0, 3).map(a => a.trim())
  };
}

/** Canned assistant for demo mode: fixed insights per sample thread and simple text rewrites. */
export class DemoAssistant implements Assistant {
  readonly live = true;
  readonly unavailableText = 'No AI summary for this message.';

  async insight(thread: Thread) {
    const i = INSIGHTS[thread.id];
    return i ? { summary: i.summary, points: i.points, draft: i.draft } : null;
  }

  async draft(req: DraftRequest): Promise<AiResult> {
    const i = req.thread ? INSIGHTS[req.thread.id] : undefined;
    if (i?.draft && !req.instruction.trim()) {
      return { html: i.draft, note: { title: 'AI draft.', text: 'Based on "' + req.thread!.subject + '". Review before sending.' } };
    }
    return instructionDraft(req);
  }

  async rewrite(html: string, mode: RewriteMode, thread: Thread | null): Promise<AiResult> {
    if (mode === 'translate') {
      const fr = thread ? INSIGHTS[thread.id]?.fr : undefined;
      if (fr) return { html: fr, note: { title: 'Translated to French.', text: 'Check names, dates and figures against the original.' } };
      return { note: { title: 'Translation unavailable in demo.', text: 'It needs the live model connection.' } };
    }
    let h = html;
    const paras = h.split(/(?=<p>)/);
    if (mode === 'shorter' && paras.length > 3) h = [paras[0], paras[1].replace(/([.?!])\s.*?(<\/p>)/, '$1$2'), paras[paras.length - 1]].join('');
    if (mode === 'formal') {
      h = h.replace(/<p>Hi\s/, '<p>Dear ').replace(/Thanks,/g, 'Thank you,').replace(/<p>Best,<\/p>/, '<p>Kind regards,</p>')
        .replace(/I'd/g, 'I would').replace(/I'll/g, 'I will').replace(/I've/g, 'I have');
    }
    if (mode === 'warmer') h = h.replace(/(<p>[^<]*,<\/p>)/, '$1<p>Great to hear from you.</p>');
    if (mode === 'clarity') h = h.replace(/\s+/g, ' ').replace(/ ,/g, ',');
    const title = { shorter: 'Shortened.', formal: 'Made more formal.', warmer: 'Made warmer.', clarity: 'Tightened for clarity.' }[mode];
    return { html: h, note: { title, text: 'Review the changes before sending.' } };
  }

  async writePersona(persona: PersonaKey, _tone: string, brief: string) {
    await wait(900);
    return writePersona(persona, brief);
  }

  async classify(items: TriageItem[]): Promise<Classification[]> {
    await wait(400);
    return items.map(demoClassify);
  }

  async briefing(items: TriageItem[], followUps: number): Promise<Briefing> {
    await wait(400);
    const c = items.map(demoClassify).filter(r => r.category !== 'Newsletter');
    const top = [...c].sort((a, b) => Number(b.urgent) - Number(a.urgent) || Number(b.priority === 'high') - Number(a.priority === 'high')).slice(0, 3);
    return {
      summary: c.length + ' conversations from people in your inbox' + (followUps ? ', and ' + followUps + ' follow-ups due.' : '.') + ' (Demo briefing from keyword rules.)',
      priorities: top.map(r => ({ id: r.id, why: r.urgent ? 'Mentions a deadline.' : r.category + (r.needsResponse ? ', asks you something.' : '.') })),
      commitments: []
    };
  }

  /** Records live in the backend, which demo mode does not have. */
  async relationship() { return null; }
}
