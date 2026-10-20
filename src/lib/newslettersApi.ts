/** Client for the Worker's Newsletters API (/api/newsletters). */

import type { Block, TemplateId } from './newsletter/types';

export type IssueStatus = 'draft' | 'in_review' | 'approved' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled';

export interface NlList { id: number; key: string; name: string; description: string; public: boolean; requiresApproval: boolean; subscribed: number; lastSent: number | null }

export interface Issue {
  id: number; title: string; template: TemplateId; subject: string; preheader: string; edition: string; listIds: number[];
  fromEmail: string; fromName: string; signoff: { title: string; calendarUrl: string }; status: IssueStatus; version: number; contentHash: string;
  approvalRequired: boolean; approved: boolean; approvedBy: string | null; approvedAt: number | null; reviewRequestedBy: string | null;
  senderMember: string | null; scheduledAt: number | null; startedAt: number | null; sentAt: number | null;
  recipients: number; sent: number; failed: number; queued: number; skipped: number; lastError: string | null;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number;
  canEdit: boolean; canApprove: boolean; canSchedule: boolean;
  /** Only on a single issue. */
  blocks?: Block[];
  audience?: number;
  excluded?: { unsubscribed: number; bounced: number; suppressed: number; pending: number };
  unsubscribes?: number;
}

export type IssueChange = Partial<Pick<Issue, 'title' | 'subject' | 'preheader' | 'edition' | 'listIds' | 'fromEmail' | 'fromName' | 'signoff' | 'blocks'>>;

export interface NlSettings {
  postalAddress: string; disclaimer: string; fromName: string; systemSender: string | null; systemFrom: string;
  doubleOptIn: boolean; batchSize: number; allowedOrigins: string[]; updatedBy: string | null; updatedAt: number;
  signupEndpoint: string; embedScript: string; linksReady: boolean;
}

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
  overview(): Promise<{ issues: Issue[]; lists: NlList[]; you: string; role: string; canManage: boolean }>;
  get(id: number): Promise<{ issue: Issue; checks: string[] }>;
  create(template: TemplateId, title?: string): Promise<Issue>;
  update(id: number, expectedVersion: number, change: IssueChange): Promise<Issue>;
  remove(id: number): Promise<void>;
  action(id: number, action: 'review' | 'approve' | 'reject' | 'schedule' | 'cancel' | 'resume' | 'duplicate', body?: Record<string, unknown>): Promise<Issue>;
  test(id: number): Promise<{ to: string }>;
  report(id: number): Promise<{ failures: { email: string; error: string }[] }>;
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

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/newsletters' + path, { ...init, headers });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new NewslettersError(j.error || 'Request failed (' + res.status + ')', res.status, j.code, j as Record<string, unknown>);
    }
    return res;
  }
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> { return (await (await this.raw(path, init)).json()) as T; }
  private send<T>(method: string, path: string, body: unknown = {}) { return this.call<T>(path, { method, body: JSON.stringify(body) }); }

  overview() { return this.call<{ issues: Issue[]; lists: NlList[]; you: string; role: string; canManage: boolean }>(''); }
  get(id: number) { return this.call<{ issue: Issue; checks: string[] }>('/' + id); }
  async create(template: TemplateId, title?: string) { return (await this.send<{ issue: Issue }>('POST', '', { template, title })).issue; }
  async update(id: number, expectedVersion: number, change: IssueChange) { return (await this.send<{ issue: Issue }>('PUT', '/' + id, { expectedVersion, ...change })).issue; }
  async remove(id: number) { await this.raw('/' + id, { method: 'DELETE' }); }
  async action(id: number, action: string, body: Record<string, unknown> = {}) { return (await this.send<{ issue: Issue }>('POST', '/' + id + '/' + action, body)).issue; }
  test(id: number) { return this.send<{ to: string }>('POST', '/' + id + '/test'); }
  report(id: number) { return this.call<{ failures: { email: string; error: string }[] }>('/' + id + '/report'); }
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

export const STATUS_LABEL: Record<IssueStatus, string> = {
  draft: 'Draft', in_review: 'Awaiting approval', approved: 'Approved', scheduled: 'Scheduled', sending: 'Sending', paused: 'Paused', sent: 'Sent', cancelled: 'Cancelled'
};
