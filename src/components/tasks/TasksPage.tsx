import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Profile } from '../../types';
import type { MailProvider } from '../../providers/types';
import type { Role } from '../../admin/api';
import type { GithubRepo, Task, TaskNotice, TaskPriority, TaskStatus, TasksApi } from '../../lib/tasksApi';
import { PRIORITY_LABEL, STATUS_LABEL } from '../../lib/tasksApi';
import { errorText } from '../Toast';
import { ApprovalsTab } from './ApprovalsTab';
import { CreateTaskDialog } from './CreateTaskDialog';
import { IssuesTab } from './IssuesTab';
import { TaskPanel } from './TaskPanel';
import { dueText, memberName, type Member } from './TaskForm';
import type { NewslettersApi } from '../../lib/newslettersApi';
import { NewsletterApprovals } from '../newsletters/NewsletterApprovals';

type Tab = 'tasks' | 'issues' | 'approvals' | 'notifications';

interface Props {
  api: TasksApi | null;
  role: Role;
  provider: MailProvider;
  profile: Profile;
  canSuggest: boolean;
  /** Outreach sequences waiting for approval, for admins (null when not known). */
  pendingSequences: () => Promise<number | null>;
  onOpenSequences: () => void;
  onOpenSource: (mailbox: string, threadId: string) => void;
  /** Notifications were read; the sidebar count can refresh. */
  onSeen: () => void;
  /** Open this task first (e.g. from a conversation's task chip). */
  initialTaskId?: number;
  /** Newsletters and testing emails waiting for approval (backend). */
  newsletters?: NewslettersApi | null;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function TasksPage({ api, role, provider, profile, canSuggest, pendingSequences, onOpenSequences, onOpenSource, onSeen, initialTaskId, newsletters }: Props) {
  const superAdmin = role === 'super_admin';
  const [tab, setTab] = useState<Tab>('tasks');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [people, setPeople] = useState<{ members: Member[]; you: string }>({ members: [], you: '' });
  const [repos, setRepos] = useState<{ enabled: boolean; repos: GithubRepo[] } | null>(null);
  const [notices, setNotices] = useState<{ items: TaskNotice[]; seenAt: number; unseen: number } | null>(null);
  const [seqs, setSeqs] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Task | null>(null);
  const [approvalId, setApprovalId] = useState<number | undefined>();
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ q: '', assignee: '', status: 'active', priority: '', due: '' });

  const load = useCallback(() => {
    if (!api) return;
    setErr('');
    api.list().then(setTasks).catch(e => setErr(errorText(e)));
    api.inbox().then(setNotices).catch(() => {});
  }, [api]);

  useEffect(load, [load]);
  useEffect(() => { api?.members().then(setPeople).catch(() => {}); }, [api]);
  useEffect(() => { if (api && superAdmin) api.repos().then(setRepos).catch(() => setRepos({ enabled: false, repos: [] })); }, [api, superAdmin]);
  useEffect(() => { pendingSequences().then(setSeqs).catch(() => setSeqs(null)); }, [pendingSequences]);

  const shown = useMemo(() => {
    const t = f.q.trim().toLowerCase();
    const now = Date.now();
    return (tasks || []).filter(x =>
      (!t || x.title.toLowerCase().includes(t) || x.description.toLowerCase().includes(t) || (x.github && (x.github.repo + '#' + x.github.number).toLowerCase().includes(t))) &&
      (!f.assignee || (f.assignee === 'none' ? !x.assignee : x.assignee === f.assignee)) &&
      (f.status === 'all' || (f.status === 'active' ? x.status !== 'completed' && x.status !== 'cancelled' : x.status === f.status)) &&
      (!f.priority || x.priority === f.priority) &&
      (!f.due || (f.due === 'overdue' ? x.dueAt != null && x.dueAt < now : f.due === 'week' ? x.dueAt != null && x.dueAt < now + 7 * 86_400_000 : x.dueAt == null))
    ).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt - a.updatedAt);
  }, [tasks, f]);

  const changed = (t: Task) => {
    setTasks(l => {
      if (!l) return [t];
      const visible = superAdmin || t.assignee === people.you;
      const rest = l.filter(x => x.id !== t.id);
      return visible ? [t, ...rest] : rest;
    });
    setOpen(superAdmin || t.assignee === people.you ? t : null);
  };
  const openTask = (id: number) => {
    const hit = tasks?.find(t => t.id === id);
    setTab('tasks');
    if (hit) setOpen(hit);
    else api?.get(id).then(t => { setOpen(t); setTasks(l => (l && !l.some(x => x.id === t.id) ? [t, ...l] : l)); }).catch(e => setErr(errorText(e)));
  };

  useEffect(() => {
    if (!api || !initialTaskId) return;
    api.get(initialTaskId).then(setOpen).catch(e => setErr(errorText(e)));
  }, [api, initialTaskId]);

  const showNotices = () => {
    setTab('notifications');
    if (api && notices?.unseen) api.markSeen().then(() => { onSeen(); }).catch(() => {});
  };

  const page = (body: React.ReactNode) => (
    <section className="admin" aria-label="Tasks and approvals">
      <div className="page-inner" style={{ gap: 14 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>Tasks &amp; Approvals</h1>
          <span className="muted">
            {superAdmin
              ? 'Track email work and GitHub issues, assign them to the team, and review actions that need approval.'
              : 'Tasks assigned to you, and actions waiting for approval.'}
          </span>
        </div>
        {body}
      </div>
    </section>
  );

  if (!api) return page(<div className="card panel"><span className="muted">Tasks &amp; Approvals need the Axal VC Mail backend.</span></div>);

  const tabs: [Tab, string][] = [['tasks', superAdmin ? 'Tasks' : 'My tasks'], ...(superAdmin ? [['issues', 'GitHub issues'] as [Tab, string]] : []), ['approvals', 'Approvals'], ['notifications', 'Notifications' + (notices?.unseen ? ' · ' + notices.unseen : '')]];

  return page(
    <>
      <div className="an-tabs" role="tablist" aria-label="Tasks sections">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={'btn sm' + (tab === k ? ' primary' : ' ghost')} onClick={() => (k === 'notifications' ? showNotices() : setTab(k))}>{l}</button>
        ))}
      </div>
      {err && <div className="notice warn" role="alert">{err} <button className="link-btn" onClick={load}>Try again</button></div>}

      {tab === 'tasks' && (
        <>
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <input className="input" type="search" aria-label="Search tasks" placeholder="Search tasks" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} style={{ flex: '1 1 200px' }} />
            {superAdmin && (
              <select className="input" aria-label="Assignee" value={f.assignee} onChange={e => setF({ ...f, assignee: e.target.value })}>
                <option value="">Everyone</option>
                <option value="none">Unassigned</option>
                {people.members.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
              </select>
            )}
            <select className="input" aria-label="Status" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
              <option value="active">Not done</option>
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              <option value="all">All statuses</option>
            </select>
            <select className="input" aria-label="Priority" value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}>
              <option value="">Any priority</option>
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
            <select className="input" aria-label="Due" value={f.due} onChange={e => setF({ ...f, due: e.target.value })}>
              <option value="">Any due date</option>
              <option value="overdue">Overdue</option>
              <option value="week">Due within a week</option>
              <option value="none">No due date</option>
            </select>
            <button className="btn ghost sm" aria-label="Refresh" onClick={load}>↻</button>
            {superAdmin && <button className="btn primary sm" onClick={() => setCreating(true)}>New task</button>}
          </div>

          {open && (
            <TaskPanel key={open.id} api={api} task={open} members={people.members} you={people.you} repos={repos?.repos ?? null} superAdmin={superAdmin}
              onChanged={changed} onClose={() => setOpen(null)} onOpenSource={onOpenSource}
              onRemoved={id => { setTasks(l => l && l.filter(x => x.id !== id)); setOpen(null); }} />
          )}

          {!tasks && !err && <div className="card panel an-loading"><div className="spinner" /> Loading…</div>}
          {tasks && (shown.length ? (
            <div className="card table table-scroll" aria-label="Task list">
              <div className="trow tasks head"><span>TASK</span><span>ASSIGNEE</span><span>PRIORITY</span><span>STATUS</span><span>DUE</span></div>
              {shown.map(t => (
                <button key={t.id} className={'trow tasks link-like' + (open?.id === t.id ? ' on' : '')} onClick={() => setOpen(t)}>
                  <span className="user-cell">
                    <b>{t.title}</b>
                    <span>{[t.github ? t.github.repo + '#' + t.github.number : '', t.source ? '✉ ' + (t.source.subject || 'email') : '', t.createdVia === 'ai_suggested' ? 'AI-suggested' : ''].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                  <span className="muted">{memberName(people.members, t.assignee)}</span>
                  <span><span className={'pill' + (t.priority === 'urgent' ? ' danger' : t.priority === 'high' ? ' warn' : '')}>{PRIORITY_LABEL[t.priority]}</span></span>
                  <span className="muted">{STATUS_LABEL[t.status]}</span>
                  <span className={t.dueAt != null && t.dueAt < Date.now() && t.status !== 'completed' && t.status !== 'cancelled' ? 'tone-danger' : 'muted'}>{dueText(t.dueAt).replace(/^Due /, '') || '—'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="card panel"><span className="faint">
              {tasks.length ? 'No tasks match these filters.' : superAdmin ? 'No tasks yet. Create one here, from an email (Create task in the reader), or track a GitHub issue.' : 'Nothing is assigned to you.'}
            </span></div>
          ))}
        </>
      )}

      {tab === 'issues' && superAdmin && (
        <IssuesTab api={api} superAdmin={superAdmin} repos={repos?.repos ?? null} githubEnabled={repos ? repos.enabled : true}
          onReposChanged={r => setRepos(x => ({ enabled: x?.enabled ?? true, repos: r }))}
          onTracked={t => setTasks(l => (l ? [t, ...l] : [t]))} onOpenTask={openTask} />
      )}

      {tab === 'approvals' && newsletters && <NewsletterApprovals api={newsletters} you={people.you} />}
      {tab === 'approvals' && (
        <ApprovalsTab api={api} members={people.members} you={people.you} provider={provider} profile={profile}
          pendingSequences={seqs} onOpenSequences={onOpenSequences} initialId={approvalId} onChanged={() => api.inbox().then(setNotices).catch(() => {})} />
      )}

      {tab === 'notifications' && (
        <div className="card panel" aria-label="Notifications">
          {!notices ? <span className="faint">Loading…</span> : !notices.items.length ? <span className="faint">Nothing new: assignments, due tasks and approval decisions show up here.</span> : notices.items.map((n, i) => (
            <button key={i} className="an-row" onClick={() => {
              if (n.taskId) openTask(n.taskId);
              else if (n.approvalId) { setApprovalId(n.approvalId); setTab('approvals'); }
            }}>
              <span className="an-row-main">
                <b>{n.at > notices.seenAt ? '● ' : ''}{n.text}</b>
                <span>{new Date(n.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <CreateTaskDialog api={api} canSuggest={canSuggest} onClose={() => setCreating(false)}
          onCreated={made => { setCreating(false); setTasks(l => [...made, ...(l || [])]); if (made.length === 1) setOpen(made[0]); }} />
      )}
    </>
  );
}
