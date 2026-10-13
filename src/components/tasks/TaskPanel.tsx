import { useEffect, useState } from 'react';
import type { GithubRepo, Task, TaskEvent, TasksApi } from '../../lib/tasksApi';
import { PRIORITY_LABEL, STATUS_LABEL, TasksError, VIA_LABEL } from '../../lib/tasksApi';
import { errorText } from '../Toast';
import { TaskForm, dueText, memberName, type Member } from './TaskForm';

interface Props {
  api: TasksApi;
  task: Task;
  members: Member[];
  you: string;
  repos: GithubRepo[] | null;
  /** Super admins run tasks; anyone else only moves their own along. */
  superAdmin: boolean;
  onChanged: (t: Task) => void;
  onRemoved: (id: number) => void;
  onClose: () => void;
  onOpenSource: (mailbox: string, threadId: string) => void;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function eventText(e: TaskEvent, members: Member[]): string {
  switch (e.action) {
    case 'created': return 'created it' + (e.detail.startsWith('github:') ? ' from ' + e.detail.slice(7) : e.detail && e.detail !== 'manual' ? ' (' + (VIA_LABEL[e.detail as keyof typeof VIA_LABEL] || e.detail).toLowerCase() + ')' : '');
    case 'assigned': return 'assigned it to ' + memberName(members, e.detail);
    case 'unassigned': return 'unassigned ' + memberName(members, e.detail);
    case 'status': return 'marked it ' + (STATUS_LABEL[e.detail as keyof typeof STATUS_LABEL] || e.detail).toLowerCase();
    case 'priority': return 'set priority ' + (PRIORITY_LABEL[e.detail as keyof typeof PRIORITY_LABEL] || e.detail).toLowerCase();
    case 'due': return e.detail ? 'set the due date to ' + new Date(Number(e.detail)).toLocaleDateString() : 'removed the due date';
    case 'edited': return 'edited the ' + e.detail;
    case 'github_linked': return 'linked ' + e.detail;
    case 'github_unlinked': return 'unlinked ' + e.detail;
    case 'github_closed': return 'closed ' + e.detail + ' on GitHub';
    case 'github_reopened': return 'reopened ' + e.detail + ' on GitHub';
    default: return e.action;
  }
}

export function TaskPanel({ api, task, members, you, repos, superAdmin, onChanged, onRemoved, onClose, onOpenSource }: Props) {
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [issueState, setIssueState] = useState<'open' | 'closed' | null>(null);
  const [repo, setRepo] = useState('');
  const [linkNumber, setLinkNumber] = useState('');
  const [includeDescription, setIncludeDescription] = useState(true);

  useEffect(() => {
    let live = true;
    setEvents(null);
    api.events(task.id).then(e => live && setEvents(e)).catch(() => live && setEvents([]));
    return () => { live = false; };
  }, [api, task.id, task.version]);

  useEffect(() => {
    setIssueState(null);
    if (!task.github) return;
    let live = true;
    api.issue(task.id).then(i => { if (live) setIssueState(i?.state ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [api, task.id, task.github?.repo, task.github?.number]);

  const usable = (repos || []).filter(r => r.ok);
  const chosen = usable.find(r => r.fullName === repo) || null;

  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setErr('');
    try { await f(); } catch (e) {
      if (e instanceof TasksError && e.code === 'task_conflict' && e.data.current) {
        onChanged(e.data.current as Task);
        setErr('Someone changed this task first; this is the current version. Make your change again.');
      } else setErr(errorText(e));
    } finally { setBusy(''); }
  };

  const setStatus = (status: Task['status']) => act('status', async () => onChanged(await api.update(task.id, task.version, { status })));

  const openIssue = () => act('issue', async () => {
    if (!chosen) return;
    // A public repository is readable by anyone: say so, and get a yes, before anything goes there.
    const isPublic = chosen.private === false;
    if (isPublic && !window.confirm(chosen.fullName + ' is PUBLIC: anyone on the internet can read this issue. Email addresses will be removed, but the title' + (includeDescription ? ' and description' : '') + ' will be published as written. Open it there?')) return;
    onChanged(await api.openIssue(task.id, chosen.fullName, isPublic, includeDescription));
  });

  const done = task.status === 'completed' || task.status === 'cancelled';
  return (
    <div className="card panel task-panel" aria-label="Task">
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 15 }}>{task.title}</b>
        <span className={'pill' + (task.priority === 'urgent' ? ' danger' : task.priority === 'high' ? ' warn' : '')}>{PRIORITY_LABEL[task.priority]}</span>
        <span className={'pill' + (done ? ' ok' : '')}>{STATUS_LABEL[task.status]}</span>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      {err && <div className="notice warn" role="alert">{err}</div>}

      {editing ? (
        <TaskForm members={members} you={you} task={task} busy={busy === 'save'} submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={t => act('save', async () => {
            onChanged(await api.update(task.id, task.version, { title: t.title, description: t.description, assignee: t.assignee ?? null, priority: t.priority, dueAt: t.dueAt ?? null, status: t.status }));
            setEditing(false);
          })} />
      ) : (
        <>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {memberName(members, task.assignee)}{task.assignee === you ? ' (you)' : ''} · {task.dueAt ? dueText(task.dueAt) : 'No due date'} · {VIA_LABEL[task.createdVia]} · created by {memberName(members, task.createdBy)} {when(task.createdAt)}
            {task.completedAt ? ' · ' + (task.status === 'cancelled' ? 'cancelled ' : 'completed ') + when(task.completedAt) : ''}
          </span>
          {task.description && <p className="task-desc">{task.description}</p>}
          {task.source && (
            <span style={{ fontSize: 12.5 }}>From the email “{task.source.subject || '(no subject)'}” · <button className="link-btn" onClick={() => onOpenSource(task.source!.mailbox, task.source!.threadId)}>Open the email</button></span>
          )}
          <div className="row-wrap">
            {!done && <button className="btn primary sm" disabled={!!busy} onClick={() => setStatus('completed')}>Mark completed</button>}
            {task.status === 'open' && <button className="btn sm" disabled={!!busy} onClick={() => setStatus('in_progress')}>Start</button>}
            {!done && task.status !== 'waiting' && <button className="btn sm" disabled={!!busy} onClick={() => setStatus('waiting')}>Waiting</button>}
            {done && <button className="btn sm" disabled={!!busy} onClick={() => setStatus('open')}>Reopen</button>}
            {superAdmin && <button className="btn sm" disabled={!!busy} onClick={() => setEditing(true)}>Edit</button>}
            {superAdmin && !done && <button className="btn ghost sm" disabled={!!busy} onClick={() => setStatus('cancelled')}>Cancel task</button>}
            {superAdmin && (
              <button className="btn ghost sm danger" disabled={!!busy} onClick={() => {
                if (window.confirm('Delete “' + task.title + '”? This can’t be undone. Its GitHub issue, if any, stays on GitHub.')) act('delete', async () => { await api.remove(task.id); onRemoved(task.id); });
              }}>Delete</button>
            )}
          </div>
          {superAdmin && task.status === 'completed' && task.github && issueState === 'open' && (
            <span className="notice accent">The GitHub issue is still open. Close it below if the work is done there too; completing a task never closes it by itself.</span>
          )}
        </>
      )}

      <div className="task-section" aria-label="GitHub issue">
        <span className="mono-label">GitHub</span>
        {task.github ? (
          <>
            <span style={{ fontSize: 13 }}>
              <a href={task.github.url} target="_blank" rel="noopener noreferrer">{task.github.repo}#{task.github.number}</a>
              {issueState && <span className={'pill' + (issueState === 'closed' ? ' ok' : '')} style={{ marginLeft: 8 }}>{issueState === 'closed' ? 'Closed' : 'Open'} on GitHub</span>}
            </span>
            {superAdmin && <div className="row-wrap">
              {issueState !== 'closed' && <button className="btn sm" disabled={!!busy} onClick={() => {
                if (window.confirm('Close ' + task.github!.repo + '#' + task.github!.number + ' on GitHub?')) act('gh', async () => { await api.setIssueState(task.id, 'closed'); setIssueState('closed'); });
              }}>Close issue on GitHub</button>}
              {issueState === 'closed' && <button className="btn sm" disabled={!!busy} onClick={() => act('gh', async () => { await api.setIssueState(task.id, 'open'); setIssueState('open'); })}>Reopen issue</button>}
              <button className="btn ghost sm" disabled={!!busy} onClick={() => act('gh', async () => onChanged(await api.unlinkIssue(task.id)))}>Unlink</button>
            </div>}
          </>
        ) : !superAdmin ? (
          <span className="faint" style={{ fontSize: 12.5 }}>No GitHub issue.</span>
        ) : !repos ? (
          <span className="faint" style={{ fontSize: 12.5 }}>Loading repositories…</span>
        ) : !usable.length ? (
          <span className="faint" style={{ fontSize: 12.5 }}>No repository is reachable. A super admin sets the GitHub tokens (see GitHub issues).</span>
        ) : (
          <>
            <div className="row-wrap" style={{ alignItems: 'center' }}>
              <select className="input" aria-label="Repository" value={repo} onChange={e => setRepo(e.target.value)}>
                <option value="">Choose a repository…</option>
                {usable.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private === false ? ' (public)' : ''}</option>)}
              </select>
              <button className="btn sm" disabled={!chosen || !!busy} onClick={openIssue}>{busy === 'issue' ? 'Opening…' : 'Open an issue'}</button>
              <input className="input" style={{ width: 90 }} inputMode="numeric" aria-label="Existing issue number" placeholder="Issue #" value={linkNumber} onChange={e => setLinkNumber(e.target.value.replace(/\D/g, ''))} />
              <button className="btn ghost sm" disabled={!chosen || !linkNumber || !!busy} onClick={() => act('gh', async () => { onChanged(await api.linkIssue(task.id, chosen!.fullName, Number(linkNumber))); setLinkNumber(''); })}>Link existing</button>
            </div>
            <label className="check-row" style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={includeDescription} onChange={() => setIncludeDescription(v => !v)} />
              <span>Include the description in the issue</span>
            </label>
            {chosen?.private === false && <span className="notice warn">{chosen.fullName} is public. Anyone can read its issues; email addresses are removed, nothing else is.</span>}
            {chosen?.private === true && <span className="faint" style={{ fontSize: 11.5 }}>{chosen.fullName} is private: only people with access to it see the issue.</span>}
          </>
        )}
      </div>

      <div className="task-section" aria-label="Activity">
        <span className="mono-label">Activity</span>
        {!events ? <span className="faint">Loading…</span> : events.map((e, i) => (
          <span key={i} style={{ fontSize: 12.5 }}><b>{memberName(members, e.actor)}</b> {eventText(e, members)} <span className="faint">· {when(e.at)}</span></span>
        ))}
      </div>
    </div>
  );
}
