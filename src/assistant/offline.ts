import { writePersona } from '../lib/bulk';
import { escapeHtml } from '../lib/html';
import type { Assistant, AiResult, DraftRequest } from './types';

export function instructionDraft(req: DraftRequest): AiResult {
  const p = req.instruction.trim();
  if (!p) return { note: { title: 'Nothing to draft from.', text: 'Add a recipient and describe what to write, or reply from a thread.' } };
  const line = p.charAt(0).toUpperCase() + p.slice(1).replace(/\.?$/, '.');
  return {
    html: '<p>Hi ' + escapeHtml(req.recipientFirstName || 'there') + ',</p><p>' + escapeHtml(line) +
      '</p><p>[Add specifics. No source in your accessible mail or documents covers this, so I did not fill in details.]</p><p>Best regards,</p>',
    note: { title: 'Draft from your instruction.', text: 'No thread context was used. Bracketed text needs your input.' }
  };
}

/** Used when no assistant backend is configured: templates only, no model. */
export class OfflineAssistant implements Assistant {
  readonly live = false;
  readonly unavailableText = 'The assistant is not connected. Set VITE_ASSISTANT_URL to enable summaries, drafts and rewrites.';
  async insight() { return null; }
  async draft(req: DraftRequest) { return instructionDraft(req); }
  async rewrite(): Promise<AiResult> {
    return { note: { title: 'Rewrite unavailable.', text: 'It needs the assistant backend (VITE_ASSISTANT_URL).' } };
  }
  async writePersona(persona: Parameters<typeof writePersona>[0], _tone: string, brief: string) {
    return writePersona(persona, brief);
  }
}
