import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';
import { mentionable } from './notes';

/**
 * Contacts & Relationships: people and organizations the team chose to keep.
 * A record is 'team' (every member sees and edits it) or 'private' (only its
 * creator and relationship owner). Every query below filters on that, so a
 * record someone may not see answers 404, exactly like one that does not
 * exist. Email history is not stored: the app reads it from the member's own
 * mailbox when a record is shown.
 */

export const ORG_TYPES = ['Portfolio company', 'Prospect', 'LP / Investor', 'Co-investor', 'Service provider', 'Corporate', 'Other'] as const;
const EVENT_KINDS = ['introduction', 'meeting', 'note'] as const;
const MAX_NOTES = 10_000;
const MAX_EMAILS = 10;

// ---------- normalization ----------

const SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'sa', 'sas', 'sarl', 'ag', 'plc', 'bv', 'nv', 'lp', 'llp', 'the']);

/** "Atlas Systems, Inc." and "atlas systems" are the same organization. */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(w => w && !SUFFIXES.has(w)).join(' ');
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

function str(v: unknown, field: string, max: number, required = false): string {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null) throw new HttpError(400, field + ' must be text');
  if (required && !s) throw new HttpError(400, field + ' is required');
  if (s.length > max) throw new HttpError(400, field + ' is limited to ' + max + ' characters');
  return s;
}

function url(v: unknown, field: string, host?: RegExp): string {
  const s = str(v, field, 300);
  if (!s) return '';
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { throw new HttpError(400, field + ' must be a web address'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, field + ' must be a web address');
  if (host && !host.test(u.hostname)) throw new HttpError(400, field + ' must be a linkedin.com address');
  return u.toString();
}

function tags(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'tags must be a list');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    const s = typeof t === 'string' ? t.trim().slice(0, 40) : '';
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.slice(0, 20);
}

function emails(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'emails must be a list');
  const out = [...new Set(v.map(e => (typeof e === 'string' ? e.trim().toLowerCase() : '')).filter(Boolean))];
  for (const e of out) if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, e + ' is not an email address');
  if (out.length > MAX_EMAILS) throw new HttpError(400, 'At most ' + MAX_EMAILS + ' addresses per contact');
  return out;
}

function domain(v: unknown): string {
  const s = str(v, 'domain', 253).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (s && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) throw new HttpError(400, 'domain must look like example.com');
  return s;
}

const visibility = (v: unknown) => (v === 'private' ? 'private' : 'team');

async function owner(env: Env, v: unknown): Promise<string> {
  const e = str(v, 'owner', 254).toLowerCase();
  if (!e) return '';
  if (!(await mentionable(env)).some(m => m.email === e)) throw new HttpError(400, 'The relationship owner must be a member');
  return e;
}

const parseTags = (s: string): string[] => { try { const t = JSON.parse(s); return Array.isArray(t) ? t : []; } catch { return []; } };
const like = (s: string) => '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';

// Visibility, as SQL on a table alias with ?1 = the member's address.
const VISIBLE = (a: string) => `(${a}.visibility = 'team' OR ${a}.created_by = ?1 OR ${a}.owner_email = ?1)`;

// ---------- contacts ----------

interface ContactRow {
  id: number; name: string; name_key: string; title: string; organization_id: number | null; org_name: string | null; website: string; linkedin: string;
  tags: string; notes: string; owner_email: string; visibility: 'team' | 'private'; created_by: string; created_at: number; updated_at: number;
  archived_at: number | null; merged_into: number | null; emails: string | null;
}

export interface ContactOut {
  id: number; name: string; emails: string[]; title: string; organization: { id: number; name: string } | null; website: string; linkedin: string;
  tags: string[]; notes: string; owner: string; visibility: 'team' | 'private'; createdBy: string; createdAt: number; updatedAt: number;
  archived: boolean; mergedInto: number | null;
  /** The member may change who sees it (creator or owner). */
  canShare: boolean;
}

const CONTACT_SELECT = `SELECT c.*, o.name AS org_name, (SELECT group_concat(email, ' ') FROM contact_emails e WHERE e.contact_id = c.id) AS emails
  FROM contacts c LEFT JOIN organizations o ON o.id = c.organization_id AND ${VISIBLE('o')}`;

function contactOut(r: ContactRow, user: User): ContactOut {
  return {
    id: r.id, name: r.name, emails: r.emails ? r.emails.split(' ').sort() : [], title: r.title,
    organization: r.organization_id && r.org_name ? { id: r.organization_id, name: r.org_name } : null,
    website: r.website, linkedin: r.linkedin, tags: parseTags(r.tags), notes: r.notes, owner: r.owner_email, visibility: r.visibility,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, archived: r.archived_at != null, mergedInto: r.merged_into,
    canShare: r.created_by === user.memberEmail || r.owner_email === user.memberEmail
  };
}

async function getContact(env: Env, user: User, id: number): Promise<ContactRow> {
  const r = await env.DB.prepare(CONTACT_SELECT + ` WHERE c.id = ?2 AND ${VISIBLE('c')}`).bind(user.memberEmail, id).first<ContactRow>();
  if (!r) throw new HttpError(404, 'Contact not found');
  return r;
}

async function listContacts(env: Env, user: User, p: URLSearchParams): Promise<ContactOut[]> {
  const where = [VISIBLE('c'), p.get('archived') === '1' ? 'c.archived_at IS NOT NULL AND c.merged_into IS NULL' : 'c.archived_at IS NULL'];
  const args: unknown[] = [user.memberEmail];
  const q = (p.get('q') || '').trim().toLowerCase();
  if (q) {
    args.push(like(q));
    const n = '?' + args.length;
    where.push(`(lower(c.name) LIKE ${n} ESCAPE '\\' OR lower(c.title) LIKE ${n} ESCAPE '\\' OR lower(coalesce(o.name, '')) LIKE ${n} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND e.email LIKE ${n} ESCAPE '\\'))`);
  }
  const tag = (p.get('tag') || '').trim();
  if (tag) { args.push(like(JSON.stringify(tag))); where.push(`c.tags LIKE ?${args.length} ESCAPE '\\'`); }
  const org = Number(p.get('org'));
  if (org) { args.push(org); where.push(`c.organization_id = ?${args.length}`); }
  const own = (p.get('owner') || '').trim().toLowerCase();
  if (own) { args.push(own); where.push(`c.owner_email = ?${args.length}`); }
  const rows = (await env.DB.prepare(CONTACT_SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY c.name COLLATE NOCASE LIMIT 1000').bind(...args).all<ContactRow>()).results;
  return rows.map(r => contactOut(r, user));
}

/** Addresses already on a live contact. One the member cannot see is reported without naming the record. */
async function claimEmails(env: Env, user: User, list: string[], self: number | null) {
  for (const e of list) {
    const hit = await env.DB.prepare(`SELECT c.id, ${VISIBLE('c')} AS visible FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE ce.email = ?2`)
      .bind(user.memberEmail, e).first<{ id: number; visible: number }>();
    if (hit && hit.id !== self) {
      throw hit.visible
        ? Object.assign(new HttpError(409, e + ' already belongs to another contact.', 'duplicate_email'), { existingId: hit.id })
        : new HttpError(409, e + ' already belongs to a contact you can’t open. Ask its owner to share it.', 'duplicate_email');
    }
  }
}

async function visibleOrg(env: Env, user: User, v: unknown): Promise<number | null> {
  if (v == null || v === '') return null;
  const id = Number(v);
  const r = await env.DB.prepare(`SELECT id FROM organizations o WHERE id = ?2 AND archived_at IS NULL AND ${VISIBLE('o')}`).bind(user.memberEmail, id).first();
  if (!r) throw new HttpError(400, 'Organization not found');
  return id;
}

interface ContactIn { name?: unknown; emails?: unknown; title?: unknown; organizationId?: unknown; website?: unknown; linkedin?: unknown; tags?: unknown; notes?: unknown; owner?: unknown; visibility?: unknown }

async function createContact(env: Env, user: User, b: ContactIn): Promise<ContactOut> {
  const name = str(b.name, 'name', 200, true);
  const list = emails(b.emails ?? []);
  await claimEmails(env, user, list, null);
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO contacts (name, name_key, title, organization_id, website, linkedin, tags, notes, owner_email, visibility, created_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`).bind(
    name, nameKey(name), str(b.title, 'title', 200), await visibleOrg(env, user, b.organizationId), url(b.website, 'website'),
    url(b.linkedin, 'linkedin', /(^|\.)linkedin\.com$/i), JSON.stringify(tags(b.tags)), str(b.notes, 'notes', MAX_NOTES),
    (await owner(env, b.owner)) || user.memberEmail, visibility(b.visibility), user.memberEmail, now
  ).run();
  const id = Number(r.meta.last_row_id);
  for (const e of list) await env.DB.prepare('INSERT INTO contact_emails (email, contact_id, created_at) VALUES (?1, ?2, ?3)').bind(e, id, now).run();
  return contactOut(await getContact(env, user, id), user);
}

async function updateContact(env: Env, user: User, id: number, b: ContactIn): Promise<ContactOut> {
  const cur = await getContact(env, user, id);
  if (cur.merged_into) throw new HttpError(409, 'This contact was merged into another one');
  const out = contactOut(cur, user);
  const set: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown) => { args.push(v); set.push(`${col} = ?${args.length}`); };
  if (b.name !== undefined) { const n = str(b.name, 'name', 200, true); put('name', n); put('name_key', nameKey(n)); }
  if (b.title !== undefined) put('title', str(b.title, 'title', 200));
  // Someone who can't see the linked organization sees none, and saving the form must not unlink it.
  const hiddenOrg = cur.organization_id != null && !cur.org_name;
  if (b.organizationId !== undefined && !(hiddenOrg && (b.organizationId === null || b.organizationId === ''))) put('organization_id', await visibleOrg(env, user, b.organizationId));
  if (b.website !== undefined) put('website', url(b.website, 'website'));
  if (b.linkedin !== undefined) put('linkedin', url(b.linkedin, 'linkedin', /(^|\.)linkedin\.com$/i));
  if (b.tags !== undefined) put('tags', JSON.stringify(tags(b.tags)));
  if (b.notes !== undefined) put('notes', str(b.notes, 'notes', MAX_NOTES));
  if (b.owner !== undefined || b.visibility !== undefined) {
    // Only the creator or the owner decide who sees a record (otherwise anyone could take a team record private).
    if (!out.canShare) throw new HttpError(403, 'Only the creator or the relationship owner can change the owner or who sees this contact');
    if (b.owner !== undefined) put('owner_email', (await owner(env, b.owner)) || user.memberEmail);
    if (b.visibility !== undefined) put('visibility', visibility(b.visibility));
  }
  const now = Date.now();
  if (b.emails !== undefined) {
    const list = emails(b.emails);
    await claimEmails(env, user, list, id);
    await env.DB.prepare('DELETE FROM contact_emails WHERE contact_id = ?1').bind(id).run();
    for (const e of list) await env.DB.prepare('INSERT INTO contact_emails (email, contact_id, created_at) VALUES (?1, ?2, ?3)').bind(e, id, now).run();
  }
  put('updated_at', now);
  args.push(id);
  await env.DB.prepare(`UPDATE contacts SET ${set.join(', ')} WHERE id = ?${args.length}`).bind(...args).run();
  return contactOut(await getContact(env, user, id), user);
}

async function archiveContact(env: Env, user: User, id: number, archived: boolean): Promise<ContactOut> {
  const cur = await getContact(env, user, id);
  if (cur.merged_into) throw new HttpError(409, 'This contact was merged into another one');
  await env.DB.prepare('UPDATE contacts SET archived_at = ?1, updated_at = ?2 WHERE id = ?3').bind(archived ? Date.now() : null, Date.now(), id).run();
  return contactOut(await getContact(env, user, id), user);
}

/** Fold `fromId` into `id`: addresses, blank fields, tags, notes and recorded events move; the other record is archived. */
async function mergeContacts(env: Env, user: User, id: number, fromId: unknown): Promise<ContactOut> {
  const src = Number(fromId);
  if (!src || src === id) throw new HttpError(400, 'Pick another contact to merge');
  const [a, b] = [await getContact(env, user, id), await getContact(env, user, src)];
  if (a.merged_into || b.merged_into) throw new HttpError(409, 'One of these contacts was already merged');
  // A private record's notes must not land in a team record (or the reverse) without someone deciding it.
  if (a.visibility !== b.visibility) throw new HttpError(409, 'Give both contacts the same visibility before merging them', 'visibility_mismatch');
  const now = Date.now();
  const notes = [a.notes, b.notes ? '— Merged from ' + b.name + ' —\n' + b.notes : ''].filter(Boolean).join('\n\n').slice(0, MAX_NOTES);
  await env.DB.batch([
    env.DB.prepare(`UPDATE contacts SET title = ?1, organization_id = ?2, website = ?3, linkedin = ?4, tags = ?5, notes = ?6, owner_email = ?7, updated_at = ?8 WHERE id = ?9`).bind(
      a.title || b.title, a.organization_id ?? b.organization_id, a.website || b.website, a.linkedin || b.linkedin,
      JSON.stringify(tags([...parseTags(a.tags), ...parseTags(b.tags)])), notes, a.owner_email || b.owner_email, now, id),
    env.DB.prepare('UPDATE contact_emails SET contact_id = ?1 WHERE contact_id = ?2').bind(id, src),
    env.DB.prepare('UPDATE relationship_events SET contact_id = ?1 WHERE contact_id = ?2').bind(id, src),
    env.DB.prepare('UPDATE contacts SET archived_at = ?1, merged_into = ?2, updated_at = ?1 WHERE id = ?3').bind(now, id, src)
  ]);
  return contactOut(await getContact(env, user, id), user);
}

/** Live, visible contacts with the same normalized name (likely the same person twice). */
async function duplicatesOf(env: Env, user: User, r: ContactRow): Promise<ContactOut[]> {
  const rows = (await env.DB.prepare(CONTACT_SELECT + ` WHERE c.name_key = ?2 AND c.id != ?3 AND c.archived_at IS NULL AND ${VISIBLE('c')} LIMIT 10`)
    .bind(user.memberEmail, r.name_key, r.id).all<ContactRow>()).results;
  return rows.map(x => contactOut(x, user));
}

/** Every group of live, visible contacts that share a normalized name. */
async function allDuplicates(env: Env, user: User): Promise<ContactOut[][]> {
  const rows = (await env.DB.prepare(CONTACT_SELECT + ` WHERE c.archived_at IS NULL AND ${VISIBLE('c')} AND c.name_key IN
    (SELECT name_key FROM contacts c WHERE c.archived_at IS NULL AND ${VISIBLE('c')} GROUP BY name_key HAVING count(*) > 1) ORDER BY c.name_key, c.id`)
    .bind(user.memberEmail).all<ContactRow>()).results;
  const groups = new Map<string, ContactOut[]>();
  for (const r of rows) groups.set(r.name_key, [...(groups.get(r.name_key) || []), contactOut(r, user)]);
  return [...groups.values()];
}

// ---------- relationship events ----------

interface EventRow { id: number; kind: string; text: string; thread_id: string; occurred_at: number; created_by: string; created_at: number }
const eventOut = (e: EventRow, user: User) => ({
  id: e.id, kind: e.kind, text: e.text, occurredAt: e.occurred_at, createdBy: e.created_by,
  // Thread ids are per mailbox: only the member who recorded it can open it.
  threadId: e.created_by === user.memberEmail ? e.thread_id : '', mine: e.created_by === user.memberEmail
});

async function events(env: Env, user: User, id: number) {
  const rows = (await env.DB.prepare('SELECT * FROM relationship_events WHERE contact_id = ?1 ORDER BY occurred_at DESC LIMIT 200').bind(id).all<EventRow>()).results;
  return rows.map(e => eventOut(e, user));
}

async function addEvent(env: Env, user: User, id: number, b: { kind?: unknown; text?: unknown; threadId?: unknown; occurredAt?: unknown }) {
  await getContact(env, user, id);
  if (!(EVENT_KINDS as readonly unknown[]).includes(b.kind)) throw new HttpError(400, 'kind must be introduction, meeting or note');
  const text = str(b.text, 'text', 1000, true);
  const threadId = str(b.threadId, 'threadId', 100);
  if (threadId && !/^[\w-]+$/.test(threadId)) throw new HttpError(400, 'threadId is not a Gmail thread id');
  const at = Number(b.occurredAt) || Date.now();
  const r = await env.DB.prepare('INSERT INTO relationship_events (contact_id, kind, text, thread_id, occurred_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, b.kind, text, threadId, at, user.memberEmail, Date.now()).run();
  const e = await env.DB.prepare('SELECT * FROM relationship_events WHERE id = ?1').bind(r.meta.last_row_id).first<EventRow>();
  return eventOut(e!, user);
}

async function deleteEvent(env: Env, user: User, id: number, eventId: number) {
  await getContact(env, user, id);
  const r = await env.DB.prepare('DELETE FROM relationship_events WHERE id = ?1 AND contact_id = ?2 AND created_by = ?3').bind(eventId, id, user.memberEmail).run();
  if (!r.meta.changes) throw new HttpError(404, 'Only the member who recorded an event can remove it');
}

// ---------- organizations ----------

interface OrgRow {
  id: number; name: string; name_key: string; domain: string; website: string; type: string; tags: string; notes: string; owner_email: string;
  visibility: 'team' | 'private'; created_by: string; created_at: number; updated_at: number; archived_at: number | null; contact_count?: number;
}

const orgOut = (r: OrgRow, user: User) => ({
  id: r.id, name: r.name, domain: r.domain, website: r.website, type: r.type, tags: parseTags(r.tags), notes: r.notes, owner: r.owner_email,
  visibility: r.visibility, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, archived: r.archived_at != null,
  contactCount: r.contact_count ?? 0, canShare: r.created_by === user.memberEmail || r.owner_email === user.memberEmail
});

const ORG_SELECT = `SELECT o.*, (SELECT count(*) FROM contacts c WHERE c.organization_id = o.id AND c.archived_at IS NULL AND ${VISIBLE('c')}) AS contact_count FROM organizations o`;

async function getOrg(env: Env, user: User, id: number): Promise<OrgRow> {
  const r = await env.DB.prepare(ORG_SELECT + ` WHERE o.id = ?2 AND ${VISIBLE('o')}`).bind(user.memberEmail, id).first<OrgRow>();
  if (!r) throw new HttpError(404, 'Organization not found');
  return r;
}

async function listOrgs(env: Env, user: User, p: URLSearchParams) {
  const where = [VISIBLE('o'), p.get('archived') === '1' ? 'o.archived_at IS NOT NULL' : 'o.archived_at IS NULL'];
  const args: unknown[] = [user.memberEmail];
  const q = (p.get('q') || '').trim().toLowerCase();
  if (q) { args.push(like(q)); where.push(`(lower(o.name) LIKE ?${args.length} ESCAPE '\\' OR o.domain LIKE ?${args.length} ESCAPE '\\')`); }
  const type = p.get('type');
  if (type) { args.push(type); where.push(`o.type = ?${args.length}`); }
  const rows = (await env.DB.prepare(ORG_SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY o.name COLLATE NOCASE LIMIT 1000').bind(...args).all<OrgRow>()).results;
  return rows.map(r => orgOut(r, user));
}

/** Refuse a second live organization with the same normalized name or domain. */
async function orgConflict(env: Env, user: User, key: string, dom: string, self: number | null) {
  const hit = await env.DB.prepare(`SELECT o.id, o.name, ${VISIBLE('o')} AS visible FROM organizations o
    WHERE o.archived_at IS NULL AND (o.name_key = ?2 OR (?3 != '' AND o.domain = ?3)) AND o.id != ?4 LIMIT 1`)
    .bind(user.memberEmail, key, dom, self ?? 0).first<{ id: number; name: string; visible: number }>();
  if (!hit) return;
  throw hit.visible
    ? Object.assign(new HttpError(409, hit.name + ' already exists.', 'duplicate_org'), { existingId: hit.id })
    : new HttpError(409, 'An organization with this name or domain already exists but is private. Ask its owner to share it.', 'duplicate_org');
}

interface OrgIn { name?: unknown; domain?: unknown; website?: unknown; type?: unknown; tags?: unknown; notes?: unknown; owner?: unknown; visibility?: unknown }

const orgType = (v: unknown) => {
  if (v == null || v === '') return 'Other';
  if (!(ORG_TYPES as readonly unknown[]).includes(v)) throw new HttpError(400, 'Unknown organization type');
  return v as string;
};

async function createOrg(env: Env, user: User, b: OrgIn) {
  const name = str(b.name, 'name', 200, true);
  const key = nameKey(name);
  if (!key) throw new HttpError(400, 'name is required');
  const dom = domain(b.domain);
  await orgConflict(env, user, key, dom, null);
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO organizations (name, name_key, domain, website, type, tags, notes, owner_email, visibility, created_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`).bind(
    name, key, dom, url(b.website, 'website'), orgType(b.type), JSON.stringify(tags(b.tags)), str(b.notes, 'notes', MAX_NOTES),
    (await owner(env, b.owner)) || user.memberEmail, visibility(b.visibility), user.memberEmail, now
  ).run();
  return orgOut(await getOrg(env, user, Number(r.meta.last_row_id)), user);
}

async function updateOrg(env: Env, user: User, id: number, b: OrgIn & { archived?: unknown }) {
  const cur = await getOrg(env, user, id);
  const set: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown) => { args.push(v); set.push(`${col} = ?${args.length}`); };
  const name = b.name !== undefined ? str(b.name, 'name', 200, true) : cur.name;
  const dom = b.domain !== undefined ? domain(b.domain) : cur.domain;
  if (b.name !== undefined || b.domain !== undefined) {
    await orgConflict(env, user, nameKey(name), dom, id);
    put('name', name); put('name_key', nameKey(name)); put('domain', dom);
  }
  if (b.website !== undefined) put('website', url(b.website, 'website'));
  if (b.type !== undefined) put('type', orgType(b.type));
  if (b.tags !== undefined) put('tags', JSON.stringify(tags(b.tags)));
  if (b.notes !== undefined) put('notes', str(b.notes, 'notes', MAX_NOTES));
  if (b.archived !== undefined) put('archived_at', b.archived ? Date.now() : null);
  if (b.owner !== undefined || b.visibility !== undefined) {
    if (!orgOut(cur, user).canShare) throw new HttpError(403, 'Only the creator or the relationship owner can change the owner or who sees this organization');
    if (b.owner !== undefined) put('owner_email', (await owner(env, b.owner)) || user.memberEmail);
    if (b.visibility !== undefined) put('visibility', visibility(b.visibility));
  }
  put('updated_at', Date.now());
  args.push(id);
  await env.DB.prepare(`UPDATE organizations SET ${set.join(', ')} WHERE id = ?${args.length}`).bind(...args).run();
  return orgOut(await getOrg(env, user, id), user);
}

// ---------- routing ----------

const conflict = (e: unknown) => {
  if (e instanceof HttpError && (e as HttpError & { existingId?: number }).existingId) {
    return json({ error: e.message, code: e.code, existingId: (e as HttpError & { existingId?: number }).existingId }, 409);
  }
  throw e;
};

export async function route(req: Request, env: Env, user: User, u: URL): Promise<Response> {
  const path = u.pathname;
  const m = req.method;
  try {
    if (path === '/api/contacts') {
      if (m === 'GET') return json({ contacts: await listContacts(env, user, u.searchParams) });
      if (m === 'POST') return json({ contact: await createContact(env, user, await readJson(req)) }, 201);
    }
    if (path === '/api/contacts/duplicates' && m === 'GET') return json({ groups: await allDuplicates(env, user) });
    let r = /^\/api\/contacts\/(\d+)(?:\/(archive|merge|events)(?:\/(\d+))?)?$/.exec(path);
    if (r) {
      const id = Number(r[1]);
      if (!r[2]) {
        if (m === 'GET') {
          const c = await getContact(env, user, id);
          return json({ contact: contactOut(c, user), events: await events(env, user, id), duplicates: c.archived_at ? [] : await duplicatesOf(env, user, c) });
        }
        if (m === 'PATCH') return json({ contact: await updateContact(env, user, id, await readJson(req)) });
      }
      if (r[2] === 'archive' && m === 'POST') return json({ contact: await archiveContact(env, user, id, (await readJson<{ archived?: unknown }>(req)).archived !== false) });
      if (r[2] === 'merge' && m === 'POST') return json({ contact: await mergeContacts(env, user, id, (await readJson<{ from?: unknown }>(req)).from) });
      if (r[2] === 'events' && !r[3] && m === 'POST') return json({ event: await addEvent(env, user, id, await readJson(req)) }, 201);
      if (r[2] === 'events' && r[3] && m === 'DELETE') { await deleteEvent(env, user, id, Number(r[3])); return json({ ok: true }); }
    }
    if (path === '/api/organizations') {
      if (m === 'GET') return json({ organizations: await listOrgs(env, user, u.searchParams), types: ORG_TYPES });
      if (m === 'POST') return json({ organization: await createOrg(env, user, await readJson(req)) }, 201);
    }
    r = /^\/api\/organizations\/(\d+)$/.exec(path);
    if (r) {
      const id = Number(r[1]);
      if (m === 'GET') {
        const o = await getOrg(env, user, id);
        return json({ organization: orgOut(o, user), contacts: await listContacts(env, user, new URLSearchParams({ org: String(id) })) });
      }
      if (m === 'PATCH') return json({ organization: await updateOrg(env, user, id, await readJson(req)) });
    }
  } catch (e) {
    return conflict(e);
  }
  throw new HttpError(404, 'Not found');
}

/** The record and its recorded events, for the assistant. 404 when the member may not see it. */
export async function contactForAssistant(env: Env, user: User, id: unknown) {
  const n = Number(id);
  if (!n) throw new HttpError(400, 'contactId is required');
  const c = contactOut(await getContact(env, user, n), user);
  return { contact: c, events: await events(env, user, n) };
}
