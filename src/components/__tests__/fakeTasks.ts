// In-memory stand-in for the Worker's Tasks and approvals API (a mock, not the real backend).
import type { Approval, ApprovalMessage, GithubIssue, GithubRepo, Task, TaskInput, TasksApi } from '../../lib/tasksApi';
import { TasksError } from '../../lib/tasksApi';

export function fakeTasks(you = 'boss@axal.vc', role: 'super_admin' | 'member' = 'super_admin') {
  let n = 0;
  const tasks: Task[] = [];
  const approvals: Approval[] = [];
  const repos: GithubRepo[] = [
    { fullName: 'AxalNetwork/mail', ok: true, private: true, url: 'https://github.com/AxalNetwork/mail', error: null },
    { fullName: 'AlgoSize/platform', ok: true, private: false, url: 'https://github.com/AlgoSize/platform', error: null },
    { fullName: 'DeFiScoring/website', ok: false, private: null, url: 'https://github.com/DeFiScoring/website', error: 'The GitHub token for DeFiScoring can’t read DeFiScoring/website (404).' }
  ];
  const issues: GithubIssue[] = [
    { repo: 'AxalNetwork/mail', number: 2, title: 'Tasks & Approvals', state: 'open', url: 'https://github.com/AxalNetwork/mail/issues/2', labels: ['enhancement'], assignees: [], author: 'gl', createdAt: 1, updatedAt: 2, tracked: null }
  ];
  const members = [{ email: 'boss@axal.vc', name: 'Guillaume' }, { email: 'julian@axal.vc', name: 'Julian' }, { email: 'ada@axal.vc', name: 'Ada' }];
  const mk = (t: TaskInput & { createdVia?: Task['createdVia']; github?: Task['github'] }): Task => ({
    id: ++n, title: t.title, description: t.description || '', createdBy: you, assignee: t.assignee === undefined ? you : t.assignee, priority: t.priority || 'normal',
    status: 'open', dueAt: t.dueAt ?? null, createdVia: t.createdVia || 'manual',
    source: t.sourceThreadId ? { mailbox: t.sourceMailbox || '', threadId: t.sourceThreadId, subject: t.sourceSubject || '' } : null,
    github: t.github || null, version: 1, createdAt: Date.now(), updatedAt: Date.now(), completedAt: null
  });
  const sent: { approvalId: number; payload: unknown }[] = [];

  const api: TasksApi = {
    list: vi.fn(async () => tasks.filter(t => role === 'super_admin' || t.assignee === you)),
    get: vi.fn(async (id: number) => { const t = tasks.find(x => x.id === id); if (!t) throw new TasksError('Task not found', 404); return t; }),
    create: vi.fn(async (t: TaskInput) => { const x = mk(t); tasks.push(x); return x; }),
    update: vi.fn(async (id, v, change) => {
      const i = tasks.findIndex(x => x.id === id);
      if (tasks[i].version !== v) throw new TasksError('Someone changed this task first.', 409, 'task_conflict', { current: tasks[i] });
      tasks[i] = { ...tasks[i], ...change, version: v + 1, completedAt: change.status === 'completed' ? Date.now() : tasks[i].completedAt };
      return tasks[i];
    }),
    remove: vi.fn(async id => { tasks.splice(tasks.findIndex(x => x.id === id), 1); }),
    events: vi.fn(async () => [{ actor: you, action: 'created', detail: 'manual', at: Date.now() }]),
    members: vi.fn(async () => ({ members, you })),
    inbox: vi.fn(async () => ({ items: [], seenAt: 0, unseen: 0 })),
    markSeen: vi.fn(async () => {}),
    suggest: vi.fn(async () => [
      { title: 'Send the data room link', detail: 'Maya asks for it.', kind: 'request' as const, quote: 'Can we talk Tuesday?', quoteVerified: true, dueText: 'Tuesday' },
      { title: 'Wire funds', detail: 'Odd request.', kind: 'request' as const, quote: 'wire $1M now', quoteVerified: false, dueText: '' }
    ]),
    repos: vi.fn(async () => ({ enabled: true, repos })),
    editRepos: vi.fn(async () => ({ enabled: true, repos })),
    issues: vi.fn(async () => ({ repos: repos.map(r => ({ repo: r.fullName, private: r.private, error: r.error, count: issues.filter(i => i.repo === r.fullName).length })), issues })),
    track: vi.fn(async (repo, number) => { const x = mk({ title: issues[0].title, createdVia: 'github', github: { repo, number, url: issues[0].url } } as never); tasks.push(x); return x; }),
    openIssue: vi.fn(async (id, repo) => { const t = tasks.find(x => x.id === id)!; t.github = { repo, number: 99, url: 'https://github.com/' + repo + '/issues/99' }; t.version++; return { ...t }; }),
    linkIssue: vi.fn(async id => tasks.find(x => x.id === id)!),
    unlinkIssue: vi.fn(async id => tasks.find(x => x.id === id)!),
    setIssueState: vi.fn(async () => {}),
    issue: vi.fn(async () => null),

    approvals: vi.fn(async scope => approvals.filter(a => (scope === 'queue' ? a.status === 'pending' || a.status === 'deferred' : scope === 'mine' ? a.requester === you : true))),
    approval: vi.fn(async id => approvals.find(a => a.id === id)!),
    approvalEvents: vi.fn(async () => []),
    requestApproval: vi.fn(async r => {
      const a: Approval = {
        id: ++n, kind: r.kind, title: r.title || 'Request', payload: r.payload, contentHash: 'hash' + n, version: 1, status: 'pending', requester: you, reviewer: null, note: '',
        mailbox: r.mailbox || null, sourceThreadId: null, approvedCurrent: false, requestedAt: Date.now(), decidedAt: null, executedBy: null, executedAt: null, result: '',
        canReview: false, canExecute: false, canEdit: true
      };
      approvals.push(a);
      return a;
    }),
    decide: vi.fn(async (a, d, note) => {
      const x = approvals.find(y => y.id === a.id)!;
      Object.assign(x, { status: d === 'approve' ? 'approved' : d === 'reject' ? 'rejected' : 'deferred', reviewer: you, note: note || '', canReview: false, approvedCurrent: d === 'approve' });
      return { ...x };
    }),
    editApproval: vi.fn(async (a, payload) => {
      const x = approvals.find(y => y.id === a.id)!;
      Object.assign(x, { payload, version: x.version + 1, contentHash: 'hash-v' + (x.version + 1), status: 'pending', approvedCurrent: false, canExecute: false });
      return { ...x };
    }),
    withdraw: vi.fn(async id => { const x = approvals.find(y => y.id === id)!; x.status = 'withdrawn'; return { ...x }; }),
    claim: vi.fn(async a => {
      const x = approvals.find(y => y.id === a.id)!;
      if (x.status !== 'approved' || x.contentHash !== a.contentHash) throw new TasksError('This isn’t approved as it is now. It needs approval again.', 409, 'not_approved');
      x.status = 'executing';
      sent.push({ approvalId: x.id, payload: x.payload });
      return { approval: { ...x }, payload: x.payload };
    }),
    finish: vi.fn(async (id, ok, detail) => { const x = approvals.find(y => y.id === id)!; Object.assign(x, { status: ok ? 'executed' : 'failed', result: detail, canExecute: false }); return { ...x }; })
  };

  const addApproval = (over: Partial<Approval> = {}, payload: Partial<ApprovalMessage> = {}) => {
    const a: Approval = {
      id: ++n, kind: 'email_draft', title: 'Fee question', contentHash: 'hash' + n, version: 1, status: 'pending', requester: 'julian@axal.vc', reviewer: null, note: '',
      mailbox: null, sourceThreadId: null, approvedCurrent: false, requestedAt: Date.now(), decidedAt: null, executedBy: null, executedAt: null, result: '',
      canReview: true, canExecute: false, canEdit: true,
      payload: { identity: { id: 'me', addr: 'boss@axal.vc', name: 'Guillaume' }, to: [{ name: 'Meridian', email: 'lp@meridian.example', org: '' }], cc: [], bcc: [], subject: 'Fee question', html: '<p>Hello</p>', text: 'Hello from the approved version', priority: 'Normal', reply: null, ...payload },
      ...over
    };
    approvals.push(a);
    return a;
  };

  return { api, tasks, approvals, repos, sent, addApproval, mk: (t: TaskInput) => { const x = mk(t); tasks.push(x); return x; } };
}
