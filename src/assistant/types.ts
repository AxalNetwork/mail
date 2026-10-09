import type { AiInsight, Thread } from '../types';
import type { PersonaKey, PersonaMessage } from '../lib/bulk';

export type RewriteMode = 'shorter' | 'formal' | 'warmer' | 'clarity' | 'translate';

export interface AiNote {
  title: string;
  text: string;
}

export interface AiResult {
  /** New body HTML; absent when the assistant could not produce one. */
  html?: string;
  note: AiNote;
}

export interface DraftRequest {
  thread: Thread | null;
  instruction: string;
  recipientFirstName: string;
}

export interface Assistant {
  /** A live model is connected (otherwise only offline templates are available). */
  readonly live: boolean;
  /** Shown in the panel when no insight is available. */
  readonly unavailableText: string;
  insight(thread: Thread): Promise<AiInsight | null>;
  draft(req: DraftRequest): Promise<AiResult>;
  rewrite(html: string, mode: RewriteMode, thread: Thread | null): Promise<AiResult>;
  writePersona(persona: PersonaKey, tone: string, brief: string): Promise<PersonaMessage>;
}
