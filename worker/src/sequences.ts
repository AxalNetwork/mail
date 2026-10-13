import type { Env } from './env';
import type { User } from './auth';
import { allowedDomains } from './auth';
import { HttpError, json, readJson } from './http';
import { SenderUnavailable, senderToken } from './senders';
import { buildMime, base64Url } from '../../src/lib/mime';
import { mergeTpl } from '../../src/lib/bulk';
import { escapeHtml } from './http';

/**
 * Investor outreach sequences: steps (a first email and timed follow-ups),
 * recipients, an approval pinned to one version, and a cron runner that sends
 * due steps with the owner's Gmail credentials. A reply, a bounce, an opt-out
 * or a manual stop ends a recipient's sequence before the next send; a claim
 * row per (recipient, step) makes every send happen at most once.
 */

const DAY = 86_400_000;
export const MAX_STEPS = 6;
export const MAX_RECIPIENTS = 200;
/** Sends per cron run, across all sequences (Gmail limits; the cron runs every 10 minutes). */
export const SENDS_PER_RUN = 20;
const MAX_ATTEMPTS = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPT_OUT_RE = /\b(unsubscribe|remove me|opt[- ]?out|stop emailing|do not contact)\b/i;
export const OPT_OUT_FOOTER = 'Reply “unsubscribe” and we won’t email you again.';

type SeqStatus = 'draft' | 'approved' | 'active' | 'paused' | 'completed' | 'stopped';

interface SeqRow {
  id: number; owner_email: string; name: string; status: SeqStatus; version: number;
  approved_version: number | null; approved_by: string | null; approved_at: number | null;
  signature_html: string; signature_text: string; last_error: string | null; created_at: number; updated_at: number;
}
interface StepRow { position: number; delay_days: number; subject: string; body: string }
interface EnrollRow {
  id: number; sequence_id: number; email: string; first_name: string; last_name: string; company: string; context: string;
  status: string; next_step: number; next_at: number | null; thread_id: string | null; last_message_id: string | null;
  references_header: string | null; first_sent_at: number | null; attempts: number; last_error: string | null;
}

export interface StepInput { delayDays?: unknown; subject?: unknown; body?: unknown }
export interface RecipientInput { email?: unknown; firstName?: unknown; lastName?: unknown; company?: unknown; context?: unknown }
export interface SequenceInput {
  name?: unknown;
  steps?: StepInput[];
  recipients?: RecipientInput[];
  signatureHtml?: unknown;
  signatureText?: unknown;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const canApprove = (u: User) => u.role === 'admin' || u.role === 'super_admin';

// ---------- validation ----------

function parseSteps(input: StepInput[] | undefined): StepRow[] {
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'Add at least one step.');
  if (input.length > MAX_STEPS) throw new HttpError(400, 'A sequence has at most ' + MAX_STEPS + ' steps.');
  return input.map((s, i) => {
    const delay = i === 0 ? 0 : Math.round(Number(s.delayDays));
    if (i > 0 && !(delay >= 1 && delay <= 60)) throw new HttpError(400, 'Step ' + (i + 1) + ': wait between 1 and 60 days.');
    const subject = str(s.subject, 200);
    const body = str(s.body, 10_000);
    if (i === 0 && !subject) throw new HttpError(400, 'Step 1 needs a subject.');
    if (!body) throw new HttpError(400, 'Step ' + (i + 1) + ' needs a message.');
    for (const t of [subject, body]) {
      const bad = mergeTpl(t, { first: 'x', last: 'x', company: 'x', email: 'x', context: 'x', persona: 'General' }).missing.filter(m => m.includes('unknown'));
      if (bad.length) throw new HttpError(400, 'Step ' + (i + 1) + ': ' + bad.join(', ') + '. Use {first_name}, {last_name}, {company} or {opening}.');
    }
    return { position: i, delay_days: delay, subject, body };
  });
}

function parseRecipients(env: Env, input: RecipientInput[] | undefined) {
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'Add at least one recipient.');
  if (input.length > MAX_RECIPIENTS) throw new HttpError(400, 'A sequence has at most ' + MAX_RECIPIENTS + ' recipients.');
  const seen = new Set<string>();
  const org = allowedDomains(env);
  return input.map(r => {
    const email = str(r.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Not an email address: ' + (email || '(empty)'));
    if (org.includes(email.split('@')[1])) throw new HttpError(400, email + ' is internal. Sequences are for external outreach.');
    if (seen.has(email)) throw new HttpError(400, email + ' is listed twice.');
    seen.add(email);
    return { email, first: str(r.firstName, 80), last: str(r.lastName, 80), company: str(r.company, 120), context: str(r.context, 300) };
  });
}

// ---------- reads ----------

async function getSeq(env: Env, id: number): Promise<SeqRow> {
  const s = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?1').bind(id).first<SeqRow>();
  if (!s) throw new HttpError(404, 'No such sequence');
  return s;
}

/** Owners see their sequences; admins see all, so they can approve. */
function assertCanSee(user: User, s: SeqRow) {
  if (s.owner_email !== user.memberEmail && !canApprove(user)) throw new HttpError(404, 'No such sequence');
}
function assertOwner(user: User, s: SeqRow) {
  if (s.owner_email !== user.memberEmail) throw new HttpError(403, 'Only the owner can change this sequence.');
}

async function detail(env: Env, s: SeqRow, user: User) {
  const steps = (await env.DB.prepare('SELECT position, delay_days, subject, body FROM sequence_steps WHERE sequence_id = ?1 ORDER BY position').bind(s.id).all<StepRow>()).results;
  const recipients = (await env.DB.prepare('SELECT * FROM sequence_enrollments WHERE sequence_id = ?1 ORDER BY id').bind(s.id).all<EnrollRow>()).results;
  return {
    id: s.id, name: s.name, owner: s.owner_email, status: s.status, version: s.version,
    mine: s.owner_email === user.memberEmail,
    canApprove: canApprove(user) && (s.owner_email !== user.memberEmail || user.role === 'super_admin'),
    approved: s.approved_version === s.version ? { by: s.approved_by, at: s.approved_at } : null,
    lastError: s.last_error, createdAt: s.created_at, updatedAt: s.updated_at,
    signatureHtml: s.signature_html,
    steps: steps.map(t => ({ delayDays: t.delay_days, subject: t.subject, body: t.body })),
    recipients: recipients.map(r => ({
      id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, company: r.company, context: r.context,
      status: r.status, nextStep: r.next_step, nextAt: r.next_at, lastError: r.last_error, firstSentAt: r.first_sent_at
    }))
  };
}

async function list(env: Env, user: User) {
  const rows = (canApprove(user)
    ? await env.DB.prepare('SELECT * FROM sequences ORDER BY updated_at DESC').all<SeqRow>()
    : await env.DB.prepare('SELECT * FROM sequences WHERE owner_email = ?1 ORDER BY updated_at DESC').bind(user.memberEmail).all<SeqRow>()).results;
  const counts = (await env.DB.prepare('SELECT sequence_id, status, COUNT(*) AS n FROM sequence_enrollments GROUP BY sequence_id, status').all<{ sequence_id: number; status: string; n: number }>()).results;
  return rows.map(s => ({
    id: s.id, name: s.name, owner: s.owner_email, status: s.status, version: s.version, mine: s.owner_email === user.memberEmail,
    approved: s.approved_version === s.version, updatedAt: s.updated_at, lastError: s.last_error,
    counts: Object.fromEntries(counts.filter(c => c.sequence_id === s.id).map(c => [c.status, c.n]))
  }));
}

// ---------- writes ----------

async function writeContent(env: Env, id: number, steps: StepRow[], recipients: ReturnType<typeof parseRecipients>) {
  await env.DB.prepare('DELETE FROM sequence_steps WHERE sequence_id = ?1').bind(id).run();
  for (const t of steps) {
    await env.DB.prepare('INSERT INTO sequence_steps (sequence_id, position, delay_days, subject, body) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(id, t.position, t.delay_days, t.subject, t.body).run();
  }
  // Recipients who already got mail keep their history; others are replaced.
  await env.DB.prepare("DELETE FROM sequence_enrollments WHERE sequence_id = ?1 AND first_sent_at IS NULL").bind(id).run();
  for (const r of recipients) {
    await env.DB.prepare(`INSERT INTO sequence_enrollments (sequence_id, email, first_name, last_name, company, context, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7) ON CONFLICT (sequence_id, email) DO UPDATE SET
      first_name = excluded.first_name, last_name = excluded.last_name, company = excluded.company, context = excluded.context`)
      .bind(id, r.email, r.first, r.last, r.company, r.context, Date.now()).run();
  }
}

async function create(env: Env, user: User, b: SequenceInput) {
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, 'Name the sequence.');
  const steps = parseSteps(b.steps);
  const recipients = parseRecipients(env, b.recipients);
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO sequences (owner_email, name, status, version, signature_html, signature_text, created_at, updated_at)
    VALUES (?1, ?2, 'draft', 1, ?3, ?4, ?5, ?5)`).bind(user.memberEmail, name, str(b.signatureHtml, 20_000), str(b.signatureText, 2000), now).run();
  const id = Number(r.meta.last_row_id);
  await writeContent(env, id, steps, recipients);
  return detail(env, await getSeq(env, id), user);
}

/** Any edit is a new version: the approval no longer applies, and a running sequence pauses. */
async function update(env: Env, user: User, s: SeqRow, b: SequenceInput) {
  assertOwner(user, s);
  if (s.status === 'completed' || s.status === 'stopped') throw new HttpError(409, 'This sequence has ended. Duplicate it to start again.');
  const name = str(b.name, 120) || s.name;
  const steps = parseSteps(b.steps);
  const recipients = parseRecipients(env, b.recipients);
  await env.DB.prepare(`UPDATE sequences SET name = ?2, version = version + 1, status = 'draft', approved_version = NULL, approved_by = NULL, approved_at = NULL,
    signature_html = ?3, signature_text = ?4, updated_at = ?5 WHERE id = ?1`)
    .bind(s.id, name, str(b.signatureHtml, 20_000) || s.signature_html, str(b.signatureText, 2000) || s.signature_text, Date.now()).run();
  await writeContent(env, s.id, steps, recipients);
  // Recipients mid-sequence wait for the new approval.
  await env.DB.prepare("UPDATE sequence_enrollments SET status = 'pending' WHERE sequence_id = ?1 AND status = 'active'").bind(s.id).run();
  return detail(env, await getSeq(env, s.id), user);
}

async function approve(env: Env, user: User, s: SeqRow, version: unknown) {
  if (!canApprove(user)) throw new HttpError(403, 'Only an admin can approve outreach.');
  if (s.owner_email === user.memberEmail && user.role !== 'super_admin') throw new HttpError(403, 'Ask another admin to approve your own sequence.');
  if (Number(version) !== s.version) throw new HttpError(409, 'The sequence changed since you opened it. Review the latest version.');
  if (s.status !== 'draft') throw new HttpError(409, 'Only a draft can be approved.');
  await env.DB.prepare("UPDATE sequences SET status = 'approved', approved_version = version, approved_by = ?2, approved_at = ?3 WHERE id = ?1 AND version = ?4")
    .bind(s.id, user.memberEmail, Date.now(), s.version).run();
  return detail(env, await getSeq(env, s.id), user);
}

async function start(env: Env, user: User, s: SeqRow) {
  assertOwner(user, s);
  if (s.approved_version !== s.version || (s.status !== 'approved' && s.status !== 'paused')) throw new HttpError(409, 'Approve this version before starting it.');
  await senderToken(env, s.owner_email).catch(e => { throw new HttpError(409, e instanceof SenderUnavailable ? e.message : 'Sending is not available.'); });
  const now = Date.now();
  await env.DB.prepare("UPDATE sequences SET status = 'active', last_error = NULL, updated_at = ?2 WHERE id = ?1").bind(s.id, now).run();
  await env.DB.prepare("UPDATE sequence_enrollments SET status = 'active', next_at = COALESCE(next_at, ?2) WHERE sequence_id = ?1 AND status = 'pending'").bind(s.id, now).run();
  return detail(env, await getSeq(env, s.id), user);
}

async function setStatus(env: Env, user: User, s: SeqRow, to: 'paused' | 'stopped') {
  assertOwner(user, s);
  if (to === 'paused' && s.status !== 'active') throw new HttpError(409, 'Only a running sequence can be paused.');
  await env.DB.prepare('UPDATE sequences SET status = ?2, updated_at = ?3 WHERE id = ?1').bind(s.id, to, Date.now()).run();
  if (to === 'stopped') await env.DB.prepare("UPDATE sequence_enrollments SET status = 'stopped' WHERE sequence_id = ?1 AND status IN ('pending', 'active')").bind(s.id).run();
  return detail(env, await getSeq(env, s.id), user);
}

async function stopRecipient(env: Env, user: User, s: SeqRow, enrollmentId: number, optOut: boolean) {
  assertOwner(user, s);
  const e = await env.DB.prepare('SELECT * FROM sequence_enrollments WHERE id = ?1 AND sequence_id = ?2').bind(enrollmentId, s.id).first<EnrollRow>();
  if (!e) throw new HttpError(404, 'No such recipient');
  await env.DB.prepare('UPDATE sequence_enrollments SET status = ?2 WHERE id = ?1').bind(e.id, optOut ? 'opted_out' : 'stopped').run();
  if (optOut) await addOptOut(env, e.email, 'Marked by ' + user.memberEmail);
  return detail(env, await getSeq(env, s.id), user);
}

async function addOptOut(env: Env, email: string, reason: string) {
  await env.DB.prepare('INSERT INTO opt_outs (email, reason, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO NOTHING').bind(email, reason, Date.now()).run();
}

/** /api/sequences… */
export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/sequences
  const method = req.method;
  if (!parts.length) {
    if (method === 'GET') return json({ sequences: await list(env, user) });
    if (method === 'POST') return json({ sequence: await create(env, user, await readJson(req)) }, 201);
  }
  const id = Number(parts[0]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  const s = await getSeq(env, id);
  assertCanSee(user, s);
  const action = parts[1];
  if (!action) {
    if (method === 'GET') return json({ sequence: await detail(env, s, user) });
    if (method === 'PUT') return json({ sequence: await update(env, user, s, await readJson(req)) });
  }
  if (method === 'POST') {
    const body = await readJson<{ version?: unknown; optOut?: unknown }>(req).catch(() => ({} as { version?: unknown; optOut?: unknown }));
    if (action === 'approve') return json({ sequence: await approve(env, user, s, body.version) });
    if (action === 'start') return json({ sequence: await start(env, user, s) });
    if (action === 'pause') return json({ sequence: await setStatus(env, user, s, 'paused') });
    if (action === 'stop') return json({ sequence: await setStatus(env, user, s, 'stopped') });
    if (action === 'recipients' && parts[3] === 'stop') return json({ sequence: await stopRecipient(env, user, s, Number(parts[2]), body.optOut === true) });
  }
  throw new HttpError(404, 'Not found');
}

// ---------- the runner (cron) ----------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader { name: string; value: string }
interface GmailMsg { id: string; threadId: string; internalDate?: string; snippet?: string; payload?: { headers?: GmailHeader[] } }
const hdr = (m: GmailMsg, n: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const addr = (v: string) => (/<([^>]+)>/.exec(v)?.[1] || v).trim().toLowerCase();

/** What happened in the thread since the first send: a reply, a bounce or an opt-out stops the sequence. */
function threadOutcome(msgs: GmailMsg[], sender: string, recipient: string, since: number): 'replied' | 'bounced' | 'opted_out' | null {
  for (const m of msgs) {
    if (Number(m.internalDate || 0) < since) continue;
    const from = addr(hdr(m, 'From'));
    if (from === sender) continue;
    if (/^(mailer-daemon|postmaster)@/.test(from) || /delivery status notification|undeliverable|returned mail/i.test(hdr(m, 'Subject'))) return 'bounced';
    if (from === recipient && OPT_OUT_RE.test(m.snippet || '')) return 'opted_out';
    return 'replied';
  }
  return null;
}

function render(tpl: string, e: EnrollRow) {
  return mergeTpl(tpl, { first: e.first_name, last: e.last_name, company: e.company, email: e.email, context: e.context, persona: 'Investor' }).text;
}

const paragraphs = (t: string) => t.split(/\n{2,}/).map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');

export function composeStep(seq: Pick<SeqRow, 'signature_html' | 'signature_text'>, steps: StepRow[], e: EnrollRow, senderEmail: string, senderName: string) {
  const step = steps[e.next_step];
  const firstSubject = render(steps[0].subject, e);
  const subject = e.next_step === 0 ? firstSubject : step.subject ? render(step.subject, e) : 'Re: ' + firstSubject;
  const body = render(step.body, e);
  const html = '<div>' + paragraphs(body) + (seq.signature_html ? '<br>' + seq.signature_html : '') +
    '<p style="color:#6b6577;font-size:12px">' + escapeHtml(OPT_OUT_FOOTER) + '</p></div>';
  const text = body + (seq.signature_text ? '\n\n' + seq.signature_text : '') + '\n\n' + OPT_OUT_FOOTER;
  return buildMime({
    from: { name: senderName, email: senderEmail, org: '' },
    to: [{ name: [e.first_name, e.last_name].filter(Boolean).join(' '), email: e.email, org: '' }],
    cc: [], bcc: [], subject, html, text, attachments: [],
    inReplyTo: e.next_step > 0 ? e.last_message_id || undefined : undefined,
    references: e.next_step > 0 ? e.references_header || undefined : undefined
  });
}

export interface RunResult { sent: number; stopped: number; failed: number; paused: number }

/** Send every due step, at most SENDS_PER_RUN. Safe to run concurrently or twice. */
export async function runDue(env: Env, now = Date.now()): Promise<RunResult> {
  const out: RunResult = { sent: 0, stopped: 0, failed: 0, paused: 0 };
  const due = (await env.DB.prepare(`SELECT e.* FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
    WHERE e.status = 'active' AND e.next_at <= ?1 AND s.status = 'active' AND s.approved_version = s.version
    ORDER BY e.next_at LIMIT ?2`).bind(now, SENDS_PER_RUN).all<EnrollRow>()).results;
  const seqs = new Map<number, { s: SeqRow; steps: StepRow[] } | null>();
  for (const e of due) {
    if (!seqs.has(e.sequence_id)) {
      const s = await env.DB.prepare('SELECT * FROM sequences WHERE id = ?1').bind(e.sequence_id).first<SeqRow>();
      const steps = (await env.DB.prepare('SELECT position, delay_days, subject, body FROM sequence_steps WHERE sequence_id = ?1 ORDER BY position').bind(e.sequence_id).all<StepRow>()).results;
      seqs.set(e.sequence_id, s && s.status === 'active' && s.approved_version === s.version ? { s, steps } : null);
    }
    const seq = seqs.get(e.sequence_id);
    if (!seq) continue;
    const r = await processOne(env, seq.s, seq.steps, e, now);
    out[r]++;
    if (r === 'paused') seqs.set(e.sequence_id, null);
  }
  // Sequences with nobody left to send to are complete.
  await env.DB.prepare(`UPDATE sequences SET status = 'completed', updated_at = ?1 WHERE status = 'active'
    AND NOT EXISTS (SELECT 1 FROM sequence_enrollments e WHERE e.sequence_id = sequences.id AND e.status IN ('pending', 'active'))`).bind(now).run();
  return out;
}

async function processOne(env: Env, s: SeqRow, steps: StepRow[], e: EnrollRow, now: number): Promise<keyof RunResult> {
  const set = (fields: string, ...vals: unknown[]) => env.DB.prepare('UPDATE sequence_enrollments SET ' + fields + ' WHERE id = ?1').bind(e.id, ...vals).run();
  const step = steps[e.next_step];
  if (!step) { await set("status = 'completed', next_at = NULL"); return 'stopped'; }

  if (await env.DB.prepare('SELECT 1 AS x FROM opt_outs WHERE email = ?1').bind(e.email).first()) {
    await set("status = 'opted_out', next_at = NULL");
    return 'stopped';
  }

  let sender: { token: string; email: string };
  try {
    sender = await senderToken(env, s.owner_email);
  } catch (err) {
    // Without credentials nothing can send: pause the whole sequence and say why.
    await env.DB.prepare("UPDATE sequences SET status = 'paused', last_error = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(s.id, err instanceof Error ? err.message : String(err), now).run();
    return 'paused';
  }
  const gmail = (path: string, init?: RequestInit) => fetch(GMAIL + path, { ...init, headers: { Authorization: 'Bearer ' + sender.token, ...(init?.headers || {}) } });

  // Stop rules, checked against the live thread right before sending.
  if (e.thread_id && e.first_sent_at) {
    const t = await gmail('/threads/' + e.thread_id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
    if (t.ok) {
      const outcome = threadOutcome(((await t.json()) as { messages?: GmailMsg[] }).messages || [], sender.email, e.email, e.first_sent_at);
      if (outcome) {
        await set('status = ?2, next_at = NULL', outcome);
        if (outcome === 'opted_out') await addOptOut(env, e.email, 'Replied to stop (sequence ' + s.id + ')');
        return 'stopped';
      }
    } else if (t.status !== 404) {
      return retryLater(env, e, set, 'Couldn’t check the thread for replies (' + t.status + ')');
    }
  }

  // Claim this (recipient, step). A second runner, or a retry, finds the claim and backs off.
  const claim = await env.DB.prepare("INSERT INTO sequence_sends (enrollment_id, step, status, created_at) VALUES (?1, ?2, 'sending', ?3) ON CONFLICT DO NOTHING")
    .bind(e.id, e.next_step, now).run();
  if (!claim.meta.changes) {
    const prior = await env.DB.prepare('SELECT status FROM sequence_sends WHERE enrollment_id = ?1 AND step = ?2').bind(e.id, e.next_step).first<{ status: string }>();
    if (prior?.status === 'sent') return advance(e, steps, now, set, null).then(() => 'stopped');
    // A send whose outcome is unknown is never repeated: a person checks Sent mail.
    await set("status = 'failed', next_at = NULL, last_error = ?2", 'An earlier send of step ' + (e.next_step + 1) + ' did not report back. Check Sent mail before restarting this recipient.');
    return 'failed';
  }

  const raw = composeStep(s, steps, e, sender.email, s.signature_text.split('\n')[0] || '');
  let res: Response;
  try {
    res = await gmail('/messages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(raw)), ...(e.thread_id && e.next_step > 0 ? { threadId: e.thread_id } : {}) })
    });
  } catch {
    // The request may or may not have reached Gmail: leave the claim, so it is never sent twice.
    await set("status = 'failed', next_at = NULL, last_error = ?2", 'The connection to Gmail dropped while sending step ' + (e.next_step + 1) + '. Check Sent mail.');
    return 'failed';
  }
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message || String(res.status);
    if (res.status === 429 || res.status >= 500) {
      // Gmail didn't take it: release the claim and try on a later run.
      await env.DB.prepare('DELETE FROM sequence_sends WHERE enrollment_id = ?1 AND step = ?2').bind(e.id, e.next_step).run();
      return retryLater(env, e, set, 'Gmail is busy (' + msg + ')');
    }
    await env.DB.prepare("UPDATE sequence_sends SET status = 'failed', error = ?3 WHERE enrollment_id = ?1 AND step = ?2").bind(e.id, e.next_step, msg).run();
    await set("status = 'failed', next_at = NULL, last_error = ?2", 'Gmail refused step ' + (e.next_step + 1) + ': ' + msg);
    return 'failed';
  }
  const sent = (await res.json()) as { id: string; threadId: string };
  await env.DB.prepare("UPDATE sequence_sends SET status = 'sent', gmail_message_id = ?3 WHERE enrollment_id = ?1 AND step = ?2").bind(e.id, e.next_step, sent.id).run();
  let messageId: string | null = null;
  const m = await gmail('/messages/' + sent.id + '?format=metadata&metadataHeaders=Message-ID');
  if (m.ok) messageId = hdr((await m.json()) as GmailMsg, 'Message-ID') || null;
  await advance({ ...e, thread_id: sent.threadId }, steps, now, set, messageId);
  return 'sent';
}

async function advance(e: EnrollRow, steps: StepRow[], now: number, set: (f: string, ...v: unknown[]) => Promise<unknown>, messageId: string | null) {
  const next = e.next_step + 1;
  const refs = [e.references_header, messageId].filter(Boolean).join(' ') || null;
  if (next >= steps.length) {
    await set("status = 'completed', next_step = ?2, next_at = NULL, thread_id = ?3, last_message_id = COALESCE(?4, last_message_id), references_header = ?5, first_sent_at = COALESCE(first_sent_at, ?6), attempts = 0, last_error = NULL",
      next, e.thread_id, messageId, refs, now);
  } else {
    await set('next_step = ?2, next_at = ?3, thread_id = ?4, last_message_id = COALESCE(?5, last_message_id), references_header = ?6, first_sent_at = COALESCE(first_sent_at, ?7), attempts = 0, last_error = NULL',
      next, now + steps[next].delay_days * DAY, e.thread_id, messageId, refs, now);
  }
}

async function retryLater(_env: Env, e: EnrollRow, set: (f: string, ...v: unknown[]) => Promise<unknown>, why: string): Promise<keyof RunResult> {
  if (e.attempts + 1 >= MAX_ATTEMPTS) {
    await set("status = 'failed', next_at = NULL, attempts = attempts + 1, last_error = ?2", why + '. Gave up after ' + MAX_ATTEMPTS + ' tries.');
    return 'failed';
  }
  await set('attempts = attempts + 1, last_error = ?2', why + '. Will retry.');
  return 'failed';
}
