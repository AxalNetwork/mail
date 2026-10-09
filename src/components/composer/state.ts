import type { AiNote } from '../../assistant/types';
import type { AttachmentRef, ComposeAttachment, Person, Priority, ReplyContext, Schedule, Thread } from '../../types';
import type { Quote } from '../../lib/outgoing';

export interface ComposeState {
  /** Changes every time a new message is opened; resets the editor. */
  key: number;
  mode: 'new' | 'reply' | 'forward';
  reply: ReplyContext | null;
  /** Conversation the message responds to; gives the assistant context. */
  context: Thread | null;
  fromId: string;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  /** Body HTML. The editor is the source of truth while open; this is synced on every change. */
  html: string;
  attachments: ComposeAttachment[];
  /** Attachments of a forwarded message, offered but not included automatically. */
  forwardable: AttachmentRef[];
  quote: Quote | null;
  note: string;
  noteOpen: boolean;
  priority: Priority;
  schedule: Schedule | null;
  signature: boolean;
  draftId?: string;
  saving: boolean;
  savedAt: string | null;
  expanded: boolean;
  minimized: boolean;
  aiBar: boolean;
  aiNote: AiNote | null;
}

let seq = 1;

export function newCompose(patch: Partial<ComposeState> & { fromId: string }): ComposeState {
  return {
    key: seq++, mode: 'new', reply: null, context: null, to: [], cc: [], bcc: [], showCc: false, showBcc: false,
    subject: '', html: '', attachments: [], forwardable: [], quote: null, note: '', noteOpen: false, priority: 'Normal',
    schedule: null, signature: true, saving: false, savedAt: null, expanded: false, minimized: false, aiBar: false, aiNote: null,
    ...patch
  };
}

export function replySubject(s: string): string {
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

export function forwardSubject(s: string): string {
  return /^fwd?:/i.test(s) ? s : 'Fwd: ' + s;
}
