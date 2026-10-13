import type { Env } from './env';
import { allowedDomains, type User } from './auth';
import { delegatedToken, delegationEnabled, refreshTokenEmail } from './delegation';
import { HttpError, json, readJson } from './http';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mailboxEmail(env: Env, v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Mailbox must be an email address');
  if (!allowedDomains(env).includes(e.split('@')[1])) throw new HttpError(400, 'Shared mailboxes must be @' + allowedDomains(env)[0] + ' accounts.');
  return e;
}

async function canOpen(env: Env, user: User, mailbox: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS ok FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, user.memberEmail).first();
  return !!r;
}

/** GET /api/mailboxes: the shared mailboxes this member may open. */
export async function listForUser(env: Env, user: User): Promise<Response> {
  if (!delegationEnabled(env)) return json({ enabled: false, mailboxes: [] });
  const rows = (await env.DB.prepare('SELECT mailbox FROM mailbox_access WHERE member_email = ?1 AND mailbox != ?1 ORDER BY mailbox')
    .bind(user.memberEmail).all<{ mailbox: string }>()).results;
  return json({ enabled: true, mailboxes: rows.map(r => r.mailbox) });
}

/**
 * The Gmail API calls the mail client makes, and nothing else: no permanent
 * deletes, filters, forwarding, delegation or other settings changes.
 */
const GMAIL_ROUTES: { re: RegExp; methods: string[] }[] = [
  { re: /^profile$/, methods: ['GET'] },
  { re: /^labels$/, methods: ['GET', 'POST'] },
  { re: /^labels\/[\w-]+$/, methods: ['GET'] },
  { re: /^threads$/, methods: ['GET'] },
  { re: /^threads\/[\w-]+$/, methods: ['GET'] },
  { re: /^threads\/[\w-]+\/(modify|trash|untrash)$/, methods: ['POST'] },
  { re: /^messages$/, methods: ['GET'] },
  { re: /^messages\/[\w-]+$/, methods: ['GET'] },
  { re: /^messages\/[\w-]+\/attachments\/[\w-]+$/, methods: ['GET'] },
  { re: /^messages\/[\w-]+\/(modify|trash|untrash)$/, methods: ['POST'] },
  { re: /^drafts$/, methods: ['GET'] },
  { re: /^drafts\/send$/, methods: ['POST'] },
  { re: /^drafts\/[\w-]+$/, methods: ['GET', 'DELETE'] },
  { re: /^settings\/sendAs$/, methods: ['GET'] }
];
const UPLOAD_ROUTES: { re: RegExp; methods: string[] }[] = [
  { re: /^messages\/send$/, methods: ['POST'] },
  { re: /^drafts$/, methods: ['POST'] },
  { re: /^drafts\/[\w-]+$/, methods: ['PUT'] }
];

const PROXY_RE = /^\/api\/mailboxes\/([^/]+)\/(gmail|upload\/gmail)\/v1\/users\/me\/(.+)$/;

/**
 * /api/mailboxes/<mailbox>/(upload/)gmail/v1/users/me/<path>: the Gmail API
 * for a shared mailbox. The member's own Google token authenticates them here;
 * the call to Google uses the delegated token, which the browser never sees.
 */
export async function proxy(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const m = PROXY_RE.exec(url.pathname);
  if (!m) throw new HttpError(404, 'Not found');
  const mailbox = mailboxEmail(env, decodeURIComponent(m[1]));
  const upload = m[2] !== 'gmail';
  const rest = m[3];
  const allowed = (upload ? UPLOAD_ROUTES : GMAIL_ROUTES).find(r => r.re.test(rest));
  if (!allowed || !allowed.methods.includes(req.method)) throw new HttpError(403, 'This Gmail operation is not available for shared mailboxes.');
  if (!(await canOpen(env, user, mailbox))) throw new HttpError(403, "You don't have access to " + mailbox + '.', 'no_mailbox_access');

  const token = await delegatedToken(env, mailbox);
  const target = 'https://gmail.googleapis.com/' + (upload ? 'upload/' : '') + 'gmail/v1/users/me/' + rest + url.search;
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  const ct = req.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.arrayBuffer()
  });
  const out = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const rct = res.headers.get('Content-Type');
  if (rct) out.set('Content-Type', rct);
  return new Response(res.body, { status: res.status, headers: out });
}

// ---------- administration (super admins) ----------

export async function listGrants(env: Env) {
  const rows = (await env.DB.prepare('SELECT mailbox, member_email FROM mailbox_access ORDER BY mailbox, member_email')
    .all<{ mailbox: string; member_email: string }>()).results;
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.mailbox, [...(by.get(r.mailbox) || []), r.member_email]);
  return {
    enabled: delegationEnabled(env),
    /** The mailbox GMAIL_REFRESH_TOKEN opens, if any. */
    refreshTokenMailbox: await refreshTokenEmail(env),
    mailboxes: [...by].map(([mailbox, members]) => ({ mailbox, members }))
  };
}

async function grant(env: Env, body: { mailbox?: unknown; memberEmail?: unknown }) {
  const mailbox = mailboxEmail(env, body.mailbox);
  const member = mailboxEmail(env, body.memberEmail);
  // Proves domain-wide delegation works for this mailbox before anyone relies on it.
  const token = await delegatedToken(env, mailbox);
  const check = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + token } });
  if (!check.ok) throw new HttpError(502, 'Google refused to open ' + mailbox + ' (' + check.status + ').', 'delegation_failed');
  await env.DB.prepare('INSERT INTO mailbox_access (mailbox, member_email, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
    .bind(mailbox, member, Date.now()).run();
}

async function revoke(env: Env, mailbox: unknown, member: unknown) {
  await env.DB.prepare('DELETE FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2')
    .bind(mailboxEmail(env, mailbox), mailboxEmail(env, member)).run();
}

/** /api/admin/mailboxes — who may open which shared mailbox. Super admins only. */
export async function adminRoute(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (user.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can manage shared mailboxes.', 'forbidden');
  if (req.method === 'GET') return json(await listGrants(env));
  if (req.method === 'POST') {
    await grant(env, await readJson(req));
    return json(await listGrants(env));
  }
  if (req.method === 'DELETE') {
    await revoke(env, url.searchParams.get('mailbox'), url.searchParams.get('memberEmail'));
    return json(await listGrants(env));
  }
  throw new HttpError(405, 'Method not allowed');
}
