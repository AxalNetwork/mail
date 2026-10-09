import type { Thread } from '../types';
import { INSIGHTS } from '../providers/demo/data';
import { writePersona, type PersonaKey } from '../lib/bulk';
import { instructionDraft } from './offline';
import type { Assistant, AiResult, DraftRequest, RewriteMode } from './types';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

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
}
