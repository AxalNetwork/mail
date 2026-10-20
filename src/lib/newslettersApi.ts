/** Client for the Worker's Newsletters API (/api/newsletters). */

import type { Block, TemplateId } from './newsletter/types';

export type IssueStatus = 'draft' | 'in_review' | 'approved' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled';

export interface NlList { id: number; key: string; name: string; description: string; public: boolean; requiresApproval: boolean; subscribed: number; lastSent: number | null }

export interface Issue {
  id: number; title: string; template: TemplateId; subject: string; preheader: string; edition: string; listIds: number[];
  /** StudioOS audience keys. */
  audiences: string[]; programmeUid: string | null; variant: string;
  fromEmail: string; fromName: string; signoff: { title: string; calendarUrl: string }; status: IssueStatus; version: number; contentHash: string;
  approvalRequired: boolean; approved: boolean; approvedBy: string | null; approvedAt: number | null; reviewRequestedBy: string | null;
  senderMember: string | null; scheduledAt: number | null; startedAt: number | null; sentAt: number | null;
  recipients: number; sent: number; failed: number; unconfirmed: number; queued: number; skipped: number; lastError: string | null;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number;
  canEdit: boolean; canApprove: boolean; canSchedule: boolean;
  /** Only on a single issue. */
  blocks?: Block[];
  audience?: number;
  excluded?: { unsubscribed: number; bounced: number; suppressed: number; pending: number };
  unsubscribes?: number;
  dailyLimit?: number;
}

export type IssueChange = Partial<Pick<Issue, 'title' | 'subject' | 'preheader' | 'edition' | 'listIds' | 'audiences' | 'fromEmail' | 'fromName' | 'signoff' | 'blocks'>>;

export interface NlSettings {
  postalAddress: string; disclaimer: string; fromName: string; systemSender: string | null; systemFrom: string;
  doubleOptIn: boolean; batchSize: number; allowedOrigins: string[]; updatedBy: string | null; updatedAt: number;
  signupEndpoint: string; embedScript: string; linksReady: boolean;
  dailyLimit: number; perMinute: number; defaultFrom: string; sentToday: number;
  link: { configured: boolean; base: string; readAt: number | null; lists: number | null; programmes: number | null };
}

export interface LinkAudience { key: string; name: string; group: string; source: string; count: number; unsubscribed: number; bounced: number; requiresApproval: boolean }

export type RecipientStatus = 'accepted' | 'failed' | 'unconfirmed' | 'skipped' | 'queued' | 'unsubscribed' | 'bounced' | 'replied';
export interface Report {
  figures: { recipients: number; accepted: number; failed: number; unconfirmed: number; skipped: number; queued: number; unsubscribes: number; replies: number | null; bounces: number | null };
  total: number;
  recipients: { name: string; email: string; status: RecipientStatus; time: number | null; detail: string }[];
}

export interface Programme {
  uid: string; name: string; ownerKind: 'hq' | 'partner'; ownerName: string; status: string; summary: string; tasks: string; timeNeeded: string;
  places: number; picked: number; applicants: number; opensAt: number | null; closesAt: number | null; testingStartsAt: number | null; testingEndsAt: number | null;
  logoUrl: string; studioUrl: string;
}
export interface Applicant { uid: string; name: string; role: string; why: string; availability: string; consented: boolean; status: string; appliedAt: number | null; pickedAt: number | null }
export interface Tester { uid: string; name: string; role: string; email: string; pickedAt: number | null }

export interface Subscriber {
  id: number; email: string; firstName: string; lastName: string; company: string; status: 'pending' | 'subscribed' | 'unsubscribed' | 'bounced' | 'suppressed';
  source: string; consentMethod: string | null; consentAt: number | null; frequency: 'all' | 'essentials'; createdAt: number;
  unsubscribedAt: number | null; lastSentAt: number | null; listIds: number[];
}

export interface ImportResult { added: number; updated: number; pendingConfirmation: number; skipped: number; invalid: number }

export class NewslettersError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body: Record<string, unknown> = {}) { super(message); }
}

export interface NewslettersApi {
  overview(q?: { scope?: 'review'; programme?: string }): Promise<{ issues: Issue[]; lists: NlList[]; you: string; role: string; canManage: boolean }>;
  get(id: number): Promise<{ issue: Issue; checks: string[] }>;
  create(template: TemplateId, opts?: { title?: string; variant?: string; programmeUid?: string; programmeName?: string }): Promise<Issue>;
  update(id: number, expectedVersion: number, change: IssueChange): Promise<Issue>;
  remove(id: number): Promise<void>;
  action(id: number, action: 'review' | 'approve' | 'reject' | 'defer' | 'schedule' | 'cancel' | 'resume' | 'duplicate', body?: Record<string, unknown>): Promise<Issue>;
  test(id: number): Promise<{ to: string }>;
  report(id: number, q?: { q?: string; status?: string }): Promise<Report>;
  senders(): Promise<{ connected: boolean; error: string | null; addresses: { email: string; name: string; primary: boolean }[] }>;
  linkAudiences(): Promise<{ configured: boolean; error: string | null; audiences: LinkAudience[] }>;
  testLink(): Promise<{ ok: boolean; error?: string; settings?: NlSettings }>;
  programmes(): Promise<{ configured: boolean; studioUrl: string; programmes: Programme[]; error?: string }>;
  programme(uid: string): Promise<{ configured: boolean; programme: Programme | null; applicants: Applicant[]; testers: Tester[]; error?: string }>;
  assist(body: { mode: 'subjects' | 'draft' | 'shorten'; text: string; subject?: string; template?: string }): Promise<{ subjects: string[]; text: string; note: string }>;
  settings(): Promise<NlSettings>;
  saveSettings(change: Partial<NlSettings>): Promise<NlSettings>;
  lists(): Promise<NlList[]>;
  createList(l: { name: string; description?: string; public?: boolean; requiresApproval?: boolean }): Promise<NlList[]>;
  updateList(id: number, l: { name?: string; description?: string; public?: boolean; requiresApproval?: boolean }): Promise<NlList[]>;
  removeList(id: number): Promise<NlList[]>;
  subscribers(q: Record<string, string>): Promise<{ total: number; page: number; subscribers: Subscriber[] }>;
  addSubscriber(s: { email: string; firstName?: string; lastName?: string; company?: string; listIds: number[]; attested: boolean }): Promise<ImportResult>;
  importSubscribers(rows: Record<string, string>[], listIds: number[], attested: boolean): Promise<ImportResult>;
  updateSubscriber(id: number, change: Partial<Pick<Subscriber, 'firstName' | 'lastName' | 'company' | 'status' | 'listIds'>>): Promise<Subscriber>;
  removeSubscriber(id: number): Promise<void>;
  exportCsv(): Promise<Blob>;
}

export class HttpNewslettersApi implements NewslettersApi {
  constructor(private token: () => Promise<string>) {}

  private async raw(path: string, init: RequestInit = {}, base = '/api/newsletters'): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(base + path, { ...init, headers });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new NewslettersError(j.error || 'Request failed (' + res.status + ')', res.status, j.code, j as Record<string, unknown>);
    }
    return res;
  }
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> { return (await (await this.raw(path, init)).json()) as T; }
  private send<T>(method: string, path: string, body: unknown = {}) { return this.call<T>(path, { method, body: JSON.stringify(body) }); }

  overview(q: { scope?: 'review'; programme?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
    return this.call<{ issues: Issue[]; lists: NlList[]; you: string; role: string; canManage: boolean }>(qs ? '?' + qs : '');
  }
  get(id: number) { return this.call<{ issue: Issue; checks: string[] }>('/' + id); }
  async create(template: TemplateId, opts: { title?: string; variant?: string; programmeUid?: string; programmeName?: string } = {}) { return (await this.send<{ issue: Issue }>('POST', '', { template, ...opts })).issue; }
  async update(id: number, expectedVersion: number, change: IssueChange) { return (await this.send<{ issue: Issue }>('PUT', '/' + id, { expectedVersion, ...change })).issue; }
  async remove(id: number) { await this.raw('/' + id, { method: 'DELETE' }); }
  async action(id: number, action: string, body: Record<string, unknown> = {}) { return (await this.send<{ issue: Issue }>('POST', '/' + id + '/' + action, body)).issue; }
  test(id: number) { return this.send<{ to: string }>('POST', '/' + id + '/test'); }
  report(id: number, q: { q?: string; status?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
    return this.call<Report>('/' + id + '/report' + (qs ? '?' + qs : ''));
  }
  senders() { return this.call<{ connected: boolean; error: string | null; addresses: { email: string; name: string; primary: boolean }[] }>('/senders'); }
  linkAudiences() { return this.call<{ configured: boolean; error: string | null; audiences: LinkAudience[] }>('/audiences'); }
  testLink() { return this.send<{ ok: boolean; error?: string; settings?: NlSettings }>('POST', '/link'); }
  async programmes() { return (await this.raw('/programmes', {}, '/api/testing')).json() as Promise<{ configured: boolean; studioUrl: string; programmes: Programme[]; error?: string }>; }
  async programme(uid: string) { return (await this.raw('/programmes/' + encodeURIComponent(uid), {}, '/api/testing')).json() as Promise<{ configured: boolean; programme: Programme | null; applicants: Applicant[]; testers: Tester[]; error?: string }>; }
  assist(body: { mode: 'subjects' | 'draft' | 'shorten'; text: string; subject?: string; template?: string }) { return this.send<{ subjects: string[]; text: string; note: string }>('POST', '/assist', body); }
  async settings() { return (await this.call<{ settings: NlSettings }>('/settings')).settings; }
  async saveSettings(change: Partial<NlSettings>) { return (await this.send<{ settings: NlSettings }>('PUT', '/settings', change)).settings; }
  async lists() { return (await this.call<{ lists: NlList[] }>('/lists')).lists; }
  async createList(l: object) { return (await this.send<{ lists: NlList[] }>('POST', '/lists', l)).lists; }
  async updateList(id: number, l: object) { return (await this.send<{ lists: NlList[] }>('PATCH', '/lists/' + id, l)).lists; }
  async removeList(id: number) { return (await this.call<{ lists: NlList[] }>('/lists/' + id, { method: 'DELETE' })).lists; }
  subscribers(q: Record<string, string>) { return this.call<{ total: number; page: number; subscribers: Subscriber[] }>('/subscribers?' + new URLSearchParams(q)); }
  addSubscriber(s: object) { return this.send<ImportResult>('POST', '/subscribers', s); }
  importSubscribers(rows: Record<string, string>[], listIds: number[], attested: boolean) { return this.send<ImportResult>('POST', '/subscribers/import', { rows, listIds, attested }); }
  async updateSubscriber(id: number, change: object) { return (await this.send<{ subscriber: Subscriber }>('PATCH', '/subscribers/' + id, change)).subscriber; }
  async removeSubscriber(id: number) { await this.raw('/subscribers/' + id, { method: 'DELETE' }); }
  async exportCsv() { return (await this.raw('/subscribers.csv')).blob(); }
}

/** The status pill as the design writes it, e.g. "Sending 40 of 120" or "Sent Oct 14". */
export function statusPill(i: Pick<Issue, 'status' | 'scheduledAt' | 'sentAt' | 'sent' | 'failed' | 'skipped' | 'unconfirmed' | 'recipients'>): { label: string; tone: '' | 'warn' | 'accent' | 'ok' | 'danger' } {
  const d = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  switch (i.status) {
    case 'in_review': return { label: 'Awaiting approval', tone: 'warn' };
    case 'approved': return { label: 'Approved', tone: 'accent' };
    case 'scheduled': return { label: 'Scheduled ' + d(i.scheduledAt), tone: 'accent' };
    case 'sending': return { label: 'Sending ' + (i.sent + i.failed + i.skipped + i.unconfirmed) + ' of ' + i.recipients, tone: 'accent' };
    case 'paused': return { label: 'Paused', tone: 'warn' };
    case 'sent': return { label: 'Sent ' + (i.sentAt ? new Date(i.sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''), tone: 'ok' };
    case 'cancelled': return { label: 'Cancelled', tone: '' };
    default: return { label: 'Draft', tone: '' };
  }
}

export const STATUS_LABEL: Record<IssueStatus, string> = {
  draft: 'Draft', in_review: 'Awaiting approval', approved: 'Approved', scheduled: 'Scheduled', sending: 'Sending', paused: 'Paused', sent: 'Sent', cancelled: 'Cancelled'
};
