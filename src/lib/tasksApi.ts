/** Client for the Worker's Tasks (/api/tasks) and approval queue (/api/approvals) APIs. */

import type { Person } from '../types';

export type TaskStatus = 'open' | 'in_progress' | 'waiting' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskVia = 'manual' | 'ai_suggested' | 'automation' | 'github';

export interface Task {
  id: number;
  title: string;
  description: string;
  createdBy: string;
  assignee: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: number | null;
  createdVia: TaskVia;
  source: { mailbox: string; threadId: string; subject: string } | null;
  github: { repo: string; number: number; url: string } | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface TaskInput {
  title: string;
  description?: string;
  assignee?: string | null;
  priority?: TaskPriority;
  dueAt?: number | null;
  createdVia?: 'manual' | 'ai_suggested' | 'automation';
  sourceMailbox?: string;
  sourceThreadId?: string;
  sourceSubject?: string;
}

export type TaskChange = Partial<Pick<Task, 'title' | 'description' | 'assignee' | 'priority' | 'status' | 'dueAt'>>;

export interface TaskEvent { actor: string; action: string; detail: string; at: number }

export interface GithubIssue {
  repo: string; number: number; title: string; state: 'open' | 'closed'; url: string; labels: string[]; assignees: string[]; author: string;
  createdAt: number; updatedAt: number;
  /** Tracked by a task: its id when it is one of yours, else null. */
  tracked: { taskId: number | null } | null;
}

export interface GithubRepo { fullName: string; ok: boolean; private: boolean | null; url: string; error: string | null }

export interface Suggestion { title: string; detail: string; kind: 'request' | 'commitment' | 'follow_up'; quote: string; quoteVerified: boolean; dueText: string }

export interface TaskNotice { kind: string; text: string; at: number; taskId?: number; approvalId?: number }

export type ApprovalKind = 'email_draft' | 'bulk_campaign' | 'shared_reply';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'deferred' | 'executing' | 'executed' | 'failed' | 'withdrawn';

/** What an email approval carries: exactly what will be sent. */
export interface ApprovalMessage {
  identity: { id: string; addr: string; name: string };
  to: Person[]; cc: Person[]; bcc: Person[];
  subject: string; html: string; text: string;
  priority: 'Normal' | 'High' | 'Low';
  reply: { threadId: string; messageIdHeader: string; references: string; rootId: string } | null;
}

export interface ApprovalCampaign {
  identity: { id: string; addr: string; name: string };
  optout: boolean;
  messages: { to: Person; persona: string; subject: string; text: string }[];
}

export interface Approval {
  id: number;
  kind: ApprovalKind;
  title: string;
  payload: ApprovalMessage | ApprovalCampaign;
  contentHash: string;
  version: number;
  status: ApprovalStatus;
  requester: string;
  reviewer: string | null;
  note: string;
  mailbox: string | null;
  sourceThreadId: string | null;
  approvedCurrent: boolean;
  requestedAt: number;
  decidedAt: number | null;
  executedBy: string | null;
  executedAt: number | null;
  result: string;
  canReview: boolean;
  canExecute: boolean;
  canEdit: boolean;
}

export interface ApprovalEvent { actor: string; action: string; version: number; contentHash: string; note: string; at: number }

/** The server's error, with its code (and any extra fields, e.g. `current` on a conflict). */
export class TasksError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly data: Record<string, unknown> = {}) { super(message); }
}

export interface TasksApi {
  list(q?: Record<string, string>): Promise<Task[]>;
  get(id: number): Promise<Task>;
  create(t: TaskInput): Promise<Task>;
  update(id: number, expectedVersion: number, change: TaskChange): Promise<Task>;
  remove(id: number): Promise<void>;
  events(id: number): Promise<TaskEvent[]>;
  members(): Promise<{ members: { email: string; name: string }[]; you: string }>;
  inbox(): Promise<{ items: TaskNotice[]; seenAt: number; unseen: number }>;
  markSeen(): Promise<void>;
  suggest(thread: unknown, userName?: string): Promise<Suggestion[]>;

  repos(): Promise<{ enabled: boolean; repos: GithubRepo[] }>;
  editRepos(change: { add?: string; remove?: string }): Promise<{ enabled: boolean; repos: GithubRepo[] }>;
  issues(q?: { repo?: string; state?: 'open' | 'closed' | 'all' }): Promise<{ repos: { repo: string; private: boolean | null; error: string | null; count: number }[]; issues: GithubIssue[] }>;
  track(repo: string, number: number, assignee?: string | null): Promise<Task>;
  openIssue(id: number, repo: string, confirmPublic: boolean, includeDescription: boolean): Promise<Task>;
  linkIssue(id: number, repo: string, number: number): Promise<Task>;
  unlinkIssue(id: number): Promise<Task>;
  setIssueState(id: number, state: 'open' | 'closed'): Promise<void>;
  /** The task's issue as it is on GitHub now. */
  issue(id: number): Promise<Omit<GithubIssue, 'tracked'> | null>;

  approvals(scope: 'queue' | 'mine' | 'history'): Promise<Approval[]>;
  approval(id: number): Promise<Approval>;
  approvalEvents(id: number): Promise<ApprovalEvent[]>;
  requestApproval(r: { kind: ApprovalKind; title?: string; payload: ApprovalMessage | ApprovalCampaign; mailbox?: string; sourceThreadId?: string }): Promise<Approval>;
  decide(a: Approval, decision: 'approve' | 'reject' | 'defer', note?: string): Promise<Approval>;
  editApproval(a: Approval, payload: ApprovalMessage | ApprovalCampaign, title?: string): Promise<Approval>;
  withdraw(id: number): Promise<Approval>;
  /** Claims the send (once, for the approved content) and returns what to send. */
  claim(a: Approval): Promise<{ approval: Approval; payload: ApprovalMessage | ApprovalCampaign }>;
  finish(id: number, ok: boolean, detail: string): Promise<Approval>;
}

export class HttpTasksApi implements TasksApi {
  constructor(private token: () => Promise<string>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api' + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!res.ok) throw new TasksError(j.error || 'Request failed (' + res.status + ')', res.status, j.code, j as Record<string, unknown>);
    return j;
  }
  private send<T>(method: string, path: string, body: unknown = {}) { return this.call<T>(path, { method, body: JSON.stringify(body) }); }

  async list(q: Record<string, string> = {}) { return (await this.call<{ tasks: Task[] }>('/tasks?' + new URLSearchParams(q))).tasks; }
  async get(id: number) { return (await this.call<{ task: Task }>('/tasks/' + id)).task; }
  async create(t: TaskInput) { return (await this.send<{ task: Task }>('POST', '/tasks', t)).task; }
  async update(id: number, expectedVersion: number, change: TaskChange) { return (await this.send<{ task: Task }>('PATCH', '/tasks/' + id, { expectedVersion, ...change })).task; }
  async remove(id: number) { await this.call('/tasks/' + id, { method: 'DELETE' }); }
  async events(id: number) { return (await this.call<{ events: TaskEvent[] }>('/tasks/' + id + '/events')).events; }
  members() { return this.call<{ members: { email: string; name: string }[]; you: string }>('/tasks/members'); }
  inbox() { return this.call<{ items: TaskNotice[]; seenAt: number; unseen: number }>('/tasks/inbox'); }
  async markSeen() { await this.send('POST', '/tasks/inbox/seen'); }
  async suggest(thread: unknown, userName?: string) { return (await this.send<{ suggestions: Suggestion[] }>('POST', '/tasks/suggest', { thread, userName })).suggestions; }

  repos() { return this.call<{ enabled: boolean; repos: GithubRepo[] }>('/tasks/github/repos'); }
  editRepos(change: { add?: string; remove?: string }) { return this.send<{ enabled: boolean; repos: GithubRepo[] }>('PUT', '/tasks/github/repos', change); }
  issues(q: { repo?: string; state?: 'open' | 'closed' | 'all' } = {}) {
    return this.call<{ repos: { repo: string; private: boolean | null; error: string | null; count: number }[]; issues: GithubIssue[] }>('/tasks/github/issues?' + new URLSearchParams(q as Record<string, string>));
  }
  async track(repo: string, number: number, assignee?: string | null) { return (await this.send<{ task: Task }>('POST', '/tasks/github/track', { repo, number, ...(assignee !== undefined ? { assignee } : {}) })).task; }
  async openIssue(id: number, repo: string, confirmPublic: boolean, includeDescription: boolean) {
    return (await this.send<{ task: Task }>('POST', '/tasks/' + id + '/github', { repo, confirmPublic, includeDescription })).task;
  }
  async linkIssue(id: number, repo: string, number: number) { return (await this.send<{ task: Task }>('POST', '/tasks/' + id + '/github/link', { repo, number })).task; }
  async unlinkIssue(id: number) { return (await this.call<{ task: Task }>('/tasks/' + id + '/github', { method: 'DELETE' })).task; }
  async setIssueState(id: number, state: 'open' | 'closed') { await this.send('POST', '/tasks/' + id + '/github/state', { state }); }
  async issue(id: number) { return (await this.call<{ issue: Omit<GithubIssue, 'tracked'> | null }>('/tasks/' + id + '/github')).issue; }

  async approvals(scope: 'queue' | 'mine' | 'history') { return (await this.call<{ approvals: Approval[] }>('/approvals?scope=' + scope)).approvals; }
  async approval(id: number) { return (await this.call<{ approval: Approval }>('/approvals/' + id)).approval; }
  async approvalEvents(id: number) { return (await this.call<{ events: ApprovalEvent[] }>('/approvals/' + id + '/events')).events; }
  async requestApproval(r: { kind: ApprovalKind; title?: string; payload: ApprovalMessage | ApprovalCampaign; mailbox?: string; sourceThreadId?: string }) {
    return (await this.send<{ approval: Approval }>('POST', '/approvals', r)).approval;
  }
  async decide(a: Approval, decision: 'approve' | 'reject' | 'defer', note = '') {
    return (await this.send<{ approval: Approval }>('POST', '/approvals/' + a.id + '/decide', { decision, note, version: a.version, contentHash: a.contentHash })).approval;
  }
  async editApproval(a: Approval, payload: ApprovalMessage | ApprovalCampaign, title?: string) {
    return (await this.send<{ approval: Approval }>('PUT', '/approvals/' + a.id, { payload, title, version: a.version, contentHash: a.contentHash })).approval;
  }
  async withdraw(id: number) { return (await this.send<{ approval: Approval }>('POST', '/approvals/' + id + '/withdraw')).approval; }
  claim(a: Approval) { return this.send<{ approval: Approval; payload: ApprovalMessage | ApprovalCampaign }>('POST', '/approvals/' + a.id + '/execute', { contentHash: a.contentHash }); }
  async finish(id: number, ok: boolean, detail: string) { return (await this.send<{ approval: Approval }>('POST', '/approvals/' + id + '/result', { ok, detail })).approval; }
}

export const STATUS_LABEL: Record<TaskStatus, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', completed: 'Completed', cancelled: 'Cancelled' };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const VIA_LABEL: Record<TaskVia, string> = { manual: 'Manual', ai_suggested: 'AI-suggested', automation: 'From an automation', github: 'From GitHub' };
export const KIND_LABEL: Record<ApprovalKind, string> = { email_draft: 'Email', bulk_campaign: 'Bulk campaign', shared_reply: 'Shared-inbox reply' };
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', deferred: 'Deferred', executing: 'Sending', executed: 'Sent', failed: 'Failed', withdrawn: 'Withdrawn'
};
