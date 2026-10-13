import type { Env } from './env';
import type { User } from './auth';
import { delegatedToken, delegationEnabled, refreshTokenEmail, serviceAccount } from './delegation';
import { HttpError, json, readJson } from './http';
import { mentionable } from './notes';

/**
 * Shared Inboxes: assignment, team status (open / pending / resolved),
 * presence, and an audit log for conversations in shared mailboxes. These are
 * application states only: Gmail's read, label and archive state is never
 * changed by them. Every route checks the member's access to the mailbox, and
 * every row is keyed by mailbox, so one mailbox never reveals another's.
 */

export type Status = 'open' | 'pending' | 'resolved';
const STATUSES: Status[] = ['open', 'pending', 'resolved'];
const PRESENCE_MS = 2 * 60_000;
const THREAD_RE = /^[\w-]{1,100}$/;

export interface Access { canSend: boolean }

/** The member's access to `mailbox`, or 403. */
export async function access(env: Env, user: User, mailbox: string): Promise<Access> {
  const r = await env.DB.prepare('SELECT can_send FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, user.memberEmail).first<{ can_send: number }>();
  if (!r) throw new HttpError(403, "You don't have access to " + mailbox + '.', 'no_mailbox_access');
  return { canSend: !!r.can_send };
}

const threadId = (v: unknown) => {
  if (typeof v !== 'string' || !THREAD_RE.test(v)) throw new HttpError(400, 'Not a Gmail thread id');
  return v;
};

async function gmail<T>(env: Env, mailbox: string, path: string): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + (await delegatedToken(env, mailbox)) } });
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

// ---------- connection, members, send-as ----------

export interface SendAs { email: string; name: string; primary: boolean; verified: boolean }
const sendAsCache = new Map<string, { at: number; list: SendAs[] }>();
const probeCache = new Map<string, { at: number; ok: boolean; error: string | null }>();
const CACHE_MS = 5 * 60_000;

/** The addresses Gmail lets this mailbox send as (primary, or verified aliases). */
export async function sendAsFor(env: Env, mailbox: string): Promise<SendAs[]> {
  const hit = sendAsCache.get(mailbox);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const r = await gmail<{ sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; verificationStatus?: string }[] }>(env, mailbox, 'settings/sendAs');
  if (!r.ok) throw new HttpError(502, 'Could not read the send-as addresses of ' + mailbox + ' (' + r.status + ').', 'delegation_failed');
  const list = (r.body.sendAs || []).map(s => ({
    email: s.sendAsEmail.toLowerCase(), name: s.displayName || '', primary: !!s.isPrimary, verified: !!s.isPrimary || s.verificationStatus === 'accepted'
  }));
  sendAsCache.set(mailbox, { at: Date.now(), list });
  return list;
}

async function probe(env: Env, mailbox: string) {
  const hit = probeCache.get(mailbox);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  let out: { at: number; ok: boolean; error: string | null };
  try {
    const r = await gmail(env, mailbox, 'profile');
    out = { at: Date.now(), ok: r.ok, error: r.ok ? null : 'Gmail answered ' + r.status };
  } catch (e) {
    out = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  probeCache.set(mailbox, out);
  return out;
}

/** Test hook. */
export function clearSharedCache() { sendAsCache.clear(); probeCache.clear(); }

/** GET /api/shared: each shared mailbox the member may open, with its connection, members and permissions. */
async function mailboxes(env: Env, user: User) {
  if (!delegationEnabled(env)) return { enabled: false, you: user.memberEmail, mailboxes: [] };
  const mine = (await env.DB.prepare('SELECT mailbox, can_send FROM mailbox_access WHERE member_email = ?1 AND mailbox != ?1 ORDER BY mailbox')
    .bind(user.memberEmail).all<{ mailbox: string; can_send: number }>()).results;
  const names = new Map((await mentionable(env)).map(m => [m.email, m.name]));
  const via = serviceAccount(env) ? 'delegation' : 'refresh_token';
  const tokenMailbox = via === 'refresh_token' ? await refreshTokenEmail(env) : null;
  const out = [];
  for (const m of mine) {
    const members = (await env.DB.prepare('SELECT member_email, can_send FROM mailbox_access WHERE mailbox = ?1 ORDER BY member_email').bind(m.mailbox)
      .all<{ member_email: string; can_send: number }>()).results;
    const conn = await probe(env, m.mailbox);
    let sendAs: SendAs[] = [];
    if (conn.ok) sendAs = await sendAsFor(env, m.mailbox).catch(() => []);
    out.push({
      mailbox: m.mailbox,
      connection: { ok: conn.ok, via: via === 'refresh_token' && tokenMailbox === m.mailbox ? 'refresh_token' : via, error: conn.error, checkedAt: conn.at },
      members: members.map(x => ({ email: x.member_email, name: names.get(x.member_email) || x.member_email.split('@')[0], canSend: !!x.can_send })),
      me: { canSend: !!m.can_send },
      sendAs: sendAs.filter(s => s.verified).map(s => ({ email: s.email, name: s.name, primary: s.primary })),
      // Conversations are read live from Gmail on every view; nothing is copied, so there is nothing to fall behind.
      sync: 'live'
    });
  }
  return { enabled: true, you: user.memberEmail, mailboxes: out };
}

// ---------- conversation state ----------

interface StateRow { thread_id: string; status: Status; assignee: string | null; version: number; updated_by: string; updated_at: number; last_reply_by: string | null; last_reply_at: number | null }

export interface ConversationState {
  threadId: string; status: Status; assignee: string | null; version: number; updatedBy: string | null; updatedAt: number | null;
  lastReplyBy: string | null; lastReplyAt: number | null;
  /** Other members with the conversation open in the last two minutes. */
  presence: { email: string; state: 'viewing' | 'replying' }[];
}

const blank = (id: string): ConversationState => ({ threadId: id, status: 'open', assignee: null, version: 0, updatedBy: null, updatedAt: null, lastReplyBy: null, lastReplyAt: null, presence: [] });
const toState = (r: StateRow): ConversationState => ({
  threadId: r.thread_id, status: r.status, assignee: r.assignee, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at,
  lastReplyBy: r.last_reply_by, lastReplyAt: r.last_reply_at, presence: []
});

export async function stateOf(env: Env, mailbox: string, id: string): Promise<ConversationState> {
  const r = await env.DB.prepare('SELECT * FROM shared_conversations WHERE mailbox = ?1 AND thread_id = ?2').bind(mailbox, id).first<StateRow>();
  return r ? toState(r) : blank(id);
}

async function states(env: Env, user: User, mailbox: string, ids: string[]): Promise<Record<string, ConversationState>> {
  const out: Record<string, ConversationState> = {};
  for (const id of ids) out[id] = blank(id);
  if (!ids.length) return out;
  const marks = ids.map((_, i) => '?' + (i + 2)).join(',');
  for (const r of (await env.DB.prepare(`SELECT * FROM shared_conversations WHERE mailbox = ?1 AND thread_id IN (${marks})`).bind(mailbox, ...ids).all<StateRow>()).results) out[r.thread_id] = toState(r);
  const pres = (await env.DB.prepare(`SELECT thread_id, member_email, state FROM shared_presence WHERE mailbox = ?1 AND thread_id IN (${marks}) AND updated_at > ?${ids.length + 2} AND member_email != ?${ids.length + 3}`)
    .bind(mailbox, ...ids, Date.now() - PRESENCE_MS, user.memberEmail).all<{ thread_id: string; member_email: string; state: 'viewing' | 'replying' }>()).results;
  for (const p of pres) out[p.thread_id].presence.push({ email: p.member_email, state: p.state });
  return out;
}

/** Threads with a stored state, for owner and status filters beyond the page in view. */
async function listStates(env: Env, mailbox: string, p: URLSearchParams) {
  const where = ['mailbox = ?1'];
  const args: unknown[] = [mailbox];
  const status = p.get('status');
  if (status && (STATUSES as string[]).includes(status)) { args.push(status); where.push(`status = ?${args.length}`); }
  const assignee = p.get('assignee');
  if (assignee === 'none') where.push('assignee IS NULL');
  else if (assignee) { args.push(assignee.toLowerCase()); where.push(`assignee = ?${args.length}`); }
  return (await env.DB.prepare(`SELECT * FROM shared_conversations WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`).bind(...args).all<StateRow>()).results.map(toState);
}

export async function log(env: Env, mailbox: string, id: string, actor: string, action: string, detail = '') {
  await env.DB.prepare('INSERT INTO shared_activity (mailbox, thread_id, actor, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(mailbox, id, actor, action, detail.slice(0, 254), Date.now()).run();
}

/**
 * Change the assignee and/or status. The caller names the version it saw;
 * if someone changed it since, nothing is written and 409 returns the current state.
 */
async function update(env: Env, user: User, mailbox: string, id: string, b: { expectedVersion?: unknown; assignee?: unknown; status?: unknown }): Promise<ConversationState> {
  const expected = Number(b.expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) throw new HttpError(400, 'expectedVersion is required');
  const cur = await stateOf(env, mailbox, id);
  let assignee = cur.assignee;
  if (b.assignee !== undefined) {
    if (b.assignee === null || b.assignee === '') assignee = null;
    else {
      const e = String(b.assignee).trim().toLowerCase();
      const ok = await env.DB.prepare('SELECT 1 FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, e).first();
      if (!ok) throw new HttpError(400, e + " can't open " + mailbox + ', so the conversation can’t be assigned to them.');
      assignee = e;
    }
  }
  let status = cur.status;
  if (b.status !== undefined) {
    if (!(STATUSES as unknown[]).includes(b.status)) throw new HttpError(400, 'status must be open, pending or resolved');
    status = b.status as Status;
  }
  const conflict = async () => {
    const latest = await stateOf(env, mailbox, id);
    return Object.assign(new HttpError(409, (latest.updatedBy || 'Someone') + ' changed this conversation a moment ago. Check it and try again.', 'conflict'), { current: latest });
  };
  if (expected !== cur.version) throw await conflict();
  const now = Date.now();
  const r = cur.version === 0
    ? await env.DB.prepare(`INSERT INTO shared_conversations (mailbox, thread_id, status, assignee, version, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
        ON CONFLICT DO NOTHING`).bind(mailbox, id, status, assignee, user.memberEmail, now).run()
    : await env.DB.prepare('UPDATE shared_conversations SET status = ?1, assignee = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE mailbox = ?5 AND thread_id = ?6 AND version = ?7')
      .bind(status, assignee, user.memberEmail, now, mailbox, id, expected).run();
  // Someone else wrote between our read and our write.
  if (!r.meta.changes) throw await conflict();
  if (assignee !== cur.assignee) {
    const action = assignee === user.memberEmail && !cur.assignee ? 'claimed'
      : !assignee && cur.assignee === user.memberEmail ? 'released'
        : !assignee ? 'unassigned' : 'assigned';
    await log(env, mailbox, id, user.memberEmail, action, assignee || cur.assignee || '');
  }
  if (status !== cur.status) await log(env, mailbox, id, user.memberEmail, 'status', status);
  return stateOf(env, mailbox, id);
}

async function activity(env: Env, mailbox: string, id: string) {
  return (await env.DB.prepare('SELECT actor, action, detail, created_at FROM shared_activity WHERE mailbox = ?1 AND thread_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 100')
    .bind(mailbox, id).all<{ actor: string; action: string; detail: string; created_at: number }>()).results
    .map(r => ({ actor: r.actor, action: r.action, detail: r.detail, at: r.created_at }));
}

async function presence(env: Env, user: User, mailbox: string, id: string, state: unknown) {
  if (state === 'gone') {
    await env.DB.prepare('DELETE FROM shared_presence WHERE mailbox = ?1 AND thread_id = ?2 AND member_email = ?3').bind(mailbox, id, user.memberEmail).run();
    return;
  }
  if (state !== 'viewing' && state !== 'replying') throw new HttpError(400, 'state must be viewing, replying or gone');
  await env.DB.prepare(`INSERT INTO shared_presence (mailbox, thread_id, member_email, state, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (mailbox, thread_id, member_email) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).bind(mailbox, id, user.memberEmail, state, Date.now()).run();
}

// ---------- sending (called by the Gmail proxy) ----------

/** Refuse a send the member may not make, from an address Gmail would not use. */
export async function checkSendAs(env: Env, user: User, mailbox: string, from: string, thread: string | null) {
  const allowed = await sendAsFor(env, mailbox);
  const hit = allowed.find(s => s.email === from.toLowerCase());
  if (!hit || !hit.verified) {
    await log(env, mailbox, thread || '', user.memberEmail, 'send_refused', 'from ' + (from || 'no address'));
    throw new HttpError(403, from ? mailbox + ' can’t send as ' + from + ' in Gmail. Pick one of: ' + allowed.filter(s => s.verified).map(s => s.email).join(', ') + '.'
      : 'The message has no From address.', 'send_as_not_allowed');
  }
}

/**
 * Before a reply goes out: has someone else replied since the composer loaded
 * the conversation, or is it assigned to someone else? Refuses with 409 unless
 * the member confirmed. This is a check at send time, not a lock.
 */
export async function checkReply(env: Env, user: User, mailbox: string, thread: string, seen: string | null, confirmed: boolean) {
  if (confirmed) return;
  const st = await stateOf(env, mailbox, thread);
  const problems: string[] = [];
  if (seen) {
    const t = await gmail<{ messages?: { id: string; labelIds?: string[] }[] }>(env, mailbox, 'threads/' + thread + '?format=minimal');
    const msgs = t.body.messages || [];
    const i = msgs.findIndex(m => m.id === seen);
    const newer = i >= 0 ? msgs.slice(i + 1) : [];
    if (newer.some(m => m.labelIds?.includes('SENT') && !m.labelIds.includes('DRAFT'))) {
      const by = st.lastReplyBy && st.lastReplyBy !== user.memberEmail ? st.lastReplyBy : 'Someone';
      problems.push(by + ' already replied from ' + mailbox + ' after you opened this conversation.');
    }
  }
  if (st.assignee && st.assignee !== user.memberEmail) problems.push('It is assigned to ' + st.assignee + '.');
  if (problems.length) throw new HttpError(409, problems.join(' ') + ' Send anyway?', 'reply_conflict');
}

export async function recordReply(env: Env, user: User, mailbox: string, thread: string, from: string) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO shared_conversations (mailbox, thread_id, status, assignee, version, updated_by, updated_at, last_reply_by, last_reply_at)
    VALUES (?1, ?2, 'open', NULL, 1, ?3, ?4, ?3, ?4)
    ON CONFLICT (mailbox, thread_id) DO UPDATE SET last_reply_by = excluded.last_reply_by, last_reply_at = excluded.last_reply_at`).bind(mailbox, thread, user.memberEmail, now).run();
  await env.DB.prepare('DELETE FROM shared_presence WHERE mailbox = ?1 AND thread_id = ?2 AND member_email = ?3').bind(mailbox, thread, user.memberEmail).run();
  await log(env, mailbox, thread, user.memberEmail, 'replied', from);
}

// ---------- routing ----------

/**
 * Workload for a shared mailbox: conversations by team status and assignee,
 * and replies sent per member in the period, from the tables above. Counts
 * only; members are listed by name, never ranked.
 */
async function summary(env: Env, mailbox: string, p: URLSearchParams) {
  const to = Number(p.get('to')) || Date.now();
  const from = Number(p.get('from')) || to - 30 * 86_400_000;
  const rows = (await env.DB.prepare('SELECT status, assignee, COUNT(*) AS n FROM shared_conversations WHERE mailbox = ?1 GROUP BY status, assignee')
    .bind(mailbox).all<{ status: Status; assignee: string | null; n: number }>()).results;
  const byStatus: Record<Status, number> = { open: 0, pending: 0, resolved: 0 };
  const people = new Map<string, Record<Status, number>>();
  let unassignedOpen = 0;
  for (const r of rows) {
    byStatus[r.status] += r.n;
    if (!r.assignee) { if (r.status !== 'resolved') unassignedOpen += r.n; continue; }
    const x = people.get(r.assignee) || { open: 0, pending: 0, resolved: 0 };
    x[r.status] += r.n;
    people.set(r.assignee, x);
  }
  const acts = (await env.DB.prepare(`SELECT actor, action, COUNT(*) AS n FROM shared_activity WHERE mailbox = ?1 AND created_at >= ?2 AND created_at <= ?3
    AND action IN ('replied', 'claimed', 'assigned') GROUP BY actor, action`).bind(mailbox, from, to).all<{ actor: string; action: string; n: number }>()).results;
  const members = (await env.DB.prepare('SELECT member_email FROM mailbox_access WHERE mailbox = ?1 ORDER BY member_email').bind(mailbox).all<{ member_email: string }>()).results.map(r => r.member_email);
  for (const a of acts) if (!people.has(a.actor) && members.includes(a.actor)) people.set(a.actor, { open: 0, pending: 0, resolved: 0 });
  for (const m of members) if (!people.has(m)) people.set(m, { open: 0, pending: 0, resolved: 0 });
  return {
    from, to, byStatus,
    /** Conversations with a stored state and no assignee that aren't resolved. Conversations nobody touched yet aren't counted here. */
    unassignedTracked: unassignedOpen,
    workload: [...people].sort((a, b) => a[0].localeCompare(b[0])).map(([email, c]) => ({
      email, ...c,
      replies: acts.filter(a => a.actor === email && a.action === 'replied').reduce((n, a) => n + a.n, 0),
      assignmentsTaken: acts.filter(a => a.actor === email && a.action === 'claimed').reduce((n, a) => n + a.n, 0)
    }))
  };
}

const ROUTE = /^\/api\/shared\/([^/]+)\/threads(?:\/([\w-]+)(?:\/(activity|presence))?)?$/;
const SUMMARY = /^\/api\/shared\/([^/]+)\/summary$/;

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (url.pathname === '/api/shared' && req.method === 'GET') return json(await mailboxes(env, user));
  const sm = SUMMARY.exec(url.pathname);
  if (sm && req.method === 'GET') {
    const mailbox = decodeURIComponent(sm[1]).toLowerCase();
    await access(env, user, mailbox);
    return json(await summary(env, mailbox, url.searchParams));
  }
  const m = ROUTE.exec(url.pathname);
  if (!m) throw new HttpError(404, 'Not found');
  const mailbox = decodeURIComponent(m[1]).toLowerCase();
  await access(env, user, mailbox);
  if (!m[2]) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 100).map(threadId);
    if (ids.length) return json({ states: await states(env, user, mailbox, ids) });
    return json({ states: await listStates(env, mailbox, url.searchParams) });
  }
  const id = threadId(m[2]);
  if (!m[3]) {
    if (req.method === 'GET') return json({ state: (await states(env, user, mailbox, [id]))[id], activity: await activity(env, mailbox, id), you: user.memberEmail });
    if (req.method === 'PATCH') {
      try {
        return json({ state: await update(env, user, mailbox, id, await readJson(req)) });
      } catch (e) {
        const cur = (e as { current?: ConversationState }).current;
        if (e instanceof HttpError && cur) return json({ error: e.message, code: e.code, current: cur }, 409);
        throw e;
      }
    }
  }
  if (m[3] === 'activity' && req.method === 'GET') return json({ activity: await activity(env, mailbox, id) });
  if (m[3] === 'presence' && req.method === 'POST') { await presence(env, user, mailbox, id, (await readJson<{ state?: unknown }>(req)).state); return json({ ok: true }); }
  throw new HttpError(405, 'Method not allowed');
}
