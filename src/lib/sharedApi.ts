/** Client for the Worker's Shared Inboxes API (/api/shared). */

export type SharedStatus = 'open' | 'pending' | 'resolved';

export interface SharedMailbox {
  mailbox: string;
  connection: { ok: boolean; via: 'delegation' | 'refresh_token'; error: string | null; checkedAt: number };
  members: { email: string; name: string; canSend: boolean }[];
  me: { canSend: boolean };
  /** Addresses Gmail lets this mailbox send as (primary and verified aliases). */
  sendAs: { email: string; name: string; primary: boolean }[];
  /** Conversations are read live from Gmail; nothing is copied. */
  sync: 'live';
}

export interface ConversationState {
  threadId: string;
  status: SharedStatus;
  assignee: string | null;
  /** 0 until someone first changes it. A change must name the version it was made from. */
  version: number;
  updatedBy: string | null;
  updatedAt: number | null;
  lastReplyBy: string | null;
  lastReplyAt: number | null;
  presence: { email: string; state: 'viewing' | 'replying' }[];
}

export interface SharedActivity { actor: string; action: 'assigned' | 'claimed' | 'released' | 'unassigned' | 'status' | 'replied' | 'send_refused' | 'snoozed' | 'unsnoozed' | 'woke'; detail: string; at: number }

/** Someone else changed the conversation first; `current` is what it is now. */
export class ConflictError extends Error {
  constructor(message: string, readonly current: ConversationState) { super(message); }
}

export interface SharedApi {
  /** `you`: the signed-in member's address, as assignments name it. */
  mailboxes(): Promise<{ enabled: boolean; you: string; mailboxes: SharedMailbox[] }>;
  states(mailbox: string, threadIds: string[]): Promise<Record<string, ConversationState>>;
  get(mailbox: string, threadId: string): Promise<{ state: ConversationState; activity: SharedActivity[]; you: string }>;
  update(mailbox: string, threadId: string, expectedVersion: number, change: { assignee?: string | null; status?: SharedStatus }): Promise<ConversationState>;
  presence(mailbox: string, threadId: string, state: 'viewing' | 'replying' | 'gone'): Promise<void>;
}

export class HttpSharedApi implements SharedApi {
  constructor(private token: () => Promise<string>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/shared' + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string; current?: ConversationState };
    if (res.status === 409 && j.current) throw new ConflictError(j.error || 'Changed by someone else', j.current);
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
    return j;
  }
  private base = (mailbox: string) => '/' + encodeURIComponent(mailbox) + '/threads';

  mailboxes() { return this.call<{ enabled: boolean; you: string; mailboxes: SharedMailbox[] }>(''); }
  async states(mailbox: string, ids: string[]) {
    if (!ids.length) return {};
    return (await this.call<{ states: Record<string, ConversationState> }>(this.base(mailbox) + '?ids=' + ids.map(encodeURIComponent).join(','))).states;
  }
  get(mailbox: string, id: string) { return this.call<{ state: ConversationState; activity: SharedActivity[]; you: string }>(this.base(mailbox) + '/' + id); }
  async update(mailbox: string, id: string, expectedVersion: number, change: { assignee?: string | null; status?: SharedStatus }) {
    return (await this.call<{ state: ConversationState }>(this.base(mailbox) + '/' + id, { method: 'PATCH', body: JSON.stringify({ expectedVersion, ...change }) })).state;
  }
  async presence(mailbox: string, id: string, state: 'viewing' | 'replying' | 'gone') {
    await this.call(this.base(mailbox) + '/' + id + '/presence', { method: 'POST', body: JSON.stringify({ state }), keepalive: state === 'gone' });
  }
}

export const STATUS_LABEL: Record<SharedStatus, string> = { open: 'Open', pending: 'Pending', resolved: 'Resolved' };

export const ACTION_TEXT: Record<SharedActivity['action'], (detail: string) => string> = {
  assigned: d => 'assigned it to ' + d,
  claimed: () => 'claimed it',
  released: () => 'released it',
  unassigned: d => 'unassigned ' + d,
  status: d => 'marked it ' + (STATUS_LABEL[d as SharedStatus] || d).toLowerCase(),
  replied: d => 'replied' + (d ? ' as ' + d : ''),
  send_refused: d => 'was stopped from sending (' + d + ')',
  snoozed: d => 'snoozed it until ' + (Number(d) ? new Date(Number(d)).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'later'),
  unsnoozed: () => 'brought it back from snooze',
  woke: d => (d === 'reply' ? 'brought it back: someone replied' : 'brought it back: snooze ended')
};
