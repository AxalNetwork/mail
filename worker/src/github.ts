import type { Env } from './env';
import { HttpError } from './http';

/**
 * GitHub issues for Tasks. The Worker holds the tokens; the browser never sees
 * them. A fine-grained token covers one owner, so GITHUB_ISSUES_TOKENS maps
 * owners to tokens ({"AxalNetwork":"github_pat_…","AlgoSize":"…"}); an owner
 * without one falls back to GITHUB_TOKEN. Each token needs Issues: read and
 * write (and Metadata: read) on that owner's repositories.
 */

export interface IssueOut {
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoOut {
  fullName: string;
  ok: boolean;
  /** null while unknown (no access). */
  private: boolean | null;
  url: string;
  error: string | null;
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const validRepo = (s: unknown): s is string => typeof s === 'string' && REPO_RE.test(s) && !s.includes('..');

function tokens(env: Env): Map<string, string> {
  const m = new Map<string, string>();
  if (env.GITHUB_ISSUES_TOKENS) {
    try {
      for (const [owner, t] of Object.entries(JSON.parse(env.GITHUB_ISSUES_TOKENS) as Record<string, unknown>)) {
        if (typeof t === 'string' && t) m.set(owner.toLowerCase(), t);
      }
    } catch {
      console.error('GITHUB_ISSUES_TOKENS is not valid JSON; ignoring it.');
    }
  }
  return m;
}

export function tokenFor(env: Env, repo: string): string | null {
  return tokens(env).get(repo.split('/')[0].toLowerCase()) || env.GITHUB_TOKEN || null;
}

export const githubEnabled = (env: Env) => !!env.GITHUB_TOKEN || tokens(env).size > 0;

async function gh<T>(env: Env, repo: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenFor(env, repo);
  if (!token) throw new HttpError(503, 'No GitHub token can reach ' + repo + '. Add one for ' + repo.split('/')[0] + ' in GITHUB_ISSUES_TOKENS.', 'github_off');
  let res: Response;
  try {
    res = await fetch('https://api.github.com/repos/' + repo + path, {
      method: init.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'axal-mail',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined
    });
  } catch {
    throw new HttpError(502, 'GitHub could not be reached. Try again.', 'github_failed');
  }
  const j = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // GitHub answers 404 for a private repository the token can't see.
    throw new HttpError(502, 'The GitHub token for ' + repo.split('/')[0] + ' can’t ' + (init.method && init.method !== 'GET' ? 'change issues in ' : 'read ') + repo + ' (' + res.status + ').', 'github_no_access');
  }
  if (res.status === 410) throw new HttpError(409, 'Issues are turned off in ' + repo + '.', 'github_issues_off');
  if (!res.ok) throw new HttpError(502, 'GitHub refused the request (' + res.status + (j.message ? ': ' + j.message : '') + ').', 'github_failed');
  return j;
}

interface RawIssue {
  number: number; title: string; state: string; html_url: string; pull_request?: unknown;
  labels?: (string | { name?: string })[]; assignees?: { login: string }[]; user?: { login: string };
  created_at: string; updated_at: string;
}

const toIssue = (repo: string, i: RawIssue): IssueOut => ({
  repo, number: i.number, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', url: i.html_url,
  labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name || '')).filter(Boolean),
  assignees: (i.assignees || []).map(a => a.login), author: i.user?.login || '',
  createdAt: Date.parse(i.created_at) || 0, updatedAt: Date.parse(i.updated_at) || 0
});

// Per-isolate caches; GitHub allows 5,000 requests an hour per token.
const repoCache = new Map<string, { at: number; info: RepoOut }>();
const listCache = new Map<string, { at: number; issues: IssueOut[] }>();
const REPO_MS = 5 * 60_000;
const LIST_MS = 60_000;
export function clearGithubCache() { repoCache.clear(); listCache.clear(); }

/** Whether the token can read the repository, and whether it is public right now (visibility can change). */
export async function repoInfo(env: Env, repo: string, fresh = false): Promise<RepoOut> {
  const hit = repoCache.get(repo.toLowerCase());
  if (!fresh && hit && Date.now() - hit.at < REPO_MS) return hit.info;
  let info: RepoOut;
  try {
    const r = await gh<{ full_name: string; private: boolean; html_url: string; has_issues?: boolean }>(env, repo, '');
    info = { fullName: r.full_name || repo, ok: r.has_issues !== false, private: !!r.private, url: r.html_url, error: r.has_issues === false ? 'Issues are turned off in this repository.' : null };
  } catch (e) {
    info = { fullName: repo, ok: false, private: null, url: 'https://github.com/' + repo, error: e instanceof Error ? e.message : String(e) };
  }
  repoCache.set(repo.toLowerCase(), { at: Date.now(), info });
  return info;
}

export async function listIssues(env: Env, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<IssueOut[]> {
  const key = repo.toLowerCase() + '|' + state;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_MS) return hit.issues;
  const raw = await gh<RawIssue[]>(env, repo, '/issues?state=' + state + '&per_page=100&sort=updated');
  // The issues API includes pull requests; Tasks lists issues only.
  const issues = raw.filter(i => !i.pull_request).map(i => toIssue(repo, i));
  listCache.set(key, { at: Date.now(), issues });
  return issues;
}

export async function getIssue(env: Env, repo: string, number: number): Promise<IssueOut> {
  const i = await gh<RawIssue>(env, repo, '/issues/' + number);
  if (i.pull_request) throw new HttpError(400, repo + '#' + number + ' is a pull request, not an issue.');
  return toIssue(repo, i);
}

export async function createIssue(env: Env, repo: string, title: string, body: string): Promise<IssueOut> {
  const i = await gh<RawIssue>(env, repo, '/issues', { method: 'POST', body: { title, body } });
  listCache.delete(repo.toLowerCase() + '|open');
  return toIssue(repo, i);
}

export async function setIssueState(env: Env, repo: string, number: number, state: 'open' | 'closed'): Promise<IssueOut> {
  const i = await gh<RawIssue>(env, repo, '/issues/' + number, { method: 'PATCH', body: { state, ...(state === 'closed' ? { state_reason: 'completed' } : {}) } });
  for (const s of ['open', 'closed', 'all']) listCache.delete(repo.toLowerCase() + '|' + s);
  return toIssue(repo, i);
}

// A public repository is readable by anyone: no email addresses go there.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const redactEmails = (s: string) => s.replace(EMAIL, '[email removed]');
