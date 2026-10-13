import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GithubIssue, GithubRepo, Task, TasksApi } from '../../lib/tasksApi';
import { TasksError } from '../../lib/tasksApi';
import { errorText } from '../Toast';

interface Props {
  api: TasksApi;
  superAdmin: boolean;
  repos: GithubRepo[] | null;
  githubEnabled: boolean;
  onReposChanged: (r: GithubRepo[]) => void;
  onTracked: (t: Task) => void;
  onOpenTask: (id: number) => void;
}

type RepoResult = { repo: string; private: boolean | null; error: string | null; count: number };

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Issues of the firm's repositories, read live from GitHub. Tracking one makes it a task here; nothing changes on GitHub. */
export function IssuesTab({ api, superAdmin, repos, githubEnabled, onReposChanged, onTracked, onOpenTask }: Props) {
  const [data, setData] = useState<{ repos: RepoResult[]; issues: GithubIssue[] } | null>(null);
  const [err, setErr] = useState('');
  const [repo, setRepo] = useState('');
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState('');

  const load = useCallback(() => {
    if (!githubEnabled) return;
    setData(null); setErr('');
    api.issues({ state }).then(setData).catch(e => setErr(errorText(e)));
  }, [api, state, githubEnabled]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.issues || []).filter(i => (!repo || i.repo === repo) && (!t || i.title.toLowerCase().includes(t) || String(i.number) === t || i.labels.some(l => l.toLowerCase().includes(t))));
  }, [data, repo, q]);

  const track = async (i: GithubIssue) => {
    setBusy(i.repo + '#' + i.number); setErr('');
    try {
      const t = await api.track(i.repo, i.number);
      onTracked(t);
      setData(d => d && { ...d, issues: d.issues.map(x => (x === i ? { ...x, tracked: { taskId: t.id } } : x)) });
    } catch (e) {
      if (e instanceof TasksError && e.code === 'issue_tracked' && typeof e.data.taskId === 'number') onOpenTask(e.data.taskId);
      else setErr(errorText(e));
    } finally { setBusy(''); }
  };

  const editRepos = async (change: { add?: string; remove?: string }) => {
    setBusy('repos'); setErr('');
    try { onReposChanged((await api.editRepos(change)).repos); setAdding(''); load(); } catch (e) { setErr(errorText(e)); } finally { setBusy(''); }
  };

  if (!githubEnabled) {
    return (
      <div className="card panel">
        <b>GitHub isn’t connected</b>
        <span className="muted" style={{ fontSize: 13 }}>
          The Worker needs a GitHub token that can read and write issues. Add <code>GITHUB_ISSUES_TOKENS</code> as a Worker secret: one fine-grained token per GitHub owner, with Issues read and write on that owner’s repositories (see the README).
        </span>
      </div>
    );
  }

  const unreachable = (data?.repos || []).filter(r => r.error);
  return (
    <>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <input className="input" type="search" aria-label="Search issues" placeholder="Search issues" value={q} onChange={e => setQ(e.target.value)} style={{ flex: '1 1 200px' }} />
        <select className="input" aria-label="Repository" value={repo} onChange={e => setRepo(e.target.value)}>
          <option value="">All repositories</option>
          {(data?.repos || []).map(r => <option key={r.repo} value={r.repo}>{r.repo} ({r.error ? 'unreachable' : r.count})</option>)}
        </select>
        <select className="input" aria-label="Issue state" value={state} onChange={e => setState(e.target.value as typeof state)}>
          <option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option>
        </select>
        <button className="btn ghost sm" aria-label="Refresh" onClick={load}>↻</button>
      </div>
      {err && <div className="notice warn" role="alert">{err}</div>}
      {unreachable.length > 0 && (
        <div className="notice warn">
          {unreachable.length} repositor{unreachable.length === 1 ? 'y' : 'ies'} can’t be read: {unreachable.map(r => r.repo).join(', ')}. {superAdmin ? 'Add a token for that owner to GITHUB_ISSUES_TOKENS.' : 'A super admin adds a token for it.'}
        </div>
      )}
      {!data && !err && <div className="card panel an-loading"><div className="spinner" /> Reading GitHub…</div>}
      {data && (shown.length ? (
        <div className="card table table-scroll" aria-label="GitHub issues">
          <div className="trow issues head"><span>ISSUE</span><span>REPOSITORY</span><span>LABELS</span><span>UPDATED</span><span /></div>
          {shown.map(i => (
            <div key={i.repo + '#' + i.number} className="trow issues">
              <span className="user-cell">
                <a href={i.url} target="_blank" rel="noopener noreferrer"><b>{i.title}</b></a>
                <span>#{i.number} · {i.state}{i.assignees.length ? ' · ' + i.assignees.join(', ') : ''}</span>
              </span>
              <span className="muted">{i.repo}{data.repos.find(r => r.repo === i.repo)?.private === false ? ' · public' : ''}</span>
              <span className="muted">{i.labels.join(', ') || '—'}</span>
              <span className="muted">{day(i.updatedAt)}</span>
              {i.tracked
                ? (i.tracked.taskId ? <button className="btn ghost sm" onClick={() => onOpenTask(i.tracked!.taskId!)}>Open task</button> : <span className="faint" style={{ fontSize: 11.5 }}>Tracked by a teammate</span>)
                : <button className="btn sm" disabled={!!busy} onClick={() => track(i)}>{busy === i.repo + '#' + i.number ? 'Adding…' : 'Track as task'}</button>}
            </div>
          ))}
        </div>
      ) : <div className="card panel"><span className="faint">{data.issues.length ? 'No issues match.' : 'No ' + (state === 'all' ? '' : state + ' ') + 'issues.'}</span></div>)}

      <div className="card panel" aria-label="Repositories">
        <span className="mono-label">Repositories</span>
        {!repos ? <span className="faint">Loading…</span> : repos.map(r => (
          <div key={r.fullName} className="an-row as-div">
            <span className="an-row-main">
              <b><a href={r.url} target="_blank" rel="noopener noreferrer">{r.fullName}</a></b>
              <span className={r.ok ? 'muted' : 'tone-warn'}>{r.ok ? (r.private ? 'Private' : 'Public: anyone can read its issues') : r.error}</span>
            </span>
            {superAdmin && <button className="btn ghost sm" disabled={busy === 'repos'} onClick={() => { if (window.confirm('Stop listing ' + r.fullName + '? Tasks already linked keep their link.')) editRepos({ remove: r.fullName }); }}>Remove</button>}
          </div>
        ))}
        {superAdmin && (
          <form className="row-wrap" onSubmit={e => { e.preventDefault(); if (adding.trim()) editRepos({ add: adding.trim() }); }}>
            <input className="input" aria-label="Add a repository" placeholder="owner/repository" value={adding} onChange={e => setAdding(e.target.value)} />
            <button className="btn sm" type="submit" disabled={busy === 'repos' || !/^[\w.-]+\/[\w.-]+$/.test(adding.trim())}>Add</button>
          </form>
        )}
        <span className="faint" style={{ fontSize: 11.5 }}>Issues are read live from GitHub with the Worker’s token; nothing is copied. Visibility is checked each time, so a repository made private shows as private.</span>
      </div>
    </>
  );
}
