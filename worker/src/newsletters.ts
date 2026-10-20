import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';
import { SenderUnavailable, senderToken } from './senders';
import { buildMime, base64Url } from '../../src/lib/mime';
import { renderIssue, renderSystem, safeUrl } from '../../src/lib/newsletter/render';
import { blockStrings, templateDef } from '../../src/lib/newsletter/templates';
import * as link from './studioLink';
import { blockUrls, cleanBlocks, isTemplate } from '../../src/lib/newsletter/validate';
import type { Block, Brand, IssueContent, Recipient, TemplateId } from '../../src/lib/newsletter/types';
import { manageLinks, sign, appUrl, tokensReady } from './newsletterTokens';
import { newsletterAssist } from './assistant';

/**
 * Newsletters: issues built from a template's blocks, sent to subscriber
 * lists by the Worker's cron in batches, with the scheduling member's Gmail
 * sending grant (the same "Connect sending" as outreach sequences).
 *
 * Who can do what:
 * - any member drafts issues and asks for review;
 * - admins and super admins edit any issue, manage subscribers, lists and
 *   settings, send tests, and schedule or send;
 * - every issue is approved by an admin other than the one who asked or edited
 *   it last (a super admin may approve their own), for one version: any edit
 *   afterwards needs approval again.
 * Audiences are Mail's own lists and, over the StudioOS link, the lists,
 * members and testers StudioOS keeps; StudioOS recipients are read when the
 * issue starts sending, so anyone who left since is never sent to.
 * Nothing is sent automatically: an issue goes out only after a person
 * schedules it, and only to subscribers who opted in (double opt-in from the
 * website, an import with attested consent, or a person added by an admin).
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const ESSENTIALS: TemplateId[] = ['brief', 'letter', 'announcement'];
const MAX_IMPORT = 5000;
const CONFIRMS_PER_RUN = 30;
const STUCK_MS = 15 * 60_000;

const isManager = (u: User) => u.role === 'admin' || u.role === 'super_admin';
const requireManager = (u: User) => { if (!isManager(u)) throw new HttpError(403, 'Only an admin can do this.', 'admin_only'); };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- settings ----------

interface SettingsRow {
  postal_address: string; disclaimer: string; from_name: string; system_sender: string | null; system_from: string;
  double_opt_in: number; batch_size: number; allowed_origins: string; updated_by: string | null; updated_at: number;
  daily_limit: number; per_minute: number; default_from: string; link_read_at: number | null; link_lists: number | null; link_programmes: number | null;
}

export async function getSettings(env: Env): Promise<SettingsRow> {
  const r = await env.DB.prepare('SELECT * FROM nl_settings WHERE id = 1').first<SettingsRow>();
  return r || { postal_address: '', disclaimer: '', from_name: 'Axal VC', system_sender: null, system_from: '', double_opt_in: 1, batch_size: 40, allowed_origins: '["https://axal.vc","https://www.axal.vc"]', updated_by: null, updated_at: 0,
    daily_limit: 400, per_minute: 20, default_from: '', link_read_at: null, link_lists: null, link_programmes: null };
}

export const brandOf = (s: SettingsRow): Brand => ({ fromName: s.from_name || 'Axal VC', postalAddress: s.postal_address, disclaimer: s.disclaimer });
export const originsOf = (s: SettingsRow): string[] => { try { return (JSON.parse(s.allowed_origins) as string[]).filter(o => typeof o === 'string'); } catch { return []; } };

const dayStart = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** Newsletter messages accepted by Gmail since midnight UTC (the daily limit counts these). */
async function sentToday(env: Env, now = Date.now()) {
  const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_sends WHERE status = 'sent' AND sent_at >= ?1").bind(dayStart(now)).first<{ n: number }>();
  const b = await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_ext_sends WHERE status = 'sent' AND sent_at >= ?1").bind(dayStart(now)).first<{ n: number }>();
  return (a?.n || 0) + (b?.n || 0);
}

/** Record a successful read over the StudioOS link, for the settings page. */
export async function noteLinkRead(env: Env, change: { lists?: number; programmes?: number }) {
  await env.DB.prepare('UPDATE nl_settings SET link_read_at = ?1, link_lists = COALESCE(?2, link_lists), link_programmes = COALESCE(?3, link_programmes) WHERE id = 1')
    .bind(Date.now(), change.lists ?? null, change.programmes ?? null).run().catch(() => {});
}

const settingsOut = async (s: SettingsRow, env: Env) => ({
  postalAddress: s.postal_address, disclaimer: s.disclaimer, fromName: s.from_name, systemSender: s.system_sender, systemFrom: s.system_from,
  doubleOptIn: !!s.double_opt_in, batchSize: s.batch_size, allowedOrigins: originsOf(s), updatedBy: s.updated_by, updatedAt: s.updated_at,
  signupEndpoint: appUrl(env) + '/api/public/newsletter/subscribe', embedScript: appUrl(env) + '/api/public/newsletter/embed.js',
  linksReady: tokensReady(env),
  dailyLimit: s.daily_limit, perMinute: s.per_minute, defaultFrom: s.default_from, sentToday: await sentToday(env),
  link: { configured: link.linkConfigured(env), base: link.studioBase(env), readAt: s.link_read_at, lists: s.link_lists, programmes: s.link_programmes }
});

async function putSettings(env: Env, user: User, b: Record<string, unknown>) {
  requireManager(user);
  const cur = await getSettings(env);
  const origins = Array.isArray(b.allowedOrigins) ? b.allowedOrigins : originsOf(cur);
  const clean = origins.map(o => str(o, 200).replace(/\/+$/, '')).filter(Boolean);
  if (clean.some(o => !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))) throw new HttpError(400, 'Allowed origins are https:// addresses without a path, e.g. https://axal.vc.');
  if ((Array.isArray(b.allowedOrigins) || b.systemSender !== undefined) && user.role !== 'super_admin') throw new HttpError(403, 'Only a super admin changes the website connection or the system sender.', 'super_admin_only');
  let sender = cur.system_sender;
  let systemFrom = cur.system_from;
  if (b.systemSender !== undefined) {
    // Confirmation emails go out with someone's own grant: only that person can choose it.
    if (b.systemSender === null || b.systemSender === '') { sender = null; systemFrom = ''; }
    else if (str(b.systemSender, 254).toLowerCase() !== user.memberEmail) throw new HttpError(400, 'Set yourself as the sender of confirmation emails; each person connects their own sending.');
    else {
      const t = await senderToken(env, user.memberEmail).catch(e => { throw new HttpError(409, e instanceof Error ? e.message : String(e), 'sender_not_connected'); });
      sender = user.memberEmail;
      systemFrom = str(b.systemFrom, 254).toLowerCase() || t.email;
      await checkFrom(t, systemFrom);
    }
  }
  const batch = b.batchSize === undefined ? cur.batch_size : Math.max(5, Math.min(200, Math.floor(Number(b.batchSize)) || 40));
  const daily = b.dailyLimit === undefined ? cur.daily_limit : Math.max(1, Math.min(10000, Math.floor(Number(b.dailyLimit)) || 400));
  const perMinute = b.perMinute === undefined ? cur.per_minute : Math.max(1, Math.min(60, Math.floor(Number(b.perMinute)) || 20));
  const defaultFrom = b.defaultFrom === undefined ? cur.default_from : str(b.defaultFrom, 254).toLowerCase();
  if (defaultFrom && !EMAIL_RE.test(defaultFrom)) throw new HttpError(400, 'The sending address is not an email address.');
  await env.DB.prepare(`UPDATE nl_settings SET postal_address = ?1, disclaimer = ?2, from_name = ?3, system_sender = ?4, system_from = ?5, double_opt_in = ?6, batch_size = ?7,
    allowed_origins = ?8, updated_by = ?9, updated_at = ?10, daily_limit = ?11, per_minute = ?12, default_from = ?13 WHERE id = 1`)
    .bind(b.postalAddress === undefined ? cur.postal_address : str(b.postalAddress, 300), b.disclaimer === undefined ? cur.disclaimer : str(b.disclaimer, 1500),
      b.fromName === undefined ? cur.from_name : str(b.fromName, 80) || 'Axal VC', sender, systemFrom,
      b.doubleOptIn === undefined ? cur.double_opt_in : b.doubleOptIn === false ? 0 : 1, batch, JSON.stringify(clean), user.memberEmail, Date.now(), daily, perMinute, defaultFrom).run();
  return settingsOut(await getSettings(env), env);
}

/** The From address must be the grant's own address or one of its verified send-as aliases. */
async function checkFrom(sender: { token: string; email: string }, from: string) {
  if (!EMAIL_RE.test(from)) throw new HttpError(400, 'Choose a From address.');
  if (from.toLowerCase() === sender.email.toLowerCase()) return;
  const r = await fetch(GMAIL + '/settings/sendAs', { headers: { Authorization: 'Bearer ' + sender.token } });
  const list = r.ok ? (((await r.json()) as { sendAs?: { sendAsEmail: string; verificationStatus?: string; isPrimary?: boolean }[] }).sendAs || []) : [];
  const ok = list.some(a => a.sendAsEmail.toLowerCase() === from.toLowerCase() && (a.isPrimary || a.verificationStatus === 'accepted'));
  if (!ok) throw new HttpError(400, from + ' isn’t a verified “Send mail as” address of ' + sender.email + ' in Gmail. Add it in Gmail settings, or send from ' + sender.email + '.', 'from_not_verified');
}

// ---------- lists ----------

interface ListRow { id: number; key: string; name: string; description: string; public: number; requires_approval: number; created_at: number }

async function lists(env: Env) {
  const rows = (await env.DB.prepare(`SELECT l.*, (SELECT COUNT(*) FROM nl_memberships m JOIN nl_subscribers s ON s.id = m.subscriber_id WHERE m.list_id = l.id AND s.status = 'subscribed') AS subscribed,
    (SELECT MAX(i.sent_at) FROM nl_issues i WHERE i.status = 'sent' AND EXISTS (SELECT 1 FROM json_each(i.list_ids) j WHERE j.value = l.id)) AS last_sent
    FROM nl_lists l ORDER BY l.public DESC, l.name`).all<ListRow & { subscribed: number; last_sent: number | null }>()).results;
  return rows.map(r => ({ id: r.id, key: r.key, name: r.name, description: r.description, public: !!r.public, requiresApproval: !!r.requires_approval, subscribed: r.subscribed, lastSent: r.last_sent }));
}

async function listIds(env: Env, v: unknown): Promise<number[]> {
  if (!Array.isArray(v)) throw new HttpError(400, 'listIds must be a list');
  const ids = [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (!ids.length) return [];
  const known = (await env.DB.prepare('SELECT id FROM nl_lists WHERE id IN (' + ids.map(() => '?').join(',') + ')').bind(...ids).all<{ id: number }>()).results.map(r => r.id);
  if (known.length !== ids.length) throw new HttpError(400, 'Unknown list');
  return ids;
}

async function needsApproval(env: Env, ids: number[]): Promise<boolean> {
  if (!ids.length) return false;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_lists WHERE requires_approval = 1 AND id IN (' + ids.map(() => '?').join(',') + ')').bind(...ids).first<{ n: number }>();
  return (r?.n || 0) > 0;
}

/** Subscribed people on any of the lists, minus outreach opt-outs; "essentials" readers only get the main templates. */
async function audience(env: Env, ids: number[], template: TemplateId): Promise<number> {
  if (!ids.length) return 0;
  const r = await env.DB.prepare(`SELECT COUNT(DISTINCT s.id) AS n FROM nl_subscribers s JOIN nl_memberships m ON m.subscriber_id = s.id
    WHERE s.status = 'subscribed' AND m.list_id IN (${ids.map(() => '?').join(',')}) AND (s.frequency = 'all' OR ?${ids.length + 1} = 1)
    AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.email = s.email COLLATE NOCASE)`).bind(...ids, ESSENTIALS.includes(template) ? 1 : 0).first<{ n: number }>();
  return r?.n || 0;
}

async function excluded(env: Env, ids: number[]) {
  if (!ids.length) return { unsubscribed: 0, bounced: 0, suppressed: 0, pending: 0 };
  const rows = (await env.DB.prepare(`SELECT s.status, COUNT(DISTINCT s.id) AS n FROM nl_subscribers s JOIN nl_memberships m ON m.subscriber_id = s.id
    WHERE m.list_id IN (${ids.map(() => '?').join(',')}) AND s.status != 'subscribed' GROUP BY s.status`).bind(...ids).all<{ status: string; n: number }>()).results;
  const g = (k: string) => rows.find(r => r.status === k)?.n || 0;
  return { unsubscribed: g('unsubscribed'), bounced: g('bounced'), suppressed: g('suppressed'), pending: g('pending') };
}

// ---------- issues ----------

interface IssueRow {
  id: number; title: string; template: TemplateId; subject: string; preheader: string; edition: string; blocks: string; list_ids: string;
  from_email: string; from_name: string; signoff: string; status: string; version: number; content_hash: string; review_requested_by: string | null;
  approved_hash: string | null; approved_by: string | null; approved_at: number | null; sender_member: string | null; scheduled_at: number | null;
  started_at: number | null; sent_at: number | null; recipients: number; last_error: string | null; created_by: string; updated_by: string; created_at: number; updated_at: number;
  audiences: string; programme_uid: string | null; variant: string;
}

const AUDIENCE_KEY = /^[\w:.-]{1,120}$/;
const audiencesOf = (r: Pick<IssueRow, 'audiences'>): string[] => { try { return (JSON.parse(r.audiences || '[]') as string[]).filter(k => typeof k === 'string' && AUDIENCE_KEY.test(k)); } catch { return []; } };
const approvedNow = (r: IssueRow) => !!r.approved_hash && r.approved_hash === r.content_hash;

const contentOf = (r: IssueRow): IssueContent => ({ template: r.template, subject: r.subject, preheader: r.preheader, blocks: JSON.parse(r.blocks) as Block[] });
const signoffOf = (r: IssueRow): { title: string; calendarUrl: string } => { try { return { title: '', calendarUrl: '', ...JSON.parse(r.signoff) }; } catch { return { title: '', calendarUrl: '' }; } };

const hashOf = (r: Pick<IssueRow, 'template' | 'subject' | 'preheader' | 'edition' | 'blocks' | 'list_ids' | 'from_email' | 'from_name' | 'signoff' | 'audiences'>) =>
  sha256(JSON.stringify([r.template, r.subject, r.preheader, r.edition, r.blocks, r.list_ids, r.from_email, r.from_name, r.signoff, r.audiences === '[]' ? '' : r.audiences]));

async function issueOut(env: Env, user: User, r: IssueRow, detail = false) {
  const ids = JSON.parse(r.list_ids) as number[];
  const auds = audiencesOf(r);
  const counts = (await env.DB.prepare(`SELECT status, (error LIKE 'Unconfirmed%') AS unc, COUNT(*) AS n FROM nl_sends WHERE issue_id = ?1 GROUP BY status, unc
    UNION ALL SELECT status, 0 AS unc, COUNT(*) AS n FROM nl_ext_sends WHERE issue_id = ?1 GROUP BY status`).bind(r.id).all<{ status: string; unc: number; n: number }>()).results;
  const c = (k: string) => counts.filter(x => x.status === k && !(k === 'failed' && x.unc)).reduce((a, x) => a + x.n, 0);
  const unconfirmed = counts.filter(x => x.status === 'unconfirmed' || (x.status === 'failed' && x.unc)).reduce((a, x) => a + x.n, 0);
  const approved = approvedNow(r);
  const canManage = isManager(user);
  const mine = r.created_by === user.memberEmail;
  const base = {
    id: r.id, title: r.title, template: r.template, subject: r.subject, preheader: r.preheader, edition: r.edition, listIds: ids, audiences: auds,
    programmeUid: r.programme_uid, variant: r.variant,
    fromEmail: r.from_email, fromName: r.from_name, signoff: signoffOf(r), status: r.status, version: r.version, contentHash: r.content_hash,
    approvalRequired: true, approved, approvedBy: r.approved_by, approvedAt: r.approved_at,
    reviewRequestedBy: r.review_requested_by, senderMember: r.sender_member, scheduledAt: r.scheduled_at, startedAt: r.started_at, sentAt: r.sent_at,
    recipients: r.recipients, sent: c('sent'), failed: c('failed'), unconfirmed, queued: c('queued') + c('sending'), skipped: c('skipped'), lastError: r.last_error,
    createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
    canEdit: (isManager(user) || (mine && ['draft', 'in_review'].includes(r.status))) && !['scheduled', 'sending', 'sent'].includes(r.status),
    canApprove: canManage && r.status === 'in_review' &&
      ((r.review_requested_by !== user.memberEmail && r.updated_by !== user.memberEmail) || user.role === 'super_admin'),
    canSchedule: canManage && r.status === 'approved' && approved
  };
  if (!detail) return base;
  return {
    ...base, blocks: JSON.parse(r.blocks) as Block[],
    audience: await audience(env, ids, r.template), excluded: await excluded(env, ids), dailyLimit: (await getSettings(env)).daily_limit,
    unsubscribes: ((await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_events WHERE issue_id = ?1 AND kind = 'unsubscribe'").bind(r.id).first<{ n: number }>())?.n || 0)
  };
}

async function load(env: Env, id: number): Promise<IssueRow> {
  const r = await env.DB.prepare('SELECT * FROM nl_issues WHERE id = ?1').bind(id).first<IssueRow>();
  if (!r) throw new HttpError(404, 'Newsletter not found');
  return r;
}

async function event(env: Env, kind: string, detail: string, issueId: number | null, subscriberId: number | null) {
  await env.DB.prepare('INSERT INTO nl_events (subscriber_id, issue_id, kind, detail, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(subscriberId, issueId, kind, detail.slice(0, 500), Date.now()).run();
}

async function create(env: Env, user: User, b: { template?: unknown; title?: unknown; variant?: unknown; programmeUid?: unknown; programmeName?: unknown }) {
  if (!isTemplate(b.template)) throw new HttpError(400, 'Choose a template');
  const def = templateDef(b.template);
  const programme = str(b.programmeUid, 80);
  if (def.testing && !/^[\w-]{1,80}$/.test(programme)) throw new HttpError(400, 'Testing emails start from a programme in Product testing.');
  if (!def.testing && programme) throw new HttpError(400, 'Only testing emails belong to a programme.');
  const variant = b.variant === 'online' && def.variants?.online ? 'online' : '';
  const all = (await env.DB.prepare('SELECT id, key FROM nl_lists').all<{ id: number; key: string }>()).results;
  const ids = def.lists.map(k => all.find(l => l.key === k)?.id).filter((x): x is number => !!x);
  // Testing emails go to the programme's picked testers (StudioOS), except "Not this time".
  const auds = def.testing && b.template !== 'pt_not' ? ['testers:' + programme] : [];
  const product = str(b.programmeName, 120);
  let blocks = JSON.stringify((variant ? def.variants!.online : def.blocks)());
  let subject = def.subject;
  if (product) { blocks = blocks.split('[Product name]').join(product.replace(/[\\"]/g, '')); subject = subject.split('[Product name]').join(product); }
  const now = Date.now();
  const row = {
    template: def.id, subject, preheader: def.preheader, edition: '', blocks, list_ids: JSON.stringify(ids),
    from_email: (await getSettings(env)).default_from || '', from_name: '', signoff: '{}', audiences: JSON.stringify(auds)
  };
  const hash = await hashOf(row);
  const r = await env.DB.prepare(`INSERT INTO nl_issues (title, template, subject, preheader, edition, blocks, list_ids, from_email, from_name, signoff, content_hash, created_by, updated_by, created_at, updated_at, audiences, programme_uid, variant)
    VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?13, '', '{}', ?7, ?8, ?8, ?9, ?9, ?10, ?11, ?12)`)
    .bind(str(b.title, 120) || (def.testing && product ? def.name + ' · ' + product : def.name + (variant ? ' · Online' : '')), def.id, subject, def.preheader, row.blocks, row.list_ids, hash, user.memberEmail, now,
      row.audiences, programme || null, variant, row.from_email).run();
  return issueOut(env, user, await load(env, Number(r.meta.last_row_id)), true);
}

async function update(env: Env, user: User, r: IssueRow, b: Record<string, unknown>) {
  if (!(isManager(user) || (r.created_by === user.memberEmail && ['draft', 'in_review'].includes(r.status)))) throw new HttpError(403, 'Only its author or an admin edits this newsletter.');
  if (['scheduled', 'sending', 'sent'].includes(r.status)) throw new HttpError(409, 'This newsletter is ' + r.status + '. Cancel the schedule to edit it.', 'not_editable');
  if (Number(b.expectedVersion) !== r.version) throw new HttpError(409, 'Someone saved this newsletter first. Reload it to see their changes.', 'issue_conflict', { current: await issueOut(env, user, r, true) });
  const next = {
    template: r.template,
    subject: b.subject === undefined ? r.subject : str(b.subject, 200),
    preheader: b.preheader === undefined ? r.preheader : str(b.preheader, 200),
    edition: b.edition === undefined ? r.edition : str(b.edition, 60),
    blocks: b.blocks === undefined ? r.blocks : JSON.stringify(cleanBlocks(b.blocks)),
    list_ids: b.listIds === undefined ? r.list_ids : JSON.stringify(await listIds(env, b.listIds)),
    from_email: b.fromEmail === undefined ? r.from_email : str(b.fromEmail, 254).toLowerCase(),
    from_name: b.fromName === undefined ? r.from_name : str(b.fromName, 80),
    signoff: b.signoff === undefined ? r.signoff : JSON.stringify({ title: str((b.signoff as Record<string, unknown>)?.title, 100), calendarUrl: safeUrl(str((b.signoff as Record<string, unknown>)?.calendarUrl, 600)) }),
    audiences: b.audiences === undefined ? r.audiences : JSON.stringify(audienceKeys(b.audiences))
  };
  if (next.from_email && !EMAIL_RE.test(next.from_email)) throw new HttpError(400, 'The From address is not an email address.');
  const title = b.title === undefined ? r.title : str(b.title, 120) || r.title;
  const hash = await hashOf(next);
  const changed = hash !== r.content_hash;
  // Any change to what would be sent ends an approval or a review in progress.
  const status = changed && ['in_review', 'approved'].includes(r.status) ? 'draft' : r.status;
  await env.DB.prepare(`UPDATE nl_issues SET title = ?2, subject = ?3, preheader = ?4, edition = ?5, blocks = ?6, list_ids = ?7, from_email = ?8, from_name = ?9, signoff = ?10,
    content_hash = ?11, version = version + 1, status = ?12, review_requested_by = CASE WHEN ?12 = 'draft' THEN NULL ELSE review_requested_by END,
    last_error = CASE WHEN ?13 THEN ?14 ELSE last_error END, updated_by = ?15, updated_at = ?16, audiences = ?18 WHERE id = ?1 AND version = ?17`)
    .bind(r.id, title, next.subject, next.preheader, next.edition, next.blocks, next.list_ids, next.from_email, next.from_name, next.signoff, hash, status,
      status !== r.status ? 1 : 0, r.status === 'approved' ? 'Changed after approval: it needs approval again.' : 'Changed during review: ask for review again.', user.memberEmail, Date.now(), r.version, next.audiences).run();
  return issueOut(env, user, await load(env, r.id), true);
}

function audienceKeys(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'audiences must be a list');
  const keys = [...new Set(v.map(x => String(x)))].slice(0, 20);
  if (keys.some(k => !AUDIENCE_KEY.test(k))) throw new HttpError(400, 'Unknown audience');
  return keys;
}

function stale(r: IssueRow, b: { version?: unknown; contentHash?: unknown }) {
  if (Number(b.version) !== r.version || b.contentHash !== r.content_hash) throw new HttpError(409, 'This newsletter changed since you opened it. Review the current version.', 'issue_changed');
}

/** Problems that block sending: each is a sentence the page shows as a failed check. */
async function blockers(env: Env, r: IssueRow): Promise<string[]> {
  const s = await getSettings(env);
  const content = contentOf(r);
  content.blocks = content.blocks.filter(b => !b.hidden);
  const ids = JSON.parse(r.list_ids) as number[];
  const auds = audiencesOf(r);
  const out: string[] = [];
  if (!r.subject.trim()) out.push('Add a subject.');
  if (!ids.length && !auds.length) out.push(r.template === 'pt_not' ? 'StudioOS doesn’t share the applicants who weren’t picked yet, so this email has no audience. StudioOS tells them in the app.' : 'Choose an audience.');
  else if (!auds.length && !(await audience(env, ids, r.template))) out.push('Nobody on these lists is subscribed yet.');
  if (auds.length && !link.linkConfigured(env)) out.push('Connect StudioOS (the link secret) to send to its lists.');
  if (!s.postal_address.trim()) out.push('Add the firm’s postal address in Newsletters → Settings (required in every newsletter).');
  if ((await needsApproval(env, ids) || r.template === 'letter' || auds.some(k => /^(lp|lps|investors)\b/.test(k))) && !s.disclaimer.trim()) out.push('Add the disclaimer in Settings: it is required for investor and LP audiences.');
  if (!tokensReady(env)) out.push('The Worker needs the NEWSLETTER_SIGNING_KEY secret for unsubscribe links.');
  const bad = blockUrls(content.blocks).filter(u => !safeUrl(u.url) && !/^\{[a-z_]+\}$/.test(u.url));
  if (bad.length) out.push('Fix ' + bad.length + ' link' + (bad.length > 1 ? 's' : '') + ' (https:// only): ' + bad.slice(0, 3).map(b => b.where).join(', ') + '.');
  if (content.blocks.some(b => b.type === 'image' && b.src.trim() && !b.alt.trim())) out.push('Give every image alt text.');
  if (/\[[^\]\n]{2,60}\](?!\()/.test([r.subject, r.preheader, ...blockStrings(content.blocks)].join('\n'))) out.push('Replace the [placeholder] text.');
  return out;
}

async function schedule(env: Env, user: User, r: IssueRow, b: { version?: unknown; contentHash?: unknown; at?: unknown }) {
  requireManager(user);
  stale(r, b);
  if (r.status !== 'approved' || !approvedNow(r)) throw new HttpError(409, 'Nothing is sent without an approved version. Ask for approval first.', 'needs_approval');
  const problems = await blockers(env, r);
  if (problems.length) throw new HttpError(400, problems.join(' '), 'checks_failed', { problems });
  let sender: { token: string; email: string };
  try { sender = await senderToken(env, user.memberEmail); } catch (e) {
    throw new HttpError(409, (e instanceof Error ? e.message : String(e)) + ' Newsletters send with your sending grant.', 'sender_not_connected');
  }
  await checkFrom(sender, r.from_email || sender.email);
  const at = b.at === undefined || b.at === null ? Date.now() : Number(b.at);
  if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + 366 * 86_400_000) throw new HttpError(400, 'Choose a time in the coming year.');
  const res = await env.DB.prepare(`UPDATE nl_issues SET status = 'scheduled', scheduled_at = ?2, sender_member = ?3, last_error = NULL, updated_at = ?4
    WHERE id = ?1 AND version = ?5 AND content_hash = ?6 AND status = 'approved' AND approved_hash = content_hash`).bind(r.id, at, user.memberEmail, Date.now(), r.version, r.content_hash).run();
  if (!res.meta.changes) throw new HttpError(409, 'This newsletter changed since you opened it. Review the current version.', 'issue_changed');
  return issueOut(env, user, await load(env, r.id), true);
}

async function sendTest(env: Env, user: User, r: IssueRow) {
  requireManager(user);
  const s = await getSettings(env);
  let sender: { token: string; email: string };
  try { sender = await senderToken(env, user.memberEmail); } catch (e) {
    throw new HttpError(409, (e instanceof Error ? e.message : String(e)), 'sender_not_connected');
  }
  const recipient: Recipient = {
    firstName: user.name.split(' ')[0] || 'there', lastName: user.name.split(' ').slice(1).join(' '), company: 'Axal VC', email: user.memberEmail,
    unsubscribeUrl: appUrl(env) + '/api/public/newsletter/test-link', preferencesUrl: appUrl(env) + '/api/public/newsletter/test-link', viewUrl: appUrl(env) + '/api/public/newsletter/test-link'
  };
  const so = signoffOf(r);
  const out = renderIssue({ content: contentOf(r), edition: r.edition, brand: brandOf(s), recipient, sender: { name: r.from_name || s.from_name, title: so.title, email: r.from_email || sender.email, calendarUrl: so.calendarUrl } });
  const raw = buildMime({
    from: { name: r.from_name || s.from_name || 'Axal VC', email: sender.email, org: '' }, to: [{ name: user.name, email: user.memberEmail, org: '' }], cc: [], bcc: [],
    subject: '[Test] ' + r.subject, html: out.html, text: out.text, attachments: []
  });
  const res = await fetch(GMAIL + '/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + sender.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(raw)) }) });
  if (!res.ok) throw new HttpError(502, 'Gmail refused the test (' + res.status + ').', 'gmail_failed');
  await event(env, 'test_sent', user.memberEmail, r.id, null);
  return { ok: true, to: user.memberEmail };
}

/** Each recipient of an issue and what happened, for the sent page. `q` searches name and email; `status` filters. */
async function report(env: Env, r: IssueRow, q: URLSearchParams) {
  const rows = (await env.DB.prepare(`SELECT n.email, s.first_name, s.last_name, n.status, n.error, n.sent_at,
      EXISTS (SELECT 1 FROM nl_events e WHERE e.issue_id = n.issue_id AND e.subscriber_id = n.subscriber_id AND e.kind = 'unsubscribe') AS unsub
      FROM nl_sends n LEFT JOIN nl_subscribers s ON s.id = n.subscriber_id WHERE n.issue_id = ?1
    UNION ALL SELECT email, first_name, last_name, status, error, sent_at, 0 AS unsub FROM nl_ext_sends WHERE issue_id = ?1`).bind(r.id)
    .all<{ email: string; first_name: string | null; last_name: string | null; status: string; error: string | null; sent_at: number | null; unsub: number }>()).results;
  const label = (x: (typeof rows)[number]) =>
    x.unsub ? 'unsubscribed' : x.status === 'sent' ? 'accepted' : x.status === 'unconfirmed' || (x.status === 'failed' && (x.error || '').startsWith('Unconfirmed')) ? 'unconfirmed'
      : x.status === 'failed' ? 'failed' : x.status === 'skipped' ? 'skipped' : 'queued';
  const all = rows.map(x => ({
    name: [x.first_name, x.last_name].filter(Boolean).join(' '), email: x.email || 'deleted subscriber', status: label(x), time: x.sent_at,
    detail: label(x) === 'unsubscribed' ? 'Unsubscribed from this issue' : (x.error || '').replace(/^Unconfirmed: /, '')
  }));
  const figures = {
    recipients: all.length, accepted: all.filter(x => x.status === 'accepted' || x.status === 'unsubscribed').length, failed: all.filter(x => x.status === 'failed').length,
    unconfirmed: all.filter(x => x.status === 'unconfirmed').length, skipped: all.filter(x => x.status === 'skipped').length, queued: all.filter(x => x.status === 'queued').length,
    unsubscribes: all.filter(x => x.status === 'unsubscribed').length,
    // Replies and bounce notices aren't read from the sending mailbox yet.
    replies: null as number | null, bounces: null as number | null
  };
  const text = (q.get('q') || '').trim().toLowerCase();
  const st = q.get('status') || '';
  const shown = all.filter(x => (!st || x.status === st) && (!text || x.email.toLowerCase().includes(text) || x.name.toLowerCase().includes(text)));
  return { figures, total: shown.length, recipients: shown.slice(0, 500) };
}

/** Addresses the member's sending grant can send as (Gmail "Send mail as"), for the From choice. */
async function senders(env: Env, user: User) {
  let sender: { token: string; email: string };
  try { sender = await senderToken(env, user.memberEmail); } catch (e) {
    return { connected: false, error: e instanceof Error ? e.message : String(e), addresses: [] as { email: string; name: string; primary: boolean }[] };
  }
  const r = await fetch(GMAIL + '/settings/sendAs', { headers: { Authorization: 'Bearer ' + sender.token } });
  const list = r.ok ? (((await r.json()) as { sendAs?: { sendAsEmail: string; displayName?: string; verificationStatus?: string; isPrimary?: boolean }[] }).sendAs || []) : [];
  const addresses = list.filter(a => a.isPrimary || a.verificationStatus === 'accepted').map(a => ({ email: a.sendAsEmail.toLowerCase(), name: a.displayName || '', primary: !!a.isPrimary }));
  if (!addresses.length) addresses.push({ email: sender.email, name: '', primary: true });
  return { connected: true, error: null, addresses };
}

/** StudioOS lists with their counts, for the audience step. */
async function linkAudiences(env: Env) {
  if (!link.linkConfigured(env)) return { configured: false, error: null, audiences: [] as link.Audience[] };
  try {
    const audiences = await link.audiences(env);
    await noteLinkRead(env, { lists: audiences.length });
    return { configured: true, error: null, audiences };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : String(e), audiences: [] as link.Audience[] };
  }
}

// ---------- subscribers ----------

interface SubRow {
  id: number; email: string; first_name: string; last_name: string; company: string; status: string; source: string;
  consent_method: string | null; consent_at: number | null; frequency: string; confirm_sent_at: number | null;
  created_at: number; updated_at: number; unsubscribed_at: number | null; last_sent_at: number | null;
}

async function subOut(env: Env, r: SubRow) {
  const ls = (await env.DB.prepare('SELECT list_id FROM nl_memberships WHERE subscriber_id = ?1').bind(r.id).all<{ list_id: number }>()).results.map(x => x.list_id);
  return {
    id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, company: r.company, status: r.status, source: r.source,
    consentMethod: r.consent_method, consentAt: r.consent_at, frequency: r.frequency, createdAt: r.created_at, unsubscribedAt: r.unsubscribed_at,
    lastSentAt: r.last_sent_at, listIds: ls
  };
}

async function setLists(env: Env, id: number, ids: number[]) {
  await env.DB.prepare('DELETE FROM nl_memberships WHERE subscriber_id = ?1').bind(id).run();
  for (const l of ids) await env.DB.prepare('INSERT OR IGNORE INTO nl_memberships (subscriber_id, list_id, added_at) VALUES (?1, ?2, ?3)').bind(id, l, Date.now()).run();
}

async function listSubscribers(env: Env, q: URLSearchParams) {
  const where: string[] = ['1 = 1'];
  const args: unknown[] = [];
  // Each condition uses its argument through "$" (one numbered parameter, possibly used more than once).
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\$/g, '?' + args.length)); };
  const text = (q.get('q') || '').trim().toLowerCase().replace(/[%_]/g, '');
  if (text) add("(lower(email) LIKE $ OR lower(first_name || ' ' || last_name) LIKE $ OR lower(company) LIKE $)", '%' + text + '%');
  if (q.get('status')) add('status = $', q.get('status'));
  if (q.get('list')) add('EXISTS (SELECT 1 FROM nl_memberships m WHERE m.subscriber_id = nl_subscribers.id AND m.list_id = $)', Number(q.get('list')));
  const page = Math.max(0, Number(q.get('page')) || 0);
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_subscribers WHERE ' + where.join(' AND ')).bind(...args).first<{ n: number }>())?.n || 0;
  const rows = (await env.DB.prepare('SELECT * FROM nl_subscribers WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT 100 OFFSET ' + page * 100).bind(...args).all<SubRow>()).results;
  return { total, page, subscribers: await Promise.all(rows.map(r => subOut(env, r))) };
}

/** Add or update people. Attested consent subscribes them; otherwise they get a confirmation email first. Unsubscribed and suppressed people are never re-added. */
async function addPeople(env: Env, user: User, rows: unknown, lists: number[], attested: boolean, source: 'import' | 'manual') {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Nobody to add.');
  if (rows.length > MAX_IMPORT) throw new HttpError(400, 'Import up to ' + MAX_IMPORT + ' people at a time.');
  if (!lists.length) throw new HttpError(400, 'Choose at least one list.');
  const now = Date.now();
  const result = { added: 0, updated: 0, pendingConfirmation: 0, skipped: 0, invalid: 0 };
  for (const x of rows as Record<string, unknown>[]) {
    const email = str(x?.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) { result.invalid++; continue; }
    if (await env.DB.prepare('SELECT 1 FROM nl_suppressions WHERE email_hash = ?1').bind(await sha256(email)).first()) { result.skipped++; continue; }
    const cur = await env.DB.prepare('SELECT * FROM nl_subscribers WHERE email = ?1').bind(email).first<SubRow>();
    if (cur && ['unsubscribed', 'bounced', 'suppressed'].includes(cur.status)) { result.skipped++; continue; }
    const first = str(x.firstName, 80), last = str(x.lastName, 80), company = str(x.company, 120);
    let id: number;
    if (cur) {
      await env.DB.prepare(`UPDATE nl_subscribers SET first_name = CASE WHEN ?2 != '' THEN ?2 ELSE first_name END, last_name = CASE WHEN ?3 != '' THEN ?3 ELSE last_name END,
        company = CASE WHEN ?4 != '' THEN ?4 ELSE company END, updated_at = ?5 WHERE id = ?1`).bind(cur.id, first, last, company, now).run();
      id = cur.id;
      result.updated++;
    } else {
      const status = attested ? 'subscribed' : 'pending';
      const r = await env.DB.prepare(`INSERT INTO nl_subscribers (email, first_name, last_name, company, status, source, consent_method, consent_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`).bind(email, first, last, company, status, source, attested ? (source === 'import' ? 'import_attested' : 'manual') : null, attested ? now : null, now).run();
      id = Number(r.meta.last_row_id);
      result.added++;
      if (!attested) result.pendingConfirmation++;
      await event(env, source === 'import' ? 'imported' : 'added', (attested ? 'consent attested by ' : 'confirmation requested by ') + user.memberEmail, null, id);
    }
    for (const l of lists) await env.DB.prepare('INSERT OR IGNORE INTO nl_memberships (subscriber_id, list_id, added_at) VALUES (?1, ?2, ?3)').bind(id, l, now).run();
  }
  return result;
}

async function updateSubscriber(env: Env, r: SubRow, b: Record<string, unknown>, user: User) {
  const status = b.status === undefined ? r.status : String(b.status);
  if (!['subscribed', 'unsubscribed', 'bounced', 'suppressed', 'pending'].includes(status)) throw new HttpError(400, 'Unknown status');
  // Only the person can resubscribe after leaving (from their own preferences link).
  if (status === 'subscribed' && r.status !== 'subscribed') throw new HttpError(400, 'Only the subscriber can resubscribe, from the link in any newsletter or by signing up again.', 'consent_required');
  if (status === 'pending' && r.status !== 'pending') throw new HttpError(400, 'Unknown status change');
  await env.DB.prepare(`UPDATE nl_subscribers SET first_name = ?2, last_name = ?3, company = ?4, status = ?5, unsubscribed_at = CASE WHEN ?5 = 'unsubscribed' AND status != 'unsubscribed' THEN ?6 ELSE unsubscribed_at END, updated_at = ?6 WHERE id = ?1`)
    .bind(r.id, b.firstName === undefined ? r.first_name : str(b.firstName, 80), b.lastName === undefined ? r.last_name : str(b.lastName, 80), b.company === undefined ? r.company : str(b.company, 120), status, Date.now()).run();
  if (b.listIds !== undefined) await setLists(env, r.id, await listIds(env, b.listIds));
  if (status !== r.status) await event(env, status === 'unsubscribed' ? 'unsubscribe' : 'status', status + ' by ' + user.memberEmail, null, r.id);
}

async function deleteSubscriber(env: Env, r: SubRow) {
  // The address is kept only as a hash, so an import never adds them back.
  await env.DB.prepare('INSERT OR IGNORE INTO nl_suppressions (email_hash, reason, at) VALUES (?1, ?2, ?3)').bind(await sha256(r.email.toLowerCase()), 'data deleted', Date.now()).run();
  await env.DB.prepare('DELETE FROM nl_memberships WHERE subscriber_id = ?1').bind(r.id).run();
  await env.DB.prepare("UPDATE nl_sends SET email = '' WHERE subscriber_id = ?1").bind(r.id).run();
  await env.DB.prepare('DELETE FROM nl_events WHERE subscriber_id = ?1').bind(r.id).run();
  await env.DB.prepare('DELETE FROM nl_subscribers WHERE id = ?1').bind(r.id).run();
}

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function exportCsv(env: Env) {
  const rows = (await env.DB.prepare('SELECT * FROM nl_subscribers ORDER BY created_at').all<SubRow>()).results;
  const names = new Map((await env.DB.prepare('SELECT id, name FROM nl_lists').all<{ id: number; name: string }>()).results.map(l => [l.id, l.name]));
  const memb = (await env.DB.prepare('SELECT subscriber_id, list_id FROM nl_memberships').all<{ subscriber_id: number; list_id: number }>()).results;
  const by = new Map<number, string[]>();
  for (const m of memb) by.set(m.subscriber_id, [...(by.get(m.subscriber_id) || []), names.get(m.list_id) || '']);
  const lines = [['email', 'first_name', 'last_name', 'company', 'status', 'source', 'consent_method', 'consent_at', 'lists'].join(',')];
  for (const r of rows) lines.push([r.email, r.first_name, r.last_name, r.company, r.status, r.source, r.consent_method, r.consent_at ? new Date(r.consent_at).toISOString() : '', (by.get(r.id) || []).join('; ')].map(csvCell).join(','));
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' } });
}

// ---------- sending (cron) ----------

/** Send a confirmation (double opt-in) email now, with the system sender. Throws if nothing can send. */
export async function sendConfirmation(env: Env, sub: { id: number; email: string; first_name: string }) {
  const s = await getSettings(env);
  if (!s.system_sender) throw new SenderUnavailable('No system sender is set in Newsletters → Settings.');
  const sender = await senderToken(env, s.system_sender);
  const t = await sign(env, 'c', sub.id);
  const out = renderSystem({ kind: 'confirm', brand: brandOf(s), firstName: sub.first_name, confirmUrl: appUrl(env) + '/api/public/newsletter/confirm?t=' + t });
  await gmailSend(sender, buildMime({
    from: { name: s.from_name || 'Axal VC', email: s.system_from || sender.email, org: '' }, to: [{ name: sub.first_name, email: sub.email, org: '' }], cc: [], bcc: [],
    subject: out.subject, html: out.html, text: out.text, attachments: []
  }));
  await env.DB.prepare('UPDATE nl_subscribers SET confirm_sent_at = ?2 WHERE id = ?1').bind(sub.id, Date.now()).run();
}

export async function sendWelcome(env: Env, sub: { id: number; email: string; first_name: string }) {
  const s = await getSettings(env);
  if (!s.system_sender) return;
  const sender = await senderToken(env, s.system_sender);
  const links = await manageLinks(env, sub.id);
  const out = renderSystem({ kind: 'welcome', brand: brandOf(s), firstName: sub.first_name, preferencesUrl: links.preferencesUrl });
  await gmailSend(sender, buildMime({
    from: { name: s.from_name || 'Axal VC', email: s.system_from || sender.email, org: '' }, to: [{ name: sub.first_name, email: sub.email, org: '' }], cc: [], bcc: [],
    subject: out.subject, html: out.html, text: out.text, attachments: [],
    headers: [['List-Unsubscribe', '<' + links.unsubscribeUrl + '>'], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']]
  }));
}

class GmailError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function gmailSend(sender: { token: string }, raw: string): Promise<string> {
  const res = await fetch(GMAIL + '/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + sender.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(raw)) })
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message || String(res.status);
    throw new GmailError(res.status, msg);
  }
  return ((await res.json()) as { id: string }).id;
}

export interface NewsletterRun { confirmations: number; sent: number; failed: number; unconfirmed: number; started: number; finished: number; paused: number; limited: boolean }

interface Target {
  table: 'nl_sends' | 'nl_ext_sends';
  /** The row's key after issue_id: subscriber_id or email. */
  key: number | string;
  email: string; first_name: string; last_name: string; company: string;
  unsubscribeUrl: string; preferencesUrl: string; viewUrl: string; oneClick: string;
  subscribed: boolean;
}

const keyCol = (t: Target['table']) => (t === 'nl_sends' ? 'subscriber_id' : 'email');

/** Read StudioOS recipients for an issue's audiences into nl_ext_sends (once, when it starts). */
async function materializeLink(env: Env, r: IssueRow) {
  const auds = audiencesOf(r);
  let total = 0;
  for (const key of auds) {
    const people = await link.recipients(env, key);
    total += people.length;
    for (const p of people) {
      await env.DB.prepare(`INSERT OR IGNORE INTO nl_ext_sends (issue_id, email, audience, first_name, last_name, company, unsubscribe_url, preferences_url, one_click_url, status)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued'
        WHERE NOT EXISTS (SELECT 1 FROM nl_sends n WHERE n.issue_id = ?1 AND n.email = ?2 COLLATE NOCASE)
        AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.email = ?2 COLLATE NOCASE)`)
        .bind(r.id, p.email, key, p.first_name, p.last_name, p.company, safeUrl(p.unsubscribe_url), safeUrl(p.preferences_url), safeUrl(p.one_click_url)).run();
    }
  }
  if (auds.length) await noteLinkRead(env, {});
  return total;
}

/** Cron: queued confirmations, then due issues, within the batch size, the per-minute throttle and the daily limit. Safe to run twice. */
export async function runNewsletters(env: Env, now = Date.now()): Promise<NewsletterRun> {
  const out: NewsletterRun = { confirmations: 0, sent: 0, failed: 0, unconfirmed: 0, started: 0, finished: 0, paused: 0, limited: false };
  const s = await getSettings(env);
  // The cron runs every 10 minutes; the throttle spreads a run's messages over those minutes' worth.
  let budget = Math.min(s.batch_size, s.per_minute * 10);

  // Confirmation emails that couldn't be sent at signup (or were requested on import).
  if (s.system_sender && tokensReady(env)) {
    const pending = (await env.DB.prepare("SELECT id, email, first_name FROM nl_subscribers WHERE status = 'pending' AND confirm_sent_at IS NULL ORDER BY created_at LIMIT ?1")
      .bind(Math.min(CONFIRMS_PER_RUN, budget)).all<{ id: number; email: string; first_name: string }>()).results;
    for (const p of pending) {
      try { await sendConfirmation(env, p); out.confirmations++; budget--; } catch (e) {
        if (e instanceof SenderUnavailable) break;
        if (e instanceof GmailError && (e.status === 429 || e.status >= 500)) break;
        await env.DB.prepare('UPDATE nl_subscribers SET confirm_sent_at = ?2 WHERE id = ?1').bind(p.id, now).run(); // don't retry a refused address
      }
    }
  }

  // Start scheduled issues whose time has come: fix the recipient list now.
  const due = (await env.DB.prepare("SELECT * FROM nl_issues WHERE status = 'scheduled' AND scheduled_at <= ?1 ORDER BY scheduled_at").bind(now).all<IssueRow>()).results;
  for (const r of due) {
    if (!approvedNow(r)) {
      await env.DB.prepare("UPDATE nl_issues SET status = 'paused', last_error = 'Not approved as it is now.' WHERE id = ?1").bind(r.id).run();
      out.paused++;
      continue;
    }
    const ids = JSON.parse(r.list_ids) as number[];
    if (ids.length) {
      await env.DB.prepare(`INSERT OR IGNORE INTO nl_sends (issue_id, subscriber_id, email, status)
        SELECT DISTINCT ?1, s.id, s.email, 'queued' FROM nl_subscribers s JOIN nl_memberships m ON m.subscriber_id = s.id
        WHERE s.status = 'subscribed' AND m.list_id IN (${ids.map(() => '?').join(',')}) AND (s.frequency = 'all' OR ?${ids.length + 2} = 1)
        AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.email = s.email COLLATE NOCASE)`).bind(r.id, ...ids, ESSENTIALS.includes(r.template) ? 1 : 0).run();
    }
    try { await materializeLink(env, r); } catch (e) {
      // StudioOS didn't answer: wait, rather than send to only part of the audience.
      await env.DB.prepare('DELETE FROM nl_ext_sends WHERE issue_id = ?1').bind(r.id).run();
      await env.DB.prepare('UPDATE nl_issues SET last_error = ?2 WHERE id = ?1').bind(r.id, 'Waiting for StudioOS: ' + (e instanceof Error ? e.message : String(e)).slice(0, 200) + ' Sending starts when the lists can be read.').run();
      continue;
    }
    const n = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_sends WHERE issue_id = ?1').bind(r.id).first<{ n: number }>())?.n || 0)
      + ((await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_ext_sends WHERE issue_id = ?1').bind(r.id).first<{ n: number }>())?.n || 0);
    await env.DB.prepare("UPDATE nl_issues SET status = 'sending', started_at = ?2, recipients = ?3, last_error = NULL WHERE id = ?1 AND status = 'scheduled'").bind(r.id, now, n).run();
    out.started++;
  }

  // The daily limit: what's left of today's allowance.
  const left = Math.max(0, s.daily_limit - (await sentToday(env, now)));
  if (left < budget) { budget = left; }

  // Send from issues in progress, oldest first, within the budget.
  const sending = (await env.DB.prepare("SELECT * FROM nl_issues WHERE status = 'sending' ORDER BY started_at").all<IssueRow>()).results;
  for (const r of sending) {
    // A claim left by a run that died mid-send may have gone out: unconfirmed, never resent.
    await env.DB.prepare("UPDATE nl_sends SET status = 'failed', error = 'Unconfirmed: interrupted while sending. Check Sent mail.' WHERE issue_id = ?1 AND status = 'sending' AND sent_at < ?2").bind(r.id, now - STUCK_MS).run();
    await env.DB.prepare("UPDATE nl_ext_sends SET status = 'unconfirmed', error = 'Interrupted while sending. Check Sent mail.' WHERE issue_id = ?1 AND status = 'sending' AND sent_at < ?2").bind(r.id, now - STUCK_MS).run();
    if (budget <= 0) {
      const done = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_sends WHERE issue_id = ?1 AND status != 'queued'").bind(r.id).first<{ n: number }>())?.n || 0)
        + ((await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_ext_sends WHERE issue_id = ?1 AND status != 'queued'").bind(r.id).first<{ n: number }>())?.n || 0);
      if (left <= 0) {
        out.limited = true;
        await env.DB.prepare('UPDATE nl_issues SET last_error = ?2 WHERE id = ?1').bind(r.id,
          'Paused at ' + done + ' of ' + r.recipients + '. Resumes tomorrow at 00:00 UTC. The daily limit for ' + (r.from_email || 'the sending address') + ' was reached. Nobody gets the email twice.').run();
      }
      continue;
    }
    let sender: { token: string; email: string };
    try { sender = await senderToken(env, r.sender_member || ''); } catch (e) {
      await env.DB.prepare("UPDATE nl_issues SET status = 'paused', last_error = ?2 WHERE id = ?1").bind(r.id, (e instanceof Error ? e.message : String(e)).slice(0, 400)).run();
      out.paused++;
      continue;
    }
    if (r.last_error?.startsWith('Paused at ')) await env.DB.prepare('UPDATE nl_issues SET last_error = NULL WHERE id = ?1').bind(r.id).run();
    const content = contentOf(r);
    const so = signoffOf(r);
    const brand = brandOf(s);

    const local = (await env.DB.prepare(`SELECT n.subscriber_id, s.email, s.first_name, s.last_name, s.company, s.status FROM nl_sends n JOIN nl_subscribers s ON s.id = n.subscriber_id
      WHERE n.issue_id = ?1 AND n.status = 'queued' LIMIT ?2`).bind(r.id, budget).all<{ subscriber_id: number; email: string; first_name: string; last_name: string; company: string; status: string }>()).results;
    const targets: Target[] = [];
    for (const x of local) {
      const l = await manageLinks(env, x.subscriber_id, r.id);
      targets.push({ table: 'nl_sends', key: x.subscriber_id, email: x.email, first_name: x.first_name, last_name: x.last_name, company: x.company, subscribed: x.status === 'subscribed',
        unsubscribeUrl: l.unsubscribeUrl, preferencesUrl: l.preferencesUrl, viewUrl: l.viewUrl, oneClick: l.unsubscribeUrl });
    }
    if (targets.length < budget) {
      const ext = (await env.DB.prepare("SELECT * FROM nl_ext_sends WHERE issue_id = ?1 AND status = 'queued' LIMIT ?2").bind(r.id, budget - targets.length)
        .all<{ email: string; first_name: string; last_name: string; company: string; unsubscribe_url: string; preferences_url: string; one_click_url: string }>()).results;
      for (const x of ext) {
        targets.push({ table: 'nl_ext_sends', key: x.email, email: x.email, first_name: x.first_name, last_name: x.last_name, company: x.company, subscribed: true,
          unsubscribeUrl: x.unsubscribe_url || x.one_click_url, preferencesUrl: x.preferences_url || x.unsubscribe_url, viewUrl: x.preferences_url || x.unsubscribe_url, oneClick: x.one_click_url || x.unsubscribe_url });
      }
    }

    let stop = false;
    for (const x of targets) {
      if (stop) break;
      const col = keyCol(x.table);
      // Claim it: a second runner finds it taken.
      const claim = await env.DB.prepare(`UPDATE ${x.table} SET status = 'sending', sent_at = ?3 WHERE issue_id = ?1 AND ${col} = ?2 AND status = 'queued'`).bind(r.id, x.key, now).run();
      if (!claim.meta.changes) continue;
      budget--;
      if (!x.subscribed) {
        await env.DB.prepare(`UPDATE ${x.table} SET status = 'skipped', error = 'No longer subscribed' WHERE issue_id = ?1 AND ${col} = ?2`).bind(r.id, x.key).run();
        continue;
      }
      const copy = renderIssue({
        content, edition: r.edition, brand,
        recipient: { firstName: x.first_name, lastName: x.last_name, company: x.company, email: x.email, unsubscribeUrl: x.unsubscribeUrl, preferencesUrl: x.preferencesUrl, viewUrl: x.viewUrl },
        sender: { name: r.from_name || s.from_name, title: so.title, email: r.from_email || sender.email, calendarUrl: so.calendarUrl }
      });
      const raw = buildMime({
        from: { name: r.from_name || s.from_name || 'Axal VC', email: r.from_email || sender.email, org: '' },
        to: [{ name: [x.first_name, x.last_name].filter(Boolean).join(' '), email: x.email, org: '' }], cc: [], bcc: [],
        subject: mergeSubject(content.subject, x), html: copy.html, text: copy.text, attachments: [],
        headers: x.oneClick ? [['List-Unsubscribe', '<' + x.oneClick + '>'], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']] : []
      });
      try {
        const id = await gmailSend(sender, raw);
        await env.DB.prepare(`UPDATE ${x.table} SET status = 'sent', gmail_message_id = ?3, sent_at = ?4 WHERE issue_id = ?1 AND ${col} = ?2`).bind(r.id, x.key, id, now).run();
        if (x.table === 'nl_sends') await env.DB.prepare('UPDATE nl_subscribers SET last_sent_at = ?2 WHERE id = ?1').bind(x.key, now).run();
        out.sent++;
      } catch (e) {
        if (e instanceof GmailError && (e.status === 429 || e.status >= 500)) {
          // Gmail didn't take it (limit or outage): back in the queue, try on a later run.
          await env.DB.prepare(`UPDATE ${x.table} SET status = 'queued', error = ?3 WHERE issue_id = ?1 AND ${col} = ?2`).bind(r.id, x.key, e.message.slice(0, 300)).run();
          await env.DB.prepare('UPDATE nl_issues SET last_error = ?2 WHERE id = ?1').bind(r.id, 'The mail provider is limiting sends (' + e.message.slice(0, 200) + '). The rest go out on later runs.').run();
          stop = true;
          budget = 0;
        } else if (e instanceof GmailError) {
          // Refused: never retried.
          await env.DB.prepare(`UPDATE ${x.table} SET status = 'failed', error = ?3 WHERE issue_id = ?1 AND ${col} = ?2`).bind(r.id, x.key, e.message.slice(0, 300)).run();
          out.failed++;
        } else {
          // No answer (the connection dropped): it may have gone out, so it is never resent.
          const msg = 'No answer from the provider. Check Sent mail.';
          if (x.table === 'nl_sends') await env.DB.prepare("UPDATE nl_sends SET status = 'failed', error = ?3 WHERE issue_id = ?1 AND subscriber_id = ?2").bind(r.id, x.key, 'Unconfirmed: ' + msg).run();
          else await env.DB.prepare("UPDATE nl_ext_sends SET status = 'unconfirmed', error = ?3 WHERE issue_id = ?1 AND email = ?2").bind(r.id, x.key, msg).run();
          out.unconfirmed++;
        }
      }
    }
    const open = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_sends WHERE issue_id = ?1 AND status IN ('queued', 'sending')").bind(r.id).first<{ n: number }>())?.n || 0)
      + ((await env.DB.prepare("SELECT COUNT(*) AS n FROM nl_ext_sends WHERE issue_id = ?1 AND status IN ('queued', 'sending')").bind(r.id).first<{ n: number }>())?.n || 0);
    if (!open) {
      await env.DB.prepare("UPDATE nl_issues SET status = 'sent', sent_at = ?2 WHERE id = ?1 AND status = 'sending'").bind(r.id, now).run();
      out.finished++;
    }
  }
  return out;
}

/** The browser copy of a sent issue, for "View in browser": only for someone it was actually sent to. */
export async function viewCopy(env: Env, issueId: number, subscriberId: number): Promise<string | null> {
  const sent = await env.DB.prepare("SELECT 1 FROM nl_sends WHERE issue_id = ?1 AND subscriber_id = ?2 AND status = 'sent'").bind(issueId, subscriberId).first();
  if (!sent) return null;
  const r = await env.DB.prepare('SELECT * FROM nl_issues WHERE id = ?1').bind(issueId).first<IssueRow>();
  const x = await env.DB.prepare('SELECT * FROM nl_subscribers WHERE id = ?1').bind(subscriberId).first<SubRow>();
  if (!r || !x) return null;
  const s = await getSettings(env);
  const so = signoffOf(r);
  const links = await manageLinks(env, x.id, r.id);
  return renderIssue({
    content: { ...contentOf(r), subject: mergeSubject(r.subject, x) }, edition: r.edition, brand: brandOf(s),
    recipient: { firstName: x.first_name, lastName: x.last_name, company: x.company, email: x.email, ...links },
    sender: { name: r.from_name || s.from_name, title: so.title, email: r.from_email, calendarUrl: so.calendarUrl }
  }).html;
}

const mergeSubject = (subject: string, x: { first_name: string; last_name: string; company: string }) =>
  subject.replace(/\{(first_name|last_name|company)(?:\|([^}]*))?\}/g, (_m, k: string, fb?: string) => ({ first_name: x.first_name, last_name: x.last_name, company: x.company } as Record<string, string>)[k] || fb || '');

// ---------- routes ----------

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const path = url.pathname;
  const m = req.method;
  if (path === '/api/newsletters') {
    if (m === 'GET') {
      // Newsletters by default; ?programme=<uid> lists a programme's testing emails, ?scope=review everything awaiting approval.
      const scope = url.searchParams.get('scope');
      const prog = url.searchParams.get('programme');
      const where = scope === 'review' ? "status = 'in_review'" : prog ? 'programme_uid = ?1' : 'programme_uid IS NULL';
      const q = env.DB.prepare('SELECT * FROM nl_issues WHERE ' + where + " ORDER BY CASE status WHEN 'sending' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'in_review' THEN 2 ELSE 3 END, updated_at DESC LIMIT 300");
      const rows = (await (prog && scope !== 'review' ? q.bind(prog.slice(0, 80)) : q).all<IssueRow>()).results;
      return json({ issues: await Promise.all(rows.map(r => issueOut(env, user, r))), lists: await lists(env), you: user.memberEmail, role: user.role, canManage: isManager(user) });
    }
    if (m === 'POST') return json({ issue: await create(env, user, await readJson(req)) }, 201);
  }
  if (path === '/api/newsletters/settings') {
    if (m === 'GET') return json({ settings: await settingsOut(await getSettings(env), env) });
    if (m === 'PUT') return json({ settings: await putSettings(env, user, await readJson(req)) });
  }
  if (path === '/api/newsletters/assist' && m === 'POST') return json(await newsletterAssist(env, user, await readJson(req)));
  if (path === '/api/newsletters/senders' && m === 'GET') return json(await senders(env, user));
  if (path === '/api/newsletters/audiences' && m === 'GET') return json(await linkAudiences(env));
  if (path === '/api/newsletters/link' && m === 'POST') {
    // "Test the link": a signed health read.
    requireManager(user);
    try { await link.health(env); await noteLinkRead(env, {}); return json({ ok: true, settings: await settingsOut(await getSettings(env), env) }); } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (path === '/api/newsletters/lists') {
    if (m === 'GET') return json({ lists: await lists(env) });
    if (m === 'POST') {
      requireManager(user);
      const b = await readJson<{ name?: unknown; description?: unknown; requiresApproval?: unknown; public?: unknown }>(req);
      const name = str(b.name, 80);
      if (name.length < 2) throw new HttpError(400, 'Name the list.');
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
      await env.DB.prepare('INSERT INTO nl_lists (key, name, description, public, requires_approval, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(key, name, str(b.description, 200), b.public === true ? 1 : 0, b.requiresApproval === true ? 1 : 0, Date.now()).run();
      return json({ lists: await lists(env) }, 201);
    }
  }
  const listM = /^\/api\/newsletters\/lists\/(\d+)$/.exec(path);
  if (listM) {
    requireManager(user);
    const l = await env.DB.prepare('SELECT * FROM nl_lists WHERE id = ?1').bind(Number(listM[1])).first<ListRow>();
    if (!l) throw new HttpError(404, 'List not found');
    if (m === 'PATCH') {
      const b = await readJson<{ name?: unknown; description?: unknown; requiresApproval?: unknown; public?: unknown }>(req);
      // Approval can be added to a list by any admin; only a super admin removes it.
      if (b.requiresApproval === false && l.requires_approval && user.role !== 'super_admin') throw new HttpError(403, 'Only a super admin removes the approval requirement from a list.', 'super_admin_only');
      await env.DB.prepare('UPDATE nl_lists SET name = ?2, description = ?3, public = ?4, requires_approval = ?5 WHERE id = ?1')
        .bind(l.id, str(b.name, 80) || l.name, b.description === undefined ? l.description : str(b.description, 200), b.public === undefined ? l.public : b.public === true ? 1 : 0, b.requiresApproval === undefined ? l.requires_approval : b.requiresApproval === true ? 1 : 0).run();
      return json({ lists: await lists(env) });
    }
    if (m === 'DELETE') {
      const used = await env.DB.prepare("SELECT 1 FROM nl_issues WHERE status IN ('scheduled', 'sending') AND EXISTS (SELECT 1 FROM json_each(list_ids) j WHERE j.value = ?1)").bind(l.id).first();
      if (used) throw new HttpError(409, 'A scheduled newsletter uses this list.');
      await env.DB.prepare('DELETE FROM nl_memberships WHERE list_id = ?1').bind(l.id).run();
      await env.DB.prepare('DELETE FROM nl_lists WHERE id = ?1').bind(l.id).run();
      return json({ lists: await lists(env) });
    }
  }
  if (path === '/api/newsletters/subscribers' || path.startsWith('/api/newsletters/subscribers')) {
    requireManager(user);
    if (path === '/api/newsletters/subscribers') {
      if (m === 'GET') return json(await listSubscribers(env, url.searchParams));
      if (m === 'POST') {
        const b = await readJson<{ email?: unknown; firstName?: unknown; lastName?: unknown; company?: unknown; listIds?: unknown; attested?: unknown }>(req);
        return json(await addPeople(env, user, [b], await listIds(env, b.listIds), b.attested === true, 'manual'), 201);
      }
    }
    if (path === '/api/newsletters/subscribers/import' && m === 'POST') {
      const b = await readJson<{ rows?: unknown; listIds?: unknown; attested?: unknown }>(req);
      return json(await addPeople(env, user, b.rows, await listIds(env, b.listIds), b.attested === true, 'import'));
    }
    if (path === '/api/newsletters/subscribers.csv' && m === 'GET') return exportCsv(env);
    const sm = /^\/api\/newsletters\/subscribers\/(\d+)$/.exec(path);
    if (sm) {
      const r = await env.DB.prepare('SELECT * FROM nl_subscribers WHERE id = ?1').bind(Number(sm[1])).first<SubRow>();
      if (!r) throw new HttpError(404, 'Subscriber not found');
      if (m === 'GET') {
        const events = (await env.DB.prepare('SELECT kind, detail, issue_id AS issueId, at FROM nl_events WHERE subscriber_id = ?1 ORDER BY at DESC LIMIT 100').bind(r.id).all()).results;
        const issues = (await env.DB.prepare('SELECT i.id, i.title, n.status, n.sent_at AS sentAt FROM nl_sends n JOIN nl_issues i ON i.id = n.issue_id WHERE n.subscriber_id = ?1 ORDER BY n.sent_at DESC LIMIT 100').bind(r.id).all()).results;
        return json({ subscriber: await subOut(env, r), events, issues });
      }
      if (m === 'PATCH') { await updateSubscriber(env, r, await readJson(req), user); return json({ subscriber: await subOut(env, (await env.DB.prepare('SELECT * FROM nl_subscribers WHERE id = ?1').bind(r.id).first<SubRow>())!) }); }
      if (m === 'DELETE') { await deleteSubscriber(env, r); return json({ ok: true }); }
    }
    throw new HttpError(404, 'Not found');
  }

  const one = /^\/api\/newsletters\/(\d+)(\/[a-z]+)?$/.exec(path);
  if (!one) throw new HttpError(404, 'Not found');
  const r = await load(env, Number(one[1]));
  const action = one[2];
  if (!action) {
    if (m === 'GET') return json({ issue: await issueOut(env, user, r, true), checks: await blockers(env, r) });
    if (m === 'PUT') return json({ issue: await update(env, user, r, await readJson(req)) });
    if (m === 'DELETE') {
      if (!['draft', 'cancelled', 'in_review'].includes(r.status)) throw new HttpError(409, 'Only a draft can be deleted.');
      if (r.created_by !== user.memberEmail && !isManager(user)) throw new HttpError(403, 'Only its author or an admin deletes it.');
      await env.DB.prepare('DELETE FROM nl_issues WHERE id = ?1').bind(r.id).run();
      return json({ ok: true });
    }
  }
  if (m !== 'POST' && action !== '/report') throw new HttpError(405, 'Method not allowed');
  const body = m === 'POST' && (req.headers.get('Content-Type') || '').includes('json') ? await readJson<Record<string, unknown>>(req) : {};
  switch (action) {
    case '/review': {
      if (!(isManager(user) || r.created_by === user.memberEmail)) throw new HttpError(403, 'Only its author or an admin asks for review.');
      if (r.status !== 'draft') throw new HttpError(409, 'Only a draft goes to review.');
      stale(r, body);
      await env.DB.prepare("UPDATE nl_issues SET status = 'in_review', review_requested_by = ?2, last_error = NULL WHERE id = ?1").bind(r.id, user.memberEmail).run();
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
    case '/approve': {
      requireManager(user);
      stale(r, body);
      if (r.status !== 'in_review') throw new HttpError(409, 'Ask for review first.');
      if ((r.review_requested_by === user.memberEmail || r.updated_by === user.memberEmail) && user.role !== 'super_admin') throw new HttpError(403, 'Ask another admin to approve a newsletter you asked for or edited last.');
      const res = await env.DB.prepare("UPDATE nl_issues SET status = 'approved', approved_hash = content_hash, approved_by = ?2, approved_at = ?3 WHERE id = ?1 AND version = ?4 AND status = 'in_review'")
        .bind(r.id, user.memberEmail, Date.now(), r.version).run();
      if (!res.meta.changes) throw new HttpError(409, 'This newsletter changed since you opened it.', 'issue_changed');
      await event(env, 'approved', user.memberEmail + ' · version ' + r.version + ' · ' + r.content_hash.slice(0, 12), r.id, null);
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
    case '/reject': {
      requireManager(user);
      if (r.status !== 'in_review') throw new HttpError(409, 'Only a newsletter in review can be sent back.');
      const note = str(body.note, 500);
      if (!note) throw new HttpError(400, 'Say what to change.');
      await env.DB.prepare("UPDATE nl_issues SET status = 'draft', review_requested_by = NULL, last_error = ?2 WHERE id = ?1").bind(r.id, 'Sent back by ' + user.memberEmail + ': ' + note).run();
      await event(env, 'rejected', user.memberEmail + ' · ' + note + ' · ' + r.content_hash.slice(0, 12), r.id, null);
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
    case '/schedule': return json({ issue: await schedule(env, user, r, body) });
    case '/cancel': {
      requireManager(user);
      if (r.status === 'scheduled') await env.DB.prepare("UPDATE nl_issues SET status = CASE WHEN approved_hash = content_hash THEN 'approved' ELSE 'draft' END, scheduled_at = NULL WHERE id = ?1").bind(r.id).run();
      else if (r.status === 'sending') await env.DB.prepare("UPDATE nl_issues SET status = 'paused', last_error = ?2 WHERE id = ?1").bind(r.id, 'Paused by ' + user.memberEmail).run();
      else throw new HttpError(409, 'Nothing to stop.');
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
    case '/resume': {
      requireManager(user);
      if (r.status !== 'paused') throw new HttpError(409, 'Only a paused newsletter resumes.');
      if (!approvedNow(r)) throw new HttpError(409, 'Not approved as it is now.', 'needs_approval');
      try { await senderToken(env, r.sender_member || ''); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e), 'sender_not_connected'); }
      await env.DB.prepare(`UPDATE nl_issues SET status = CASE WHEN started_at IS NULL THEN 'scheduled' ELSE 'sending' END, last_error = NULL WHERE id = ?1`).bind(r.id).run();
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
    case '/test': return json(await sendTest(env, user, r));
    case '/duplicate': {
      const now = Date.now();
      const res = await env.DB.prepare(`INSERT INTO nl_issues (title, template, subject, preheader, edition, blocks, list_ids, from_email, from_name, signoff, content_hash, created_by, updated_by, created_at, updated_at, audiences, programme_uid, variant)
        SELECT title || ' (copy)', template, subject, preheader, edition, blocks, list_ids, from_email, from_name, signoff, content_hash, ?2, ?2, ?3, ?3, audiences, programme_uid, variant FROM nl_issues WHERE id = ?1`).bind(r.id, user.memberEmail, now).run();
      return json({ issue: await issueOut(env, user, await load(env, Number(res.meta.last_row_id)), true) }, 201);
    }
    case '/report': return json(await report(env, r, url.searchParams));
    case '/defer': {
      requireManager(user);
      if (r.status !== 'in_review') throw new HttpError(409, 'Only a newsletter awaiting approval can be deferred.');
      const note = str(body.note, 500);
      if (!note) throw new HttpError(400, 'Give a reason to defer.');
      await env.DB.prepare('UPDATE nl_issues SET last_error = ?2 WHERE id = ?1').bind(r.id, 'Deferred by ' + user.memberEmail + ': ' + note).run();
      await event(env, 'deferred', user.memberEmail + ' · ' + note, r.id, null);
      return json({ issue: await issueOut(env, user, await load(env, r.id), true) });
    }
  }
  throw new HttpError(404, 'Not found');
}
