/** Client for the Worker's outreach sequences API (/api/sequences). */

export const SENDER_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

export type SequenceStatus = 'draft' | 'approved' | 'active' | 'paused' | 'completed' | 'stopped';
export type RecipientStatus = 'pending' | 'active' | 'replied' | 'opted_out' | 'bounced' | 'stopped' | 'completed' | 'failed';

export interface SenderStatus { connected: boolean; via: 'grant' | 'delegation' | null; googleEmail: string | null; canConnect: boolean; missing: string[] }
export interface Step { delayDays: number; subject: string; body: string }
export interface RecipientIn { email: string; firstName: string; lastName: string; company: string; context: string }
export interface Recipient extends RecipientIn { id: number; status: RecipientStatus; nextStep: number; nextAt: number | null; lastError: string | null; firstSentAt: number | null }
export interface SequenceSummary { id: number; name: string; owner: string; status: SequenceStatus; version: number; mine: boolean; approved: boolean; updatedAt: number; lastError: string | null; counts: Partial<Record<RecipientStatus, number>> }
export interface Sequence {
  id: number; name: string; owner: string; status: SequenceStatus; version: number; mine: boolean; canApprove: boolean;
  approved: { by: string; at: number } | null; lastError: string | null; createdAt: number; updatedAt: number;
  signatureHtml: string; steps: Step[]; recipients: Recipient[];
}
export interface SequenceInput { name: string; steps: Step[]; recipients: RecipientIn[]; signatureHtml: string; signatureText: string }

export interface SequencesApi {
  sender(): Promise<SenderStatus>;
  connect(): Promise<SenderStatus>;
  disconnect(): Promise<SenderStatus>;
  list(): Promise<SequenceSummary[]>;
  get(id: number): Promise<Sequence>;
  create(s: SequenceInput): Promise<Sequence>;
  update(id: number, s: SequenceInput): Promise<Sequence>;
  approve(id: number, version: number): Promise<Sequence>;
  action(id: number, a: 'start' | 'pause' | 'stop'): Promise<Sequence>;
  stopRecipient(id: number, recipientId: number, optOut: boolean): Promise<Sequence>;
}

export class HttpSequencesApi implements SequencesApi {
  constructor(private token: () => Promise<string>, private consent: () => Promise<string>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/sequences' + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
    return j;
  }
  private post<T>(path: string, body: unknown = {}) { return this.call<T>(path, { method: 'POST', body: JSON.stringify(body) }); }

  async sender() { return (await this.call<{ sender: SenderStatus }>('/sender')).sender; }
  async connect() { const code = await this.consent(); return (await this.post<{ sender: SenderStatus }>('/sender', { code })).sender; }
  async disconnect() { return (await this.call<{ sender: SenderStatus }>('/sender', { method: 'DELETE' })).sender; }
  async list() { return (await this.call<{ sequences: SequenceSummary[] }>('')).sequences; }
  async get(id: number) { return (await this.call<{ sequence: Sequence }>('/' + id)).sequence; }
  async create(s: SequenceInput) { return (await this.post<{ sequence: Sequence }>('', s)).sequence; }
  async update(id: number, s: SequenceInput) { return (await this.call<{ sequence: Sequence }>('/' + id, { method: 'PUT', body: JSON.stringify(s) })).sequence; }
  async approve(id: number, version: number) { return (await this.post<{ sequence: Sequence }>('/' + id + '/approve', { version })).sequence; }
  async action(id: number, a: 'start' | 'pause' | 'stop') { return (await this.post<{ sequence: Sequence }>('/' + id + '/' + a)).sequence; }
  async stopRecipient(id: number, rid: number, optOut: boolean) { return (await this.post<{ sequence: Sequence }>('/' + id + '/recipients/' + rid + '/stop', { optOut })).sequence; }
}

/** Recipients from pasted CSV: a header row with email / first name / last name / company / context, or bare addresses. */
export function parseRecipients(rows: string[][]): RecipientIn[] {
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const hasHeader = !head.some(h => h.includes('@'));
  const col = (names: string[]) => (hasHeader ? head.findIndex(h => names.includes(h)) : -1);
  const ix = {
    email: hasHeader ? col(['email', 'e-mail', 'email address', 'mail']) : 0,
    first: col(['first_name', 'first name', 'firstname', 'first']),
    last: col(['last_name', 'last name', 'lastname', 'surname', 'last']),
    company: col(['company', 'organization', 'organisation', 'org', 'firm', 'fund']),
    context: col(['context', 'note', 'notes', 'topic'])
  };
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] || '').trim() : '');
  return (hasHeader ? rows.slice(1) : rows)
    .map(r => ({ email: at(r, ix.email).toLowerCase(), firstName: at(r, ix.first), lastName: at(r, ix.last), company: at(r, ix.company), context: at(r, ix.context) }))
    .filter(r => r.email);
}
