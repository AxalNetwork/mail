import type {
  Account, ConversationSample, Category, Contact, DocumentRef, DraftContent, Folder, Identity, Mailbox,
  OutgoingMessage, Profile, SavedDraft, Schedule, SentResult, Thread, ThreadSummary
} from '../types';

export interface Capabilities {
  /** Snooze threads from the reader. */
  snooze: boolean;
  /** Schedule send. The Gmail API has no scheduled-send endpoint. */
  schedule: boolean;
  /** Attach from the firm's document library. */
  documents: boolean;
  /** Switch between several mailboxes (shared inboxes, delegations). */
  mailboxSwitch: boolean;
  /** Write the standard signature into the mail account's settings. */
  installSignature: boolean;
  /** Minimum spacing between individual bulk sends, in ms. */
  bulkSpacingMs: number;
  /** Messages are recorded locally and never delivered. */
  demo: boolean;
  /** Internal notes are shared with the team (otherwise kept on this device). */
  sharedNotes: boolean;
}

export interface ListQuery {
  folder: Folder;
  category?: string;
  query?: string;
  pageToken?: string;
}

export interface ListPage {
  threads: ThreadSummary[];
  nextPageToken?: string;
}

export interface FolderCounts {
  inbox: number;
  snoozed: number;
  sent: number;
  drafts: number;
  scheduled: number;
}

export interface MailProvider {
  readonly kind: 'demo' | 'gmail';
  readonly capabilities: Capabilities;
  /** Domain treated as internal for external-recipient warnings ('' = none). */
  readonly orgDomain: string;
  /** Address of the shared mailbox being shown; undefined for the user's own. */
  readonly mailbox?: string;

  account(): Promise<Account>;
  mailboxes(): Promise<Mailbox[]>;
  categories(): Promise<Category[]>;
  identities(): Promise<Identity[]>;
  counts(): Promise<FolderCounts>;
  scheduleOptions(): Schedule[];

  listThreads(q: ListQuery): Promise<ListPage>;
  /** Conversation metadata (senders, recipients, times; no content) for analytics. */
  conversations(days: number, cap?: number): Promise<ConversationSample>;
  getThread(id: string): Promise<Thread>;
  /** Thread id of the conversation containing this RFC Message-ID, if it is in this mailbox. */
  findThread?(messageId: string): Promise<string | null>;

  markRead(id: string, read: boolean): Promise<void>;
  setStarred(id: string, starred: boolean): Promise<void>;
  archive(id: string): Promise<void>;
  trash(id: string): Promise<void>;
  /** Hide the conversation until `until` (epoch ms); returns how to describe that time. */
  snooze(id: string, until: number): Promise<string>;
  /** Back to the inbox now. */
  unsnooze?(id: string): Promise<void>;
  /** Bring back what is due (or was answered) and return how many came back. */
  wakeDue?(): Promise<number>;
  /** The server brings snoozed conversations back by itself (otherwise only an open app does). */
  snoozeWakesOnServer?(): Promise<boolean>;
  /** Add a user label by name, creating it when it does not exist yet. Only call after the user confirmed. */
  applyLabel?(id: string, name: string): Promise<void>;

  searchContacts(q: string): Promise<Contact[]>;
  documents(): Promise<DocumentRef[]>;
  /** Addresses that opted out of bulk email, with a reason. */
  optOuts(): Promise<Record<string, string>>;

  send(msg: OutgoingMessage): Promise<SentResult>;
  saveDraft(msg: OutgoingMessage): Promise<SavedDraft>;
  getDraft(draftId: string): Promise<DraftContent>;
  deleteDraft(draftId: string): Promise<void>;
  downloadAttachment(messageId: string, attachmentId: string, mime: string): Promise<Blob>;

  /** Profiles shown on the signature administration page. */
  profiles(): Promise<Profile[]>;
  installSignature(html: string): Promise<void>;
  /** Persist profile details used by the signature (Gmail: stored on this device). */
  updateProfile?(p: Profile): Promise<void>;

  signOut?(): void;
}
