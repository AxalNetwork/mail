export type Folder = 'inbox' | 'starred' | 'snoozed' | 'sent' | 'drafts' | 'scheduled' | 'all' | 'search';

export interface Person {
  name: string;
  email: string;
  org: string;
  /** Set when the text typed into a recipient field is not a valid address. */
  invalid?: boolean;
}

export interface Contact extends Person {
  /** Relationship category, e.g. Founder, Investor, Contact. */
  cat: string;
}

export type Classification = 'Public' | 'Internal' | 'Confidential' | 'Restricted' | 'Not classified';

export interface AttachmentRef {
  name: string;
  ext: string;
  size: number;
  mime: string;
  /** Provider-specific handle used to download the bytes (Gmail: message + attachment id). */
  messageId?: string;
  attachmentId?: string;
}

export interface Message {
  id: string;
  from: string;
  email: string;
  to: string;
  cc?: string;
  /** To + Cc addresses, used for Reply all. */
  recipients?: Person[];
  /** Display time, e.g. "Today 09:42". */
  time: string;
  date?: number;
  text: string;
  /** Raw HTML body as received. Rendered in a sandboxed frame. */
  html?: string;
  attachments: AttachmentRef[];
  /** Recorded locally in demo mode; nothing was delivered. */
  demo?: boolean;
  /** RFC 822 Message-ID header, used to thread replies. */
  messageIdHeader?: string;
  references?: string;
}

export interface ActivityEvent {
  text: string;
  time: string;
}

export interface ThreadSummary {
  id: string;
  from: string;
  org: string;
  email: string;
  time: string;
  date?: number;
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  starred: boolean;
  attachCount: number;
  followup?: string;
  sensitive?: boolean;
  /** Present when the row is a draft; clicking it reopens the composer. */
  draftId?: string;
  /** Sent / scheduled items authored here. */
  outgoing?: boolean;
  /** Notifications and digests cannot be replied to. */
  noReply?: boolean;
}

export interface AiPoint {
  kind: string;
  text: string;
  src: string;
  tone: 'accent' | 'warn' | 'danger' | 'muted';
}

export interface AiInsight {
  summary: string;
  points: AiPoint[];
  /** Suggested reply HTML. */
  draft?: string;
}

export interface Thread extends ThreadSummary {
  messages: Message[];
  activity: ActivityEvent[];
  /** Message-ID of the first message: the key of the conversation's internal notes. */
  noteKey?: string;
  /** e.g. "Linked to Maya Chen · Northstar AI · Relationship owner: Julian Park" */
  linkText: string;
}

export interface Identity {
  id: string;
  addr: string;
  name: string;
  /** Long description, e.g. "Shared inbox · you are a member". */
  kind: string;
  /** Short chip label, e.g. "Personal". */
  short: string;
  /** Shown under the From field when this identity is picked. */
  note: string;
  isDefault?: boolean;
}

export interface Mailbox {
  addr: string;
  access: string;
}

export interface Category {
  id: string;
  label: string;
}

export interface Profile {
  id: string;
  first: string;
  last: string;
  title: string;
  region: string;
  email: string;
  whatsapp: string;
  linkedin: string;
  photoUrl?: string;
  /** A photo exists on file (demo profiles show initials instead of an image). */
  photo: boolean;
}

export interface Account {
  name: string;
  email: string;
  title: string;
  photoUrl?: string;
  profile: Profile;
}

export interface DocumentRef {
  id: string;
  name: string;
  ext: string;
  cls: Classification;
  size: number;
}

export type AttachmentSource =
  | { kind: 'file'; blob: Blob }
  | { kind: 'doc'; docId: string }
  | { kind: 'remote'; messageId: string; attachmentId: string };

export interface ComposeAttachment {
  id: string;
  name: string;
  ext: string;
  size: number;
  mime: string;
  cls: Classification;
  /** Confidential/Restricted documents go out as a secure named-recipient link. */
  secure: boolean;
  source: AttachmentSource;
}

export type Priority = 'Normal' | 'High' | 'Low';

export interface Schedule {
  label: string;
  when: string;
  at?: number;
}

export interface ReplyContext {
  threadId: string;
  messageIdHeader?: string;
  references?: string;
  /** Message-ID of the conversation's first message; keys shared internal notes. */
  rootId?: string;
}

/** Everything a provider needs to send or store a message. */
export interface OutgoingMessage {
  identity: Identity;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  html: string;
  text: string;
  attachments: ComposeAttachment[];
  priority: Priority;
  reply?: ReplyContext;
  draftId?: string;
  schedule?: Schedule | null;
  /** Internal note: stored for the team, never sent. */
  note?: string;
}

export interface SavedDraft {
  draftId: string;
  threadId?: string;
}

export interface SentResult {
  id: string;
  threadId: string;
  scheduled?: boolean;
}

/** Composer fields restored from a stored draft. */
export interface DraftContent {
  draftId: string;
  identityAddr?: string;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  html: string;
  attachments: ComposeAttachment[];
  reply?: ReplyContext;
  note?: string;
  priority?: Priority;
}

/** One message of a conversation, as analytics sees it: who, when, never content. */
export interface ConvMessage {
  /** Sender address, lowercased. */
  from: string;
  fromName: string;
  /** Sent by the signed-in user (any of their send-as addresses). */
  fromMe: boolean;
  /** Recipient addresses (To + Cc), lowercased. */
  to: string[];
  /** Epoch ms. */
  at: number;
  /** Bulk mail: List-Unsubscribe / List-Id / Precedence: bulk, or a no-reply sender. */
  automated: boolean;
}

export interface ConversationStat {
  id: string;
  subject: string;
  messages: ConvMessage[];
}

export interface ConversationSample {
  conversations: ConversationStat[];
  /** The sample stopped at the cap: older conversations in the period are not included. */
  truncated: boolean;
}
