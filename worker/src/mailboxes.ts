import type { Env } from './env';
import { allowedDomains, type User } from './auth';
import { delegatedToken, delegationEnabled, refreshTokenEmail } from './delegation';
import { HttpError, json, readJson } from './http';
import { access, checkReply, checkSendAs, log, recordReply } from './shared';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mailboxEmail(env: Env, v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Mailbox must be an email address');
  if (!allowedDomains(env).includes(e.split('@')[1])) throw new HttpError(400, 'Shared mailboxes must be @' + allowedDomains(env)[0] + ' accounts.');
  return e;
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
  const { canSend } = await access(env, user, mailbox);

  const token = await delegatedToken(env, mailbox);
  const target = 'https://gmail.googleapis.com/' + (upload ? 'upload/' : '') + 'gmail/v1/users/me/' + rest + url.search;
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  const ct = req.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.arrayBuffer();

  // Sending as the mailbox: permission, a From address Gmail really sends as, and no accidental double reply.
  const sending = req.method === 'POST' && (upload ? rest === 'messages/send' : rest === 'drafts/send');
  let sent: { from: string; thread: string | null } | null = null;
  if (sending) {
    const out = upload ? parseUpload(ct || '', body!) : await draftInfo(token, body!);
    if (!canSend) {
      await log(env, mailbox, out.thread || '', user.memberEmail, 'send_refused', 'no send permission');
      throw new HttpError(403, 'You can read ' + mailbox + ' but not send from it. Ask a super admin for send access.', 'send_not_permitted');
    }
    await checkSendAs(env, user, mailbox, out.from, out.thread);
    if (out.thread) await checkReply(env, user, mailbox, out.thread, req.headers.get('X-Axal-Seen-Message'), req.headers.get('X-Axal-Confirm') === '1');
    sent = out;
  }

  const res = await fetch(target, { method: req.method, headers, body });
  const out = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const rct = res.headers.get('Content-Type');
  if (rct) out.set('Content-Type', rct);
  if (sent && res.ok) {
    const text = await res.text();
    let thread = sent.thread;
    try { thread = (JSON.parse(text) as { threadId?: string }).threadId || thread; } catch { /* keep what we had */ }
    if (thread) await recordReply(env, user, mailbox, thread, sent.from);
    return new Response(text, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}

/** From address and thread of a multipart/related upload: JSON metadata, then the RFC 822 message. */
export function parseUpload(contentType: string, body: ArrayBuffer): { from: string; thread: string | null } {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  const text = new TextDecoder().decode(body.byteLength > 2_000_000 ? body.slice(0, 2_000_000) : body);
  if (!boundary) throw new HttpError(400, 'Expected a multipart upload');
  const parts = text.split('--' + boundary);
  const partBody = (p: string) => p.slice(p.indexOf('\r\n\r\n') + 4);
  let thread: string | null = null;
  const meta = parts.find(p => /content-type:\s*application\/json/i.test(p.slice(0, p.indexOf('\r\n\r\n'))));
  if (meta) try { thread = (JSON.parse(partBody(meta).trim()) as { threadId?: string }).threadId || null; } catch { /* no metadata */ }
  const msg = parts.find(p => /content-type:\s*message\/rfc822/i.test(p.slice(0, p.indexOf('\r\n\r\n'))));
  if (!msg) throw new HttpError(400, 'Expected an RFC 822 message');
  return { from: fromHeader(partBody(msg)), thread };
}

/** The address in the From header of an RFC 822 message (headers end at the first blank line). */
export function fromHeader(raw: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = head.split(/\r?\n/).find(l => /^from:/i.test(l)) || '';
  const v = line.slice(5).trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  return (angle ? angle[1] : v.split(/\s+/).find(x => x.includes('@')) || '').toLowerCase();
}

async function draftInfo(token: string, body: ArrayBuffer): Promise<{ from: string; thread: string | null }> {
  let id = '';
  try { id = (JSON.parse(new TextDecoder().decode(body)) as { id?: string }).id || ''; } catch { /* below */ }
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'Missing draft id');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/' + id + '?format=metadata&metadataHeaders=From', { headers: { Authorization: 'Bearer ' + token } });
  const d = (await res.json().catch(() => ({}))) as { message?: { threadId?: string; payload?: { headers?: { name: string; value: string }[] } } };
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'Could not read the draft (' + res.status + ').');
  const from = d.message?.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value || '';
  return { from: fromHeader('From: ' + from + '\r\n\r\n'), thread: d.message?.threadId || null };
}

// ---------- administration (super admins) ----------

export async function listGrants(env: Env) {
  const rows = (await env.DB.prepare('SELECT mailbox, member_email, can_send FROM mailbox_access ORDER BY mailbox, member_email')
    .all<{ mailbox: string; member_email: string; can_send: number }>()).results;
  const by = new Map<string, string[]>();
  const readOnly = new Map<string, string[]>();
  for (const r of rows) {
    by.set(r.mailbox, [...(by.get(r.mailbox) || []), r.member_email]);
    if (!r.can_send) readOnly.set(r.mailbox, [...(readOnly.get(r.mailbox) || []), r.member_email]);
  }
  return {
    enabled: delegationEnabled(env),
    /** The mailbox GMAIL_REFRESH_TOKEN opens, if any. */
    refreshTokenMailbox: await refreshTokenEmail(env),
    /** `readOnly`: members who may read and draft but not send as the mailbox. */
    mailboxes: [...by].map(([mailbox, members]) => ({ mailbox, members, readOnly: readOnly.get(mailbox) || [] }))
  };
}

async function grant(env: Env, body: { mailbox?: unknown; memberEmail?: unknown; canSend?: unknown }) {
  const mailbox = mailboxEmail(env, body.mailbox);
  const member = mailboxEmail(env, body.memberEmail);
  const canSend = body.canSend === false ? 0 : 1;
  const existing = await env.DB.prepare('SELECT 1 FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, member).first();
  if (existing) {
    // Changing what an existing member may do needs no new check with Google.
    await env.DB.prepare('UPDATE mailbox_access SET can_send = ?1 WHERE mailbox = ?2 AND member_email = ?3').bind(canSend, mailbox, member).run();
    return;
  }
  // Proves domain-wide delegation works for this mailbox before anyone relies on it.
  const token = await delegatedToken(env, mailbox);
  const check = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + token } });
  if (!check.ok) throw new HttpError(502, 'Google refused to open ' + mailbox + ' (' + check.status + ').', 'delegation_failed');
  await env.DB.prepare('INSERT INTO mailbox_access (mailbox, member_email, created_at, can_send) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING')
    .bind(mailbox, member, Date.now(), canSend).run();
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
