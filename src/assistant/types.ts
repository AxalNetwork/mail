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

/** One inbox conversation as the inbox manager sees it: metadata and the preview only. */
export interface TriageItem { id: string; subject: string; from: string; email: string; snippet: string; labels?: string[]; when?: string }

export const TRIAGE_CATEGORIES = ['Investor', 'Founder', 'Investment opportunity', 'Portfolio company', 'Partnership', 'Event', 'Administrative', 'Newsletter', 'Other'] as const;
export type TriageCategory = typeof TRIAGE_CATEGORIES[number];

/** A suggestion for one conversation. Nothing in the mailbox changes until the user applies it. */
export interface Classification {
  id: string;
  category: TriageCategory;
  priority: 'high' | 'normal' | 'low';
  urgent: boolean;
  needsResponse: boolean;
  /** 0 to 1. */
  confidence: number;
  explanation: string;
  actionItems: string[];
}

/** A briefing whose every item points at one of the conversations it was given. */
export interface Briefing {
  summary: string;
  priorities: { id: string; why: string }[];
  commitments: { id: string; text: string }[];
}

/** Conversation text the relationship assistant reads, from the user's own mailbox. */
export interface RelationshipConversation { id: string; subject: string; messages: { from: string; fromMe: boolean; at: number; text: string }[] }
export interface Sourced { text: string; sources: string[] }
/** A relationship summary or meeting briefing. Facts cite a conversation id or "record"; inferences are the model's own. */
export interface RelationshipBrief {
  mode: 'summary' | 'meeting';
  summary: string;
  facts: Sourced[];
  inferences: Sourced[];
  openQuestions: Sourced[];
  commitments: Sourced[];
  nextSteps: string[];
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
  /** Suggest a category, priority and next step per conversation (null: needs the live assistant). */
  classify(items: TriageItem[]): Promise<Classification[] | null>;
  /** Today's briefing from these conversations (null: needs the live assistant). */
  briefing(items: TriageItem[], followUps: number): Promise<Briefing | null>;
  /** Summarize a relationship or prepare a meeting (null: needs the live assistant). */
  relationship(contactId: number, conversations: RelationshipConversation[], mode: 'summary' | 'meeting'): Promise<RelationshipBrief | null>;
}
