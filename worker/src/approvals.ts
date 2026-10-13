import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';

/**
 * Approval queue for consequential actions. The payload is exactly what will
 * be executed, and its SHA-256 is the approval's identity: a decision names the
 * hash it saw, an edit changes the hash and puts the request back to pending,
 * and execution is claimed once, atomically, only while the approved hash is
 * still the current one. The browser executes (sends) with the member's own
 * Gmail access, from the payload this API returns at the claim.
 *
 * Who approves:
 * - email_draft, bulk_campaign: an admin or super admin, not the requester
 *   (a super admin may approve their own); the requester executes;
 * - shared_reply: a member who can send from that shared mailbox, not the
 *   requester; the approver executes, since the requester usually can't send.
 * Outreach sequences keep their own approval (sequences.ts); Tasks lists them.
 */

export const KINDS = ['email_draft', 'bulk_campaign', 'shared_reply'] as const;
type Kind = typeof KINDS[number];
type Status = 'pending' | 'approved' | 'rejected' | 'deferred' | 'executing' | 'executed' | 'failed' | 'withdrawn';

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const THREAD_RE = /^[\w-]{1,64}$/;
const MAX_RECIPIENTS = 50;
const MAX_BULK = 500;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const isAdmin = (u: User) => u.role === 'admin' || u.role === 'super_admin';

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- payloads (normalized in a fixed key order, so equal content hashes equally) ----------

function people(v: unknown, field: string, required: boolean) {
  if (!Array.isArray(v) || v.length > MAX_RECIPIENTS) throw new HttpError(400, field + ' must be a list of up to ' + MAX_RECIPIENTS + ' recipients');
  const list = v.map((p: Record<string, unknown>) => {
    const email = str(p?.email, 254).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, field + ' has an invalid address');
    return { name: str(p?.name, 200).trim(), email, org: str(p?.org, 200).trim() };
  });
  if (required && !list.length) throw new HttpError(400, 'Add a recipient.');
  return list;
}

function message(v: unknown) {
  const m = (v || {}) as Record<string, unknown>;
  const id = (m.identity || {}) as Record<string, unknown>;
  const from = str(id.addr, 254).trim().toLowerCase();
  if (!EMAIL_RE.test(from)) throw new HttpError(400, 'The message needs a From address.');
  const r = m.reply as Record<string, unknown> | undefined;
  if (r && (typeof r.threadId !== 'string' || !THREAD_RE.test(r.threadId))) throw new HttpError(400, 'Not a Gmail thread id');
  const subject = str(m.subject, 500);
  const text = str(m.text, 100_000);
  if (!subject.trim() && !text.trim()) throw new HttpError(400, 'The message is empty.');
  return {
    identity: { id: str(id.id, 200), addr: from, name: str(id.name, 200) },
    to: people(m.to, 'to', true), cc: people(m.cc ?? [], 'cc', false), bcc: people(m.bcc ?? [], 'bcc', false),
    subject, html: str(m.html, 300_000), text,
    priority: m.priority === 'High' || m.priority === 'Low' ? m.priority : 'Normal',
    reply: r ? { threadId: r.threadId as string, messageIdHeader: str(r.messageIdHeader, 1000), references: str(r.references, 8000), rootId: str(r.rootId, 1000) } : null
  };
}

function bulk(v: unknown) {
  const b = (v || {}) as Record<string, unknown>;
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_BULK) throw new HttpError(400, 'A campaign has 1 to ' + MAX_BULK + ' messages.');
  const from = str((b.identity as Record<string, unknown>)?.addr, 254).trim().toLowerCase();
  if (!EMAIL_RE.test(from)) throw new HttpError(400, 'The campaign needs a From address.');
  return {
    identity: { id: str((b.identity as Record<string, unknown>).id, 200), addr: from, name: str((b.identity as Record<string, unknown>).name, 200) },
    optout: b.optout === true,
    messages: b.messages.map((x: Record<string, unknown>) => {
      const to = people([x?.to], 'to', true)[0];
      const subject = str(x?.subject, 500);
      const text = str(x?.text, 20_000);
      if (!subject.trim() || !text.trim()) throw new HttpError(400, 'Every message needs a subject and a body.');
      return { to, persona: str(x?.persona, 60), subject, text };
    })
  };
}

const normalize = (kind: Kind, payload: unknown) => (kind === 'bulk_campaign' ? bulk(payload) : message(payload));
const hashOf = (kind: Kind, mailbox: string, payload: unknown) => sha256(JSON.stringify([kind, mailbox, payload]));

// ---------- records ----------

interface Row {
  id: number; kind: Kind; title: string; payload: string; content_hash: string; version: number; status: Status;
  requester: string; reviewer: string | null; note: string; mailbox: string; source_thread_id: string; approved_hash: string | null;
  requested_at: number; decided_at: number | null; executed_by: string | null; executed_at: number | null; result: string;
}

async function canSendFrom(env: Env, email: string, mailbox: string) {
  const r = await env.DB.prepare('SELECT can_send FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, email).first<{ can_send: number }>();
  return !!r?.can_send;
}

/** Whether `user` may decide on this request. */
async function canReview(env: Env, user: User, r: Pick<Row, 'kind' | 'requester' | 'mailbox'>): Promise<boolean> {
  if (r.kind === 'shared_reply') return r.requester !== user.memberEmail && (await canSendFrom(env, user.memberEmail, r.mailbox));
  if (!isAdmin(user)) return false;
  return r.requester !== user.memberEmail || user.role === 'super_admin';
}

async function canExecute(env: Env, user: User, r: Row): Promise<boolean> {
  if (r.kind === 'shared_reply') return r.requester !== user.memberEmail && (await canSendFrom(env, user.memberEmail, r.mailbox));
  return r.requester === user.memberEmail;
}

async function out(env: Env, user: User, r: Row) {
  return {
    id: r.id, kind: r.kind, title: r.title, payload: JSON.parse(r.payload) as unknown, contentHash: r.content_hash, version: r.version,
    status: r.status, requester: r.requester, reviewer: r.reviewer, note: r.note, mailbox: r.mailbox || null, sourceThreadId: r.source_thread_id || null,
    // Approved means approved as it is now; an edit after approval resets status, so this is belt and braces.
    approvedCurrent: r.approved_hash === r.content_hash && (r.status === 'approved' || r.status === 'executing' || r.status === 'executed'),
    requestedAt: r.requested_at, decidedAt: r.decided_at, executedBy: r.executed_by, executedAt: r.executed_at, result: r.result,
    canReview: (r.status === 'pending' || r.status === 'deferred') && (await canReview(env, user, r)),
    canExecute: r.status === 'approved' && r.approved_hash === r.content_hash && (await canExecute(env, user, r)),
    canEdit: ['pending', 'deferred', 'approved', 'rejected'].includes(r.status) && (r.requester === user.memberEmail || (await canReview(env, user, r)))
  };
}

async function visible(env: Env, user: User, id: number): Promise<Row> {
  const r = await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(id).first<Row>();
  if (!r) throw new HttpError(404, 'Approval request not found');
  if (r.requester === user.memberEmail || r.reviewer === user.memberEmail || r.executed_by === user.memberEmail) return r;
  // Eligible reviewers see the request too, whatever its status.
  const eligible = r.kind === 'shared_reply' ? await canSendFrom(env, user.memberEmail, r.mailbox) : isAdmin(user);
  if (!eligible) throw new HttpError(404, 'Approval request not found');
  return r;
}

async function event(env: Env, r: { id: number; version: number; content_hash: string }, actor: string, action: string, note = '') {
  await env.DB.prepare('INSERT INTO approval_events (approval_id, actor, action, version, content_hash, note, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(r.id, actor, action, r.version, r.content_hash, note, Date.now()).run();
}

async function create(env: Env, user: User, b: { kind?: unknown; title?: unknown; payload?: unknown; mailbox?: unknown; sourceThreadId?: unknown }) {
  if (typeof b.kind !== 'string' || !(KINDS as readonly string[]).includes(b.kind)) throw new HttpError(400, 'kind must be one of ' + KINDS.join(', '));
  const kind = b.kind as Kind;
  let mailbox = '';
  if (kind === 'shared_reply') {
    mailbox = str(b.mailbox, 254).trim().toLowerCase();
    const a = await env.DB.prepare('SELECT 1 FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, user.memberEmail).first();
    if (!a) throw new HttpError(403, "You don't have access to " + (mailbox || 'that mailbox') + '.', 'no_mailbox_access');
  }
  const payload = normalize(kind, b.payload);
  const title = str(b.title, 200).trim() || (kind === 'bulk_campaign' ? 'Campaign to ' + (payload as ReturnType<typeof bulk>).messages.length + ' recipients' : (payload as ReturnType<typeof message>).subject || '(no subject)');
  const thread = str(b.sourceThreadId, 64);
  if (thread && !THREAD_RE.test(thread)) throw new HttpError(400, 'Not a Gmail thread id');
  const hash = await hashOf(kind, mailbox, payload);
  const res = await env.DB.prepare(`INSERT INTO approvals (kind, title, payload, content_hash, requester, mailbox, source_thread_id, requested_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(kind, title, JSON.stringify(payload), hash, user.memberEmail, mailbox, thread, Date.now()).run();
  const id = Number(res.meta.last_row_id);
  await event(env, { id, version: 1, content_hash: hash }, user.memberEmail, 'requested');
  return out(env, user, (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(id).first<Row>())!);
}

function stale(r: Row, b: { version?: unknown; contentHash?: unknown }) {
  if (Number(b.version) !== r.version || b.contentHash !== r.content_hash) {
    throw new HttpError(409, 'This request changed since you opened it. Review the current version.', 'approval_changed');
  }
}

async function decide(env: Env, user: User, r: Row, b: { decision?: unknown; version?: unknown; contentHash?: unknown; note?: unknown }) {
  const decision = b.decision;
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'defer') throw new HttpError(400, 'decision must be approve, reject or defer');
  if (r.status !== 'pending' && r.status !== 'deferred') throw new HttpError(409, 'This request is already ' + r.status + '.', 'approval_decided');
  if (!(await canReview(env, user, r))) {
    throw new HttpError(403, r.requester === user.memberEmail ? 'Ask someone else to approve your own request.' : r.kind === 'shared_reply' ? 'Only a member who can send from ' + r.mailbox + ' approves this.' : 'Only an admin approves this.');
  }
  stale(r, b);
  const status: Status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'deferred';
  const note = str(b.note, 1000).trim();
  if (decision === 'reject' && !note) throw new HttpError(400, 'Say why, so the requester can fix it.');
  const res = await env.DB.prepare(`UPDATE approvals SET status = ?2, reviewer = ?3, note = ?4, decided_at = ?5, approved_hash = ?6
    WHERE id = ?1 AND version = ?7 AND content_hash = ?8 AND status IN ('pending', 'deferred')`)
    .bind(r.id, status, user.memberEmail, note, Date.now(), status === 'approved' ? r.content_hash : null, r.version, r.content_hash).run();
  if (!res.meta.changes) throw new HttpError(409, 'This request changed since you opened it. Review the current version.', 'approval_changed');
  await event(env, r, user.memberEmail, status, note);
  return out(env, user, (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(r.id).first<Row>())!);
}

/** A change to the content is a new version; any earlier approval no longer covers it. */
async function edit(env: Env, user: User, r: Row, b: { payload?: unknown; title?: unknown; version?: unknown; contentHash?: unknown }) {
  if (!['pending', 'deferred', 'approved', 'rejected'].includes(r.status)) throw new HttpError(409, 'This request is ' + r.status + ' and can no longer change.', 'approval_closed');
  if (r.requester !== user.memberEmail && !(await canReview(env, user, r))) throw new HttpError(403, 'Only the requester or a reviewer edits this.');
  stale(r, b);
  const payload = normalize(r.kind, b.payload);
  const hash = await hashOf(r.kind, r.mailbox, payload);
  const title = b.title === undefined ? r.title : str(b.title, 200).trim() || r.title;
  if (hash === r.content_hash && title === r.title) return out(env, user, r);
  const res = await env.DB.prepare(`UPDATE approvals SET payload = ?2, content_hash = ?3, title = ?4, version = version + 1, status = 'pending',
    approved_hash = NULL, reviewer = NULL, decided_at = NULL, note = '' WHERE id = ?1 AND version = ?5 AND content_hash = ?6`)
    .bind(r.id, JSON.stringify(payload), hash, title, r.version, r.content_hash).run();
  if (!res.meta.changes) throw new HttpError(409, 'This request changed since you opened it. Review the current version.', 'approval_changed');
  const after = (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(r.id).first<Row>())!;
  await event(env, after, user.memberEmail, hash === r.content_hash ? 'renamed' : r.status === 'approved' ? 'edited_after_approval' : 'edited');
  return out(env, user, after);
}

/** Claim the execution. Succeeds once, only for the approved content; returns the payload to send. */
async function execute(env: Env, user: User, r: Row, b: { contentHash?: unknown }) {
  if (!(await canExecute(env, user, r))) throw new HttpError(403, r.kind === 'shared_reply' ? 'A member who can send from ' + r.mailbox + ' sends this.' : 'Only the requester sends this.');
  const res = await env.DB.prepare(`UPDATE approvals SET status = 'executing', executed_by = ?2, executed_at = ?3
    WHERE id = ?1 AND status = 'approved' AND content_hash = ?4 AND approved_hash = content_hash`)
    .bind(r.id, user.memberEmail, Date.now(), typeof b.contentHash === 'string' ? b.contentHash : '').run();
  if (!res.meta.changes) {
    const now = (await env.DB.prepare('SELECT status, content_hash, approved_hash FROM approvals WHERE id = ?1').bind(r.id).first<{ status: Status; content_hash: string; approved_hash: string | null }>())!;
    if (now.status === 'executing' || now.status === 'executed' || now.status === 'failed') throw new HttpError(409, 'This was already sent (or is being sent). It won’t be sent twice.', 'already_executed');
    if (now.status !== 'approved' || now.approved_hash !== now.content_hash) throw new HttpError(409, 'This isn’t approved as it is now. It needs approval again.', 'not_approved');
    throw new HttpError(409, 'This request changed since you opened it. Review the current version.', 'approval_changed');
  }
  await event(env, r, user.memberEmail, 'executing');
  return { approval: await out(env, user, (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(r.id).first<Row>())!), payload: JSON.parse(r.payload) as unknown };
}

async function result(env: Env, user: User, r: Row, b: { ok?: unknown; detail?: unknown }) {
  if (r.status !== 'executing' || r.executed_by !== user.memberEmail) throw new HttpError(409, 'Nothing is being sent for this request.');
  const status: Status = b.ok === true ? 'executed' : 'failed';
  await env.DB.prepare('UPDATE approvals SET status = ?2, result = ?3 WHERE id = ?1').bind(r.id, status, str(b.detail, 4000)).run();
  await event(env, r, user.memberEmail, status, str(b.detail, 1000));
  return out(env, user, (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(r.id).first<Row>())!);
}

async function list(env: Env, user: User, q: URLSearchParams) {
  const scope = q.get('scope') || 'queue';
  let rows: Row[];
  if (scope === 'mine') {
    rows = (await env.DB.prepare('SELECT * FROM approvals WHERE requester = ?1 ORDER BY requested_at DESC LIMIT 200').bind(user.memberEmail).all<Row>()).results;
  } else {
    const statuses = scope === 'history' ? "('approved', 'rejected', 'executing', 'executed', 'failed', 'withdrawn')" : "('pending', 'deferred')";
    const all = (await env.DB.prepare('SELECT * FROM approvals WHERE status IN ' + statuses + ' ORDER BY ' + (scope === 'history' ? 'COALESCE(decided_at, requested_at) DESC' : 'requested_at') + ' LIMIT 500').all<Row>()).results;
    rows = [];
    for (const r of all) {
      if (scope === 'history' && (r.requester === user.memberEmail || r.reviewer === user.memberEmail)) { rows.push(r); continue; }
      const eligible = r.kind === 'shared_reply' ? await canSendFrom(env, user.memberEmail, r.mailbox) : isAdmin(user);
      if (eligible && (scope === 'history' || r.requester !== user.memberEmail || user.role === 'super_admin')) rows.push(r);
    }
  }
  return Promise.all(rows.map(r => out(env, user, r)));
}

/** Notifications for Tasks: requests waiting for this member, and decisions on theirs. */
export async function inboxForApprovals(env: Env, user: User, since: number) {
  const items: { kind: string; text: string; at: number; approvalId: number }[] = [];
  for (const a of await list(env, user, new URLSearchParams({ scope: 'queue' }))) {
    if (a.canReview) items.push({ kind: 'approval_pending', text: a.requester + ' asks for approval: ' + a.title, at: a.requestedAt, approvalId: a.id });
  }
  const decided = (await env.DB.prepare(`SELECT e.approval_id, e.actor, e.action, e.note, e.at, a.title FROM approval_events e JOIN approvals a ON a.id = e.approval_id
    WHERE a.requester = ?1 AND e.actor != ?1 AND e.action IN ('approved', 'rejected', 'deferred') AND e.at > ?2 ORDER BY e.at DESC LIMIT 50`)
    .bind(user.memberEmail, since).all<{ approval_id: number; actor: string; action: string; note: string; at: number; title: string }>()).results;
  for (const d of decided) items.push({ kind: 'approval_' + d.action, text: d.actor + ' ' + d.action + ' “' + d.title + '”' + (d.note ? ': ' + d.note : ''), at: d.at, approvalId: d.approval_id });
  return items;
}

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const path = url.pathname;
  const m = req.method;
  if (path === '/api/approvals') {
    if (m === 'GET') return json({ approvals: await list(env, user, url.searchParams) });
    if (m === 'POST') return json({ approval: await create(env, user, await readJson(req)) }, 201);
  }
  const one = /^\/api\/approvals\/(\d+)(\/decide|\/execute|\/result|\/withdraw|\/events)?$/.exec(path);
  if (!one) throw new HttpError(404, 'Not found');
  const r = await visible(env, user, Number(one[1]));
  switch (one[2]) {
    case undefined:
      if (m === 'GET') return json({ approval: await out(env, user, r) });
      if (m === 'PUT') return json({ approval: await edit(env, user, r, await readJson(req)) });
      break;
    case '/events':
      if (m === 'GET') return json({ events: (await env.DB.prepare('SELECT actor, action, version, content_hash AS contentHash, note, at FROM approval_events WHERE approval_id = ?1 ORDER BY at, id').bind(r.id).all()).results });
      break;
    case '/decide': if (m === 'POST') return json({ approval: await decide(env, user, r, await readJson(req)) }); break;
    case '/execute': if (m === 'POST') return json(await execute(env, user, r, await readJson(req))); break;
    case '/result': if (m === 'POST') return json({ approval: await result(env, user, r, await readJson(req)) }); break;
    case '/withdraw':
      if (m === 'POST') {
        if (r.requester !== user.memberEmail) throw new HttpError(403, 'Only the requester withdraws a request.');
        if (!['pending', 'deferred', 'approved', 'rejected'].includes(r.status)) throw new HttpError(409, 'This request is ' + r.status + '.');
        await env.DB.prepare("UPDATE approvals SET status = 'withdrawn' WHERE id = ?1").bind(r.id).run();
        await event(env, r, user.memberEmail, 'withdrawn');
        return json({ approval: await out(env, user, (await env.DB.prepare('SELECT * FROM approvals WHERE id = ?1').bind(r.id).first<Row>())!) });
      }
      break;
  }
  throw new HttpError(405, 'Method not allowed');
}
