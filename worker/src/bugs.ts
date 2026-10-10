import type { Env } from './env';
import type { User } from './auth';
import { HttpError } from './http';

/** Files bug reports from the app as GitHub issues (GITHUB_TOKEN, GITHUB_REPO). */

const DEFAULT_REPO = 'AxalNetwork/mail';
const PER_HOUR = 5;

export interface BugReportInput {
  title?: unknown;
  description?: unknown;
  context?: {
    view?: unknown;
    path?: unknown;
    build?: unknown;
    userAgent?: unknown;
    viewport?: unknown;
    errors?: unknown;
  };
}

export const bugReportsEnabled = (env: Env) => !!env.GITHUB_TOKEN;

// The repository is public: no addresses, ever, whatever the reporter typed.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const redact = (s: string) => s.replace(EMAIL, '[email removed]');

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? redact(v.replace(/\r\n?/g, '\n').trim()).slice(0, max) : '';
}

/** One line of context, safe inside a Markdown table cell or code span. */
const cell = (v: unknown, max = 200) => text(v, max).replace(/[|`\n]/g, ' ') || '—';

function issueBody(input: BugReportInput, ref: number): string {
  const c = input.context || {};
  const errors = (Array.isArray(c.errors) ? c.errors : []).slice(0, 5).map(e => text(e, 300)).filter(Boolean);
  return [
    text(input.description, 5000) || '_No description._',
    '',
    '---',
    '| | |',
    '| --- | --- |',
    '| Screen | `' + cell(c.view, 60) + '` (`' + cell(c.path, 120) + '`) |',
    '| Build | `' + cell(c.build, 40) + '` |',
    '| Browser | ' + cell(c.userAgent, 300) + ' |',
    '| Window | ' + cell(c.viewport, 40) + ' |',
    '| Report | #' + ref + ' (reporter on file with Axal VC admins) |',
    ...(errors.length ? ['', '<details><summary>Recent errors in the app</summary>', '', '```', ...errors, '```', '</details>'] : []),
    '',
    '_Filed from Axal VC Mail. Email addresses are removed automatically._'
  ].join('\n');
}

async function createIssue(env: Env, title: string, body: string, labels: string[]): Promise<Response> {
  return fetch('https://api.github.com/repos/' + (env.GITHUB_REPO || DEFAULT_REPO) + '/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'axal-mail',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, body, labels })
  });
}

export async function fileBugReport(env: Env, user: User, input: BugReportInput): Promise<{ number: number; url: string }> {
  if (!bugReportsEnabled(env)) throw new HttpError(503, 'Bug reports are not set up: the Worker has no GITHUB_TOKEN.', 'bug_reports_off');
  const title = text(input.title, 120).replace(/\n/g, ' ');
  if (title.length < 3) throw new HttpError(400, 'Give the bug a short title.');

  const since = Date.now() - 3600_000;
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE member_email = ?1 AND created_at > ?2')
    .bind(user.memberEmail, since).first<{ n: number }>();
  if ((recent?.n || 0) >= PER_HOUR) throw new HttpError(429, 'You have sent ' + PER_HOUR + ' reports in the last hour. Try again later.');

  // Reserve the reference first so the issue can cite it.
  const row = await env.DB.prepare("INSERT INTO bug_reports (issue_number, issue_url, member_email, created_at) VALUES (0, '', ?1, ?2)")
    .bind(user.memberEmail, Date.now()).run();
  const ref = Number(row.meta.last_row_id);

  const body = issueBody(input, ref);
  let res = await createIssue(env, title, body, ['bug']);
  // A missing label (or no permission to set one) must not lose the report.
  if (res.status === 422) res = await createIssue(env, title, body, []);
  const j = (await res.json().catch(() => ({}))) as { number?: number; html_url?: string; message?: string };
  if (!res.ok || !j.number || !j.html_url) {
    await env.DB.prepare('DELETE FROM bug_reports WHERE id = ?1').bind(ref).run();
    console.warn('GitHub issue creation failed', res.status, j.message);
    throw new HttpError(502, 'GitHub refused the report (' + res.status + (j.message ? ': ' + j.message : '') + '). Check that GITHUB_TOKEN can create issues in ' + (env.GITHUB_REPO || DEFAULT_REPO) + '.', 'github_failed');
  }
  await env.DB.prepare('UPDATE bug_reports SET issue_number = ?1, issue_url = ?2 WHERE id = ?3').bind(j.number, j.html_url, ref).run();
  return { number: j.number, url: j.html_url };
}
