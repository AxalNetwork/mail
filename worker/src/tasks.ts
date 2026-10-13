import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';
import { mentionable } from './notes';
import * as github from './github';
import { suggestTasks } from './assistant';
import { inboxForApprovals } from './approvals';

/**
 * Tasks: email-related work, optionally linked to an issue in one of the
 * firm's GitHub repositories (task_repos).
 *
 * Who can do what (tasks are run by the super admins):
 * - a super admin creates tasks, sees and edits all of them, assigns them to
 *   any active member (member, admin or super admin) and deletes them;
 * - a super admin reads the issues of the listed repositories, tracks one as
 *   a task, and opens, links, closes or reopens a task's GitHub issue, always
 *   as an explicit action (completing a task never closes its issue);
 * - a super admin chooses the repositories;
 * - any other member sees only the tasks assigned to them, and changes only
 *   their status (start, waiting, complete); they see the issue link, nothing more.
 */

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES = ['open', 'in_progress', 'waiting', 'completed', 'cancelled'] as const;
const VIA = ['manual', 'ai_suggested', 'automation'] as const;
type Status = typeof STATUSES[number];
const DONE: Status[] = ['completed', 'cancelled'];
const THREAD_RE = /^[\w-]{1,64}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const oneOf = <T extends string>(list: readonly T[], v: unknown, field: string): T => {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new HttpError(400, field + ' must be one of ' + list.join(', '));
  return v as T;
};

interface Row {
  id: number; title: string; description: string; created_by: string; assignee: string | null; priority: string; status: Status;
  due_at: number | null; created_via: string; source_mailbox: string; source_thread_id: string; source_subject: string;
  github_repo: string | null; github_number: number | null; github_url: string | null;
  version: number; created_at: number; updated_at: number; completed_at: number | null;
}

const out = (r: Row) => ({
  id: r.id, title: r.title, description: r.description, createdBy: r.created_by, assignee: r.assignee, priority: r.priority, status: r.status,
  dueAt: r.due_at, createdVia: r.created_via,
  source: r.source_thread_id ? { mailbox: r.source_mailbox, threadId: r.source_thread_id, subject: r.source_subject } : null,
  github: r.github_repo && r.github_number ? { repo: r.github_repo, number: r.github_number, url: r.github_url || '' } : null,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at
});
export type TaskOut = ReturnType<typeof out>;

const isSuper = (u: User) => u.role === 'super_admin';
const canSee = (u: User, r: Row) => isSuper(u) || r.assignee === u.memberEmail;
function requireSuper(u: User, what: string) {
  if (!isSuper(u)) throw new HttpError(403, 'Only a super admin ' + what + '.', 'super_admin_only');
}

async function visible(env: Env, user: User, id: number): Promise<Row> {
  const r = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<Row>();
  // Someone else's task is "not found", not "forbidden": its existence is private too.
  if (!r || !canSee(user, r)) throw new HttpError(404, 'Task not found');
  return r;
}

async function event(env: Env, id: number, actor: string, action: string, detail = '') {
  await env.DB.prepare('INSERT INTO task_events (task_id, actor, action, detail, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, actor, action, detail, Date.now()).run();
}

async function member(env: Env, v: unknown): Promise<string | null> {
  if (v === null || v === undefined || v === '') return null;
  const email = str(v, 254).toLowerCase();
  if (!(await mentionable(env)).some(m => m.email === email)) throw new HttpError(400, 'Assign the task to an active Axal VC member.');
  return email;
}

function due(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < Date.UTC(2000, 0, 1) || n > Date.UTC(2100, 0, 1)) throw new HttpError(400, 'dueAt must be a date');
  return Math.floor(n);
}

// ---------- tasks ----------

interface TaskIn {
  title?: unknown; description?: unknown; assignee?: unknown; priority?: unknown; status?: unknown; dueAt?: unknown; createdVia?: unknown;
  sourceMailbox?: unknown; sourceThreadId?: unknown; sourceSubject?: unknown; expectedVersion?: unknown;
}

async function create(env: Env, user: User, b: TaskIn): Promise<TaskOut> {
  requireSuper(user, 'creates tasks');
  const title = str(b.title, 200).replace(/\n/g, ' ');
  if (title.length < 2) throw new HttpError(400, 'Give the task a title.');
  const assignee = b.assignee === undefined ? user.memberEmail : await member(env, b.assignee);
  const thread = str(b.sourceThreadId, 64);
  if (thread && !THREAD_RE.test(thread)) throw new HttpError(400, 'Not a Gmail thread id');
  const via = b.createdVia === undefined ? 'manual' : oneOf(VIA, b.createdVia, 'createdVia');
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO tasks (title, description, created_by, assignee, priority, status, due_at, created_via, source_mailbox, source_thread_id, source_subject, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`)
    .bind(title, str(b.description, 5000), user.memberEmail, assignee, b.priority === undefined ? 'normal' : oneOf(PRIORITIES, b.priority, 'priority'),
      b.status === undefined ? 'open' : oneOf(STATUSES.filter(s => !DONE.includes(s)), b.status, 'status'), due(b.dueAt), via,
      thread ? str(b.sourceMailbox, 254).toLowerCase() : '', thread, thread ? str(b.sourceSubject, 300) : '', now).run();
  const id = Number(r.meta.last_row_id);
  await event(env, id, user.memberEmail, 'created', via);
  if (assignee && assignee !== user.memberEmail) await event(env, id, user.memberEmail, 'assigned', assignee);
  return out(await visible(env, user, id));
}

async function update(env: Env, user: User, r: Row, b: TaskIn): Promise<TaskOut> {
  if (Number(b.expectedVersion) !== r.version) {
    throw new HttpError(409, 'Someone changed this task first. Review it and try again.', 'task_conflict', { current: out(r) });
  }
  if (!isSuper(user)) {
    // The assignee updates progress; everything else is the super admin's.
    const other = (['title', 'description', 'priority', 'dueAt', 'assignee'] as const).filter(k => b[k] !== undefined);
    if (other.length) throw new HttpError(403, 'Only a super admin changes a task’s ' + other.join(', ') + '. You can change its status.', 'super_admin_only');
  }
  const next = { ...r };
  const changes: [string, string][] = [];
  if (b.title !== undefined) {
    const t = str(b.title, 200).replace(/\n/g, ' ');
    if (t.length < 2) throw new HttpError(400, 'Give the task a title.');
    if (t !== r.title) { next.title = t; changes.push(['edited', 'title']); }
  }
  if (b.description !== undefined) {
    const d = str(b.description, 5000);
    if (d !== r.description) { next.description = d; changes.push(['edited', 'description']); }
  }
  if (b.priority !== undefined) {
    const p = oneOf(PRIORITIES, b.priority, 'priority');
    if (p !== r.priority) { next.priority = p; changes.push(['priority', p]); }
  }
  if (b.dueAt !== undefined) {
    const d = due(b.dueAt);
    if (d !== r.due_at) { next.due_at = d; changes.push(['due', d == null ? '' : String(d)]); }
  }
  if (b.assignee !== undefined) {
    const a = await member(env, b.assignee);
    if (a !== r.assignee) { next.assignee = a; changes.push(a ? ['assigned', a] : ['unassigned', r.assignee || '']); }
  }
  if (b.status !== undefined) {
    const s = oneOf(STATUSES, b.status, 'status');
    if (s !== r.status) {
      next.status = s;
      next.completed_at = DONE.includes(s) ? Date.now() : null;
      changes.push(['status', s]);
    }
  }
  if (!changes.length) return out(r);
  const res = await env.DB.prepare(`UPDATE tasks SET title = ?2, description = ?3, priority = ?4, due_at = ?5, assignee = ?6, status = ?7, completed_at = ?8,
    version = version + 1, updated_at = ?9 WHERE id = ?1 AND version = ?10`)
    .bind(r.id, next.title, next.description, next.priority, next.due_at, next.assignee, next.status, next.completed_at, Date.now(), r.version).run();
  if (!res.meta.changes) throw new HttpError(409, 'Someone changed this task first. Review it and try again.', 'task_conflict');
  for (const [a, d] of changes) await event(env, r.id, user.memberEmail, a, d);
  // An assignee who is taken off keeps no access; the response says what the caller can still see.
  const after = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(r.id).first<Row>();
  return out(after!);
}

async function list(env: Env, user: User, q: URLSearchParams): Promise<TaskOut[]> {
  // Members see what is assigned to them; super admins see everything.
  const where = [isSuper(user) ? '1 = 1' : 'assignee = ?1'];
  const args: unknown[] = isSuper(user) ? [] : [user.memberEmail];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\?(?!\d)/, '?' + args.length)); };
  const scope = q.get('scope');
  if (scope === 'assigned') add('assignee = ?', user.memberEmail);
  if (scope === 'created') add('created_by = ?', user.memberEmail);
  const assignee = q.get('assignee');
  if (assignee === 'none') where.push('assignee IS NULL');
  else if (assignee) add('assignee = ?', assignee.toLowerCase());
  const status = q.get('status');
  if (status === 'active') where.push("status NOT IN ('completed', 'cancelled')");
  else if (status) add('status = ?', oneOf(STATUSES, status, 'status'));
  const priority = q.get('priority');
  if (priority) add('priority = ?', oneOf(PRIORITIES, priority, 'priority'));
  const dueQ = q.get('due');
  const now = Date.now();
  if (dueQ === 'overdue') { add('due_at < ?', now); where.push("status NOT IN ('completed', 'cancelled')"); }
  else if (dueQ === 'week') { add('due_at <= ?', now + 7 * 86_400_000); }
  else if (dueQ === 'none') where.push('due_at IS NULL');
  const thread = q.get('thread');
  if (thread) { add('source_thread_id = ?', thread); add('source_mailbox = ?', (q.get('mailbox') || '').toLowerCase()); }
  const rows = (await env.DB.prepare('SELECT * FROM tasks WHERE ' + where.join(' AND ') +
    " ORDER BY CASE WHEN status IN ('completed', 'cancelled') THEN 1 ELSE 0 END, due_at IS NULL, due_at, updated_at DESC LIMIT 500")
    .bind(...args).all<Row>()).results;
  return rows.map(out);
}

// ---------- GitHub ----------

async function repos(env: Env): Promise<string[]> {
  return (await env.DB.prepare('SELECT full_name FROM task_repos ORDER BY full_name COLLATE NOCASE').all<{ full_name: string }>()).results.map(r => r.full_name);
}

async function listed(env: Env, v: unknown): Promise<string> {
  if (!github.validRepo(v)) throw new HttpError(400, 'repo must be owner/name');
  const r = await env.DB.prepare('SELECT full_name FROM task_repos WHERE full_name = ?1').bind(v).first<{ full_name: string }>();
  if (!r) throw new HttpError(400, v + ' is not one of the repositories in Tasks. A super admin adds it.');
  return r.full_name;
}

function issueNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new HttpError(400, 'number must be an issue number');
  return n;
}

async function linkIssue(env: Env, user: User, r: Row, repo: string, issue: github.IssueOut): Promise<TaskOut> {
  const taken = await env.DB.prepare('SELECT id FROM tasks WHERE github_repo = ?1 AND github_number = ?2').bind(repo, issue.number).first<{ id: number }>();
  if (taken && taken.id !== r.id) throw new HttpError(409, repo + '#' + issue.number + ' is already tracked by another task.', 'issue_tracked');
  await env.DB.prepare('UPDATE tasks SET github_repo = ?2, github_number = ?3, github_url = ?4, version = version + 1, updated_at = ?5 WHERE id = ?1')
    .bind(r.id, repo, issue.number, issue.url, Date.now()).run();
  await event(env, r.id, user.memberEmail, 'github_linked', repo + '#' + issue.number);
  return out(await visible(env, user, r.id));
}

/** Open an issue for the task. A public repository needs `confirmPublic`, and email addresses are removed. */
async function openIssue(env: Env, user: User, r: Row, b: { repo?: unknown; confirmPublic?: unknown; includeDescription?: unknown }) {
  if (r.github_repo) throw new HttpError(409, 'This task already has a GitHub issue.', 'issue_tracked');
  const repo = await listed(env, b.repo);
  const info = await github.repoInfo(env, repo, true);
  if (!info.ok) throw new HttpError(502, info.error || 'GitHub can’t be reached for ' + repo + '.', 'github_no_access');
  const isPublic = info.private === false;
  if (isPublic && b.confirmPublic !== true) {
    throw new HttpError(409, repo + ' is public: anyone can read the issue. Confirm to open it there.', 'repo_public');
  }
  const clean = (s: string) => (isPublic ? github.redactEmails(s) : s);
  const body = [
    b.includeDescription === false ? '' : clean(r.description),
    '',
    '---',
    '_Tracked in Axal VC Mail (task ' + r.id + ')' + (r.source_thread_id ? ', from an email' : '') + '._'
  ].join('\n').trim();
  const issue = await github.createIssue(env, repo, clean(r.title), body);
  return linkIssue(env, user, r, repo, issue);
}

async function trackIssue(env: Env, user: User, b: { repo?: unknown; number?: unknown; assignee?: unknown; priority?: unknown }) {
  const repo = await listed(env, b.repo);
  const issue = await github.getIssue(env, repo, issueNumber(b.number));
  const taken = await env.DB.prepare('SELECT id, created_by, assignee FROM tasks WHERE github_repo = ?1 AND github_number = ?2').bind(repo, issue.number)
    .first<{ id: number; created_by: string; assignee: string | null }>();
  if (taken) {
    const mine = isSuper(user);
    throw new HttpError(409, repo + '#' + issue.number + ' is already tracked' + (mine ? ' (task ' + taken.id + ').' : ' by another member.'), 'issue_tracked', mine ? { taskId: taken.id } : {});
  }
  const now = Date.now();
  const assignee = b.assignee === undefined ? user.memberEmail : await member(env, b.assignee);
  const res = await env.DB.prepare(`INSERT INTO tasks (title, description, created_by, assignee, priority, status, created_via, github_repo, github_number, github_url, created_at, updated_at, completed_at)
    VALUES (?1, '', ?2, ?3, ?4, ?5, 'github', ?6, ?7, ?8, ?9, ?9, ?10)`)
    .bind(issue.title.slice(0, 200), user.memberEmail, assignee, b.priority === undefined ? 'normal' : oneOf(PRIORITIES, b.priority, 'priority'),
      issue.state === 'closed' ? 'completed' : 'open', repo, issue.number, issue.url, now, issue.state === 'closed' ? now : null).run();
  const id = Number(res.meta.last_row_id);
  await event(env, id, user.memberEmail, 'created', 'github:' + repo + '#' + issue.number);
  if (assignee && assignee !== user.memberEmail) await event(env, id, user.memberEmail, 'assigned', assignee);
  return out(await visible(env, user, id));
}

async function issues(env: Env, q: URLSearchParams) {
  const state = q.get('state') === 'closed' ? 'closed' : q.get('state') === 'all' ? 'all' : 'open';
  const only = q.get('repo');
  const names = only ? [await listed(env, only)] : await repos(env);
  const results = await Promise.all(names.map(async repo => {
    try {
      const [info, list] = await Promise.all([github.repoInfo(env, repo), github.listIssues(env, repo, state)]);
      return { repo, private: info.private, issues: list, error: null as string | null };
    } catch (e) {
      return { repo, private: null, issues: [] as github.IssueOut[], error: e instanceof Error ? e.message : String(e) };
    }
  }));
  // Which issues are tracked, and whether by a task the caller can open.
  const tracked = (await env.DB.prepare('SELECT id, github_repo, github_number FROM tasks WHERE github_repo IS NOT NULL')
    .all<{ id: number; github_repo: string; github_number: number }>()).results;
  const byKey = new Map(tracked.map(t => [t.github_repo.toLowerCase() + '#' + t.github_number, t]));
  return {
    repos: results.map(r => ({ repo: r.repo, private: r.private, error: r.error, count: r.issues.length })),
    issues: results.flatMap(r => r.issues.map(i => {
      const t = byKey.get(r.repo.toLowerCase() + '#' + i.number);
      return { ...i, tracked: t ? { taskId: t.id } : null };
    })).sort((a, b) => b.updatedAt - a.updatedAt)
  };
}

async function editRepos(env: Env, user: User, b: { add?: unknown; remove?: unknown }) {
  if (user.role !== 'super_admin') throw new HttpError(403, 'Only a super admin chooses the repositories in Tasks.');
  if (b.add !== undefined) {
    if (!github.validRepo(b.add)) throw new HttpError(400, 'repo must be owner/name');
    const info = await github.repoInfo(env, b.add, true);
    if (!info.ok) throw new HttpError(400, 'Can’t add ' + b.add + ': ' + (info.error || 'GitHub can’t reach it.'), 'github_no_access');
    await env.DB.prepare('INSERT OR IGNORE INTO task_repos (full_name, added_by, added_at) VALUES (?1, ?2, ?3)').bind(info.fullName, user.memberEmail, Date.now()).run();
  }
  if (b.remove !== undefined) {
    if (!github.validRepo(b.remove)) throw new HttpError(400, 'repo must be owner/name');
    // Tasks already linked keep their link; the repository just stops being listed.
    await env.DB.prepare('DELETE FROM task_repos WHERE full_name = ?1').bind(b.remove).run();
  }
  return repoStatus(env);
}

async function repoStatus(env: Env) {
  return {
    enabled: github.githubEnabled(env),
    repos: await Promise.all((await repos(env)).map(r => (github.githubEnabled(env) ? github.repoInfo(env, r) : Promise.resolve<github.RepoOut>({ fullName: r, ok: false, private: null, url: 'https://github.com/' + r, error: 'No GitHub token is set on the Worker.' }))))
  };
}

// ---------- notifications ----------

/** In-app notifications: assignments, due tasks, approvals to review and decisions on yours. */
async function inbox(env: Env, user: User) {
  const seen = (await env.DB.prepare('SELECT seen_at FROM task_inbox_seen WHERE member_email = ?1').bind(user.memberEmail).first<{ seen_at: number }>())?.seen_at || 0;
  const since = Date.now() - 30 * 86_400_000;
  const items: { kind: string; text: string; at: number; taskId?: number; approvalId?: number }[] = [];
  const assigned = (await env.DB.prepare(`SELECT e.task_id, e.actor, e.at, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE e.action = 'assigned' AND e.detail = ?1 AND e.actor != ?1 AND e.at > ?2 AND t.assignee = ?1 ORDER BY e.at DESC LIMIT 50`)
    .bind(user.memberEmail, since).all<{ task_id: number; actor: string; at: number; title: string }>()).results;
  for (const a of assigned) items.push({ kind: 'assigned', text: a.actor + ' assigned you “' + a.title + '”', at: a.at, taskId: a.task_id });
  const soon = Date.now() + 86_400_000;
  const dueRows = (await env.DB.prepare(`SELECT id, title, due_at FROM tasks WHERE assignee = ?1 AND due_at IS NOT NULL AND due_at <= ?2
    AND status NOT IN ('completed', 'cancelled') ORDER BY due_at LIMIT 50`).bind(user.memberEmail, soon).all<{ id: number; title: string; due_at: number }>()).results;
  for (const d of dueRows) items.push({ kind: d.due_at < Date.now() ? 'overdue' : 'due', text: '“' + d.title + '” is ' + (d.due_at < Date.now() ? 'overdue' : 'due soon'), at: Math.min(d.due_at, Date.now()), taskId: d.id });
  items.push(...(await inboxForApprovals(env, user, since)));
  items.sort((a, b) => b.at - a.at);
  return { items, seenAt: seen, unseen: items.filter(i => i.at > seen).length };
}

// ---------- routes ----------

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const path = url.pathname;
  const m = req.method;
  if (path === '/api/tasks') {
    if (m === 'GET') return json({ tasks: await list(env, user, url.searchParams) });
    if (m === 'POST') return json({ task: await create(env, user, await readJson(req)) }, 201);
  }
  if (path === '/api/tasks/members' && m === 'GET') return json({ members: await mentionable(env), you: user.memberEmail });
  if (path === '/api/tasks/inbox' && m === 'GET') return json(await inbox(env, user));
  if (path === '/api/tasks/inbox/seen' && m === 'POST') {
    await env.DB.prepare('INSERT INTO task_inbox_seen (member_email, seen_at) VALUES (?1, ?2) ON CONFLICT (member_email) DO UPDATE SET seen_at = excluded.seen_at')
      .bind(user.memberEmail, Date.now()).run();
    return json({ ok: true });
  }
  // GitHub, AI suggestions and the repository list are the super admins' tools.
  if (path === '/api/tasks/suggest' || path.startsWith('/api/tasks/github/')) requireSuper(user, 'uses GitHub issues and task suggestions');
  if (path === '/api/tasks/suggest' && m === 'POST') return json(await suggestTasks(env, user, await readJson(req)));
  if (path === '/api/tasks/github/repos') {
    if (m === 'GET') return json(await repoStatus(env));
    if (m === 'PUT') return json(await editRepos(env, user, await readJson(req)));
  }
  if (path === '/api/tasks/github/issues' && m === 'GET') {
    if (!github.githubEnabled(env)) throw new HttpError(503, 'GitHub isn’t connected: the Worker has no GitHub token.', 'github_off');
    return json(await issues(env, url.searchParams));
  }
  if (path === '/api/tasks/github/track' && m === 'POST') return json({ task: await trackIssue(env, user, await readJson(req)) }, 201);

  const one = /^\/api\/tasks\/(\d+)(\/events|\/github|\/github\/link|\/github\/state)?$/.exec(path);
  if (!one) throw new HttpError(404, 'Not found');
  const r = await visible(env, user, Number(one[1]));
  if (one[2]?.startsWith('/github') && m !== 'GET') requireSuper(user, 'changes GitHub issues');
  switch (one[2]) {
    case undefined:
      if (m === 'GET') return json({ task: out(r) });
      if (m === 'PATCH') return json({ task: await update(env, user, r, await readJson(req)) });
      if (m === 'DELETE') {
        requireSuper(user, 'deletes tasks');
        await env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(r.id).run();
        await event(env, r.id, user.memberEmail, 'deleted');
        return json({ ok: true });
      }
      break;
    case '/events':
      if (m === 'GET') {
        const events = (await env.DB.prepare('SELECT actor, action, detail, at FROM task_events WHERE task_id = ?1 ORDER BY at, id').bind(r.id).all()).results;
        return json({ events });
      }
      break;
    case '/github':
      if (m === 'POST') return json({ task: await openIssue(env, user, r, await readJson(req)) }, 201);
      if (m === 'DELETE') {
        if (!r.github_repo) return json({ task: out(r) });
        await env.DB.prepare('UPDATE tasks SET github_repo = NULL, github_number = NULL, github_url = NULL, version = version + 1, updated_at = ?2 WHERE id = ?1').bind(r.id, Date.now()).run();
        await event(env, r.id, user.memberEmail, 'github_unlinked', r.github_repo + '#' + r.github_number);
        return json({ task: out(await visible(env, user, r.id)) });
      }
      if (m === 'GET') {
        if (!r.github_repo || !r.github_number) return json({ issue: null });
        return json({ issue: await github.getIssue(env, r.github_repo, r.github_number) });
      }
      break;
    case '/github/link':
      if (m === 'POST') {
        if (r.github_repo) throw new HttpError(409, 'This task already has a GitHub issue.', 'issue_tracked');
        const b = await readJson<{ repo?: unknown; number?: unknown }>(req);
        const repo = await listed(env, b.repo);
        return json({ task: await linkIssue(env, user, r, repo, await github.getIssue(env, repo, issueNumber(b.number))) });
      }
      break;
    case '/github/state':
      if (m === 'POST') {
        if (!r.github_repo || !r.github_number) throw new HttpError(400, 'This task has no GitHub issue.');
        const b = await readJson<{ state?: unknown }>(req);
        const state = oneOf(['open', 'closed'] as const, b.state, 'state');
        const issue = await github.setIssueState(env, r.github_repo, r.github_number, state);
        await event(env, r.id, user.memberEmail, state === 'closed' ? 'github_closed' : 'github_reopened', r.github_repo + '#' + r.github_number);
        return json({ issue });
      }
      break;
  }
  throw new HttpError(405, 'Method not allowed');
}
