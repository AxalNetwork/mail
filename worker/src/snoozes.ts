import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';
import { delegatedToken, refreshTokenEmail, serviceAccount } from './delegation';
import { log } from './shared';

/**
 * Snooze. The browser hides the conversation in Gmail (label "Snoozed", out of
 * the inbox) and records here when it should come back. Waking it up means
 * putting INBOX and UNREAD back and removing the label:
 * - the cron does it for mailboxes the Worker can reach (domain-wide
 *   delegation, or the mailbox behind GMAIL_REFRESH_TOKEN);
 * - otherwise the app does it with the member's own access when it is open.
 * A reply from someone else wakes a conversation early.
 */

const THREAD_RE = /^[\w-]{1,100}$/;
const LABEL_RE = /^[\w-]{1,100}$/;
const MAX_AHEAD = 366 * 86_400_000;

interface Row { mailbox: string; thread_id: string; until: number; label_id: string; last_message_id: string; created_by: string; created_at: number }

const isShared = async (env: Env, mailbox: string) => !!(await env.DB.prepare('SELECT 1 FROM mailbox_access WHERE mailbox = ?1 LIMIT 1').bind(mailbox).first());

/** A member snoozes in their own Google account's mailbox, or in a shared mailbox they can open. */
async function checkMailbox(env: Env, user: User, v: unknown): Promise<string> {
  const mailbox = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!mailbox) throw new HttpError(400, 'mailbox is required');
  if (mailbox === user.email.toLowerCase()) return mailbox;
  const ok = await env.DB.prepare('SELECT 1 FROM mailbox_access WHERE mailbox = ?1 AND member_email = ?2').bind(mailbox, user.memberEmail).first();
  if (!ok) throw new HttpError(403, "You don't have access to " + mailbox + '.', 'no_mailbox_access');
  return mailbox;
}

/** The Worker can wake conversations in this mailbox on its own. */
export async function serverCanWake(env: Env, mailbox: string): Promise<boolean> {
  if (serviceAccount(env)) return true;
  return !!(env.GMAIL_REFRESH_TOKEN && env.GMAIL_CLIENT_SECRET && (await refreshTokenEmail(env)) === mailbox);
}

const out = (r: Row) => ({ threadId: r.thread_id, until: r.until, labelId: r.label_id, lastMessageId: r.last_message_id, createdBy: r.created_by, createdAt: r.created_at });

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (url.pathname !== '/api/snoozes') throw new HttpError(404, 'Not found');
  if (req.method === 'GET') {
    const mailbox = await checkMailbox(env, user, url.searchParams.get('mailbox'));
    const rows = (await env.DB.prepare('SELECT * FROM snoozes WHERE mailbox = ?1 ORDER BY until').bind(mailbox).all<Row>()).results;
    return json({ snoozes: rows.map(out), serverWakes: await serverCanWake(env, mailbox) });
  }
  if (req.method === 'POST') {
    const b = await readJson<{ mailbox?: unknown; threadId?: unknown; until?: unknown; labelId?: unknown; lastMessageId?: unknown }>(req);
    const mailbox = await checkMailbox(env, user, b.mailbox);
    const thread = typeof b.threadId === 'string' && THREAD_RE.test(b.threadId) ? b.threadId : null;
    const label = typeof b.labelId === 'string' && LABEL_RE.test(b.labelId) ? b.labelId : null;
    const until = Number(b.until);
    if (!thread || !label) throw new HttpError(400, 'threadId and labelId are required');
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + MAX_AHEAD) throw new HttpError(400, 'Pick a time in the future, within a year.');
    const last = typeof b.lastMessageId === 'string' && THREAD_RE.test(b.lastMessageId) ? b.lastMessageId : '';
    await env.DB.prepare(`INSERT INTO snoozes (mailbox, thread_id, until, label_id, last_message_id, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (mailbox, thread_id) DO UPDATE SET until = excluded.until, label_id = excluded.label_id, last_message_id = excluded.last_message_id, created_by = excluded.created_by, created_at = excluded.created_at`)
      .bind(mailbox, thread, until, label, last, user.memberEmail, Date.now()).run();
    if (await isShared(env, mailbox) && mailbox !== user.email.toLowerCase()) await log(env, mailbox, thread, user.memberEmail, 'snoozed', String(until));
    return json({ ok: true, serverWakes: await serverCanWake(env, mailbox) }, 201);
  }
  if (req.method === 'DELETE') {
    const mailbox = await checkMailbox(env, user, url.searchParams.get('mailbox'));
    const thread = url.searchParams.get('threadId') || '';
    if (!THREAD_RE.test(thread)) throw new HttpError(400, 'threadId is required');
    const reason = url.searchParams.get('reason') === 'woke' ? 'woke' : 'unsnoozed';
    const r = await env.DB.prepare('DELETE FROM snoozes WHERE mailbox = ?1 AND thread_id = ?2').bind(mailbox, thread).run();
    if (r.meta.changes && await isShared(env, mailbox) && mailbox !== user.email.toLowerCase()) await log(env, mailbox, thread, user.memberEmail, reason);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

// ---------- cron ----------

type GmailThread = { messages?: { id: string; labelIds?: string[] }[] };

/** Due now, or someone wrote after it was snoozed: bring it back. Already back in the inbox elsewhere: just forget it. */
export function wakeReason(r: Pick<Row, 'until' | 'label_id' | 'last_message_id'>, t: GmailThread, now: number): 'due' | 'reply' | 'gone' | null {
  const msgs = t.messages || [];
  const labels = new Set(msgs.flatMap(m => m.labelIds || []));
  // Back in the inbox, label removed, or trashed elsewhere: nothing to bring back.
  if (labels.has('INBOX') || labels.has('TRASH') || !labels.has(r.label_id)) return 'gone';
  if (r.until <= now) return 'due';
  const i = msgs.findIndex(m => m.id === r.last_message_id);
  if (i >= 0 && msgs.slice(i + 1).some(m => !m.labelIds?.includes('SENT') && !m.labelIds?.includes('DRAFT'))) return 'reply';
  return null;
}

/** Wake what is due (or answered) in mailboxes the Worker can reach. */
export async function runSnoozes(env: Env, now = Date.now()): Promise<{ woke: number; skipped: number }> {
  const rows = (await env.DB.prepare('SELECT * FROM snoozes ORDER BY until LIMIT 200').all<Row>()).results;
  let woke = 0, skipped = 0;
  const reach = new Map<string, boolean>();
  for (const r of rows) {
    if (!reach.has(r.mailbox)) reach.set(r.mailbox, await serverCanWake(env, r.mailbox));
    if (!reach.get(r.mailbox)) { skipped++; continue; }
    // Only look at threads that are due, or recent enough that a reply matters (checked every run).
    try {
      const token = await delegatedToken(env, r.mailbox);
      const g = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/' + r.thread_id;
      const res = await fetch(g + '?format=minimal', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 404) { await env.DB.prepare('DELETE FROM snoozes WHERE mailbox = ?1 AND thread_id = ?2').bind(r.mailbox, r.thread_id).run(); continue; }
      if (!res.ok) { skipped++; continue; }
      const why = wakeReason(r, (await res.json()) as GmailThread, now);
      if (!why) continue;
      if (why !== 'gone') {
        const m = await fetch(g + '/modify', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ addLabelIds: ['INBOX', 'UNREAD'], removeLabelIds: [r.label_id] })
        });
        if (!m.ok) { skipped++; continue; }
        woke++;
      }
      await env.DB.prepare('DELETE FROM snoozes WHERE mailbox = ?1 AND thread_id = ?2').bind(r.mailbox, r.thread_id).run();
      if (why !== 'gone' && await isShared(env, r.mailbox)) await log(env, r.mailbox, r.thread_id, 'axal-mail', 'woke', why);
    } catch (e) {
      console.warn('Snooze wake-up failed for', r.mailbox, r.thread_id, e);
      skipped++;
    }
  }
  return { woke, skipped };
}
