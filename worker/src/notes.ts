import type { Env } from './env';
import { allowedDomains, superAdmins, type User } from './auth';
import { HttpError } from './http';

/**
 * Internal collaboration on conversations: notes and comments only Axal VC
 * members see, @mentions, and an activity log. A conversation is identified
 * by its first message's RFC Message-ID, which is the same in every member's
 * mailbox. None of this is ever written to Gmail or included in an email.
 */

export type NoteKind = 'note' | 'comment';

export interface Note {
  id: number;
  key: string;
  kind: NoteKind;
  text: string;
  author: string;
  authorEmail: string;
  subject: string;
  createdAt: number;
  updatedAt: number | null;
  mentions: { email: string; name: string }[];
  /** The signed-in member wrote it. */
  mine: boolean;
  /** The signed-in member may edit it (author) / delete it (author or admin). */
  canEdit: boolean;
  canDelete: boolean;
}

export interface Activity { action: string; actor: string; target: string | null; at: number }

const KEY_RE = /^<[^<>\s]{3,500}>$/;
const MAX_TEXT = 5000;

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new HttpError(400, 'key must be a Message-ID like <abc@example.com>');
  return key;
}

function checkText(v: unknown): string {
  const text = typeof v === 'string' ? v.trim() : '';
  if (!text) throw new HttpError(400, 'text is required');
  if (text.length > MAX_TEXT) throw new HttpError(413, 'Notes are limited to 5,000 characters');
  return text;
}

interface NoteRow {
  id: number; thread_key: string; kind: NoteKind; text: string; author_email: string; author_name: string; subject: string;
  created_at: number; updated_at: number | null;
}

const isAdmin = (u: User) => u.role === 'admin' || u.role === 'super_admin';

/** Members someone can mention: everyone with a member row or on the super admin list, minus suspended. */
export async function mentionable(env: Env): Promise<{ email: string; name: string }[]> {
  const rows = (await env.DB.prepare("SELECT email, name FROM members WHERE status = 'active' ORDER BY name, email").all<{ email: string; name: string }>()).results;
  const out = new Map(rows.map(r => [r.email, r.name || r.email.split('@')[0]]));
  for (const e of superAdmins(env)) if (!out.has(e)) out.set(e, e.split('@')[0]);
  // Authors of internal notes are members too, even without a row.
  const authors = (await env.DB.prepare('SELECT DISTINCT author_email, author_name FROM notes WHERE deleted_at IS NULL').all<{ author_email: string; author_name: string }>()).results;
  for (const a of authors) if (!out.has(a.author_email)) out.set(a.author_email, a.author_name || a.author_email.split('@')[0]);
  const suspended = new Set((await env.DB.prepare("SELECT email FROM members WHERE status = 'suspended'").all<{ email: string }>()).results.map(r => r.email));
  return [...out].filter(([e]) => !suspended.has(e)).map(([email, name]) => ({ email, name }));
}

/** Mentions must name members; anything else is dropped rather than stored. */
async function validMentions(env: Env, v: unknown, author: string): Promise<string[]> {
  if (!Array.isArray(v)) return [];
  const wanted = [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim().toLowerCase()))].filter(e => e !== author).slice(0, 20);
  if (!wanted.length) return [];
  const known = new Set((await mentionable(env)).map(m => m.email));
  const domains = allowedDomains(env);
  return wanted.filter(e => known.has(e) || domains.includes(e.split('@')[1]));
}

async function names(env: Env, emails: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of emails) {
    const r = await env.DB.prepare('SELECT name FROM members WHERE email = ?1').bind(e).first<{ name: string }>();
    m.set(e, r?.name || e.split('@')[0]);
  }
  return m;
}

async function toNotes(env: Env, user: User, rows: NoteRow[]): Promise<Note[]> {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ments = (await env.DB.prepare('SELECT note_id, member_email FROM note_mentions WHERE note_id IN (' + ids.map((_, i) => '?' + (i + 1)).join(',') + ')')
    .bind(...ids).all<{ note_id: number; member_email: string }>()).results;
  const nm = await names(env, [...new Set(ments.map(m => m.member_email))]);
  return rows.map(r => ({
    id: r.id, key: r.thread_key, kind: r.kind, text: r.text, subject: r.subject,
    author: r.author_name || r.author_email, authorEmail: r.author_email,
    createdAt: r.created_at, updatedAt: r.updated_at,
    mentions: ments.filter(m => m.note_id === r.id).map(m => ({ email: m.member_email, name: nm.get(m.member_email) || m.member_email })),
    mine: r.author_email === user.memberEmail,
    canEdit: r.author_email === user.memberEmail,
    canDelete: r.author_email === user.memberEmail || isAdmin(user)
  }));
}

const SELECT = 'SELECT id, thread_key, kind, text, author_email, author_name, subject, created_at, updated_at FROM notes';

async function log(env: Env, key: string, noteId: number | null, actor: string, action: 'created' | 'edited' | 'deleted' | 'mentioned', target: string | null = null) {
  await env.DB.prepare('INSERT INTO note_activity (thread_key, note_id, actor_email, action, target_email, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(key, noteId, actor, action, target, Date.now()).run();
}

async function addMentions(env: Env, key: string, noteId: number, actor: string, emails: string[]) {
  for (const e of emails) {
    const r = await env.DB.prepare('INSERT INTO note_mentions (note_id, member_email, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING').bind(noteId, e, Date.now()).run();
    if (r.meta.changes) await log(env, key, noteId, actor, 'mentioned', e);
  }
}

async function getRow(env: Env, id: number): Promise<NoteRow> {
  const r = await env.DB.prepare(SELECT + ' WHERE id = ?1 AND deleted_at IS NULL').bind(id).first<NoteRow>();
  if (!r) throw new HttpError(404, 'No such note');
  return r;
}

export async function listNotes(env: Env, user: User, key: string | null): Promise<Note[]> {
  const k = checkKey(key);
  const rows = (await env.DB.prepare(SELECT + ' WHERE thread_key = ?1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 200').bind(k).all<NoteRow>()).results;
  return toNotes(env, user, rows);
}

export async function addNote(env: Env, user: User, body: { key?: unknown; text?: unknown; authorName?: unknown; kind?: unknown; subject?: unknown; mentions?: unknown }): Promise<Note> {
  const k = checkKey(body.key);
  const text = checkText(body.text);
  const kind: NoteKind = body.kind === 'comment' ? 'comment' : 'note';
  const name = (typeof body.authorName === 'string' ? body.authorName.trim().slice(0, 200) : '') || user.name || user.memberEmail;
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 300) : '';
  const r = await env.DB.prepare('INSERT INTO notes (thread_key, author_email, author_name, text, kind, subject, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(k, user.memberEmail, name, text, kind, subject, Date.now()).run();
  const id = Number(r.meta.last_row_id);
  // Fill in the subject for earlier notes on this conversation that had none.
  if (subject) await env.DB.prepare("UPDATE notes SET subject = ?2 WHERE thread_key = ?1 AND subject = ''").bind(k, subject).run();
  await log(env, k, id, user.memberEmail, 'created');
  await addMentions(env, k, id, user.memberEmail, await validMentions(env, body.mentions, user.memberEmail));
  return (await toNotes(env, user, [await getRow(env, id)]))[0];
}

export async function editNote(env: Env, user: User, id: number, body: { text?: unknown; mentions?: unknown }): Promise<Note> {
  const row = await getRow(env, id);
  if (row.author_email !== user.memberEmail) throw new HttpError(403, 'Only the author can edit a note.');
  const text = checkText(body.text);
  await env.DB.prepare('UPDATE notes SET text = ?2, updated_at = ?3 WHERE id = ?1').bind(id, text, Date.now()).run();
  await log(env, row.thread_key, id, user.memberEmail, 'edited');
  await addMentions(env, row.thread_key, id, user.memberEmail, await validMentions(env, body.mentions, user.memberEmail));
  return (await toNotes(env, user, [await getRow(env, id)]))[0];
}

/** Soft delete: the text is wiped, the activity log keeps who deleted it and when. */
export async function deleteNote(env: Env, user: User, id: number): Promise<void> {
  const row = await getRow(env, id);
  if (row.author_email !== user.memberEmail && !isAdmin(user)) throw new HttpError(403, 'Only the author or an admin can delete a note.');
  await env.DB.prepare("UPDATE notes SET text = '', deleted_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
  await env.DB.prepare('DELETE FROM note_mentions WHERE note_id = ?1').bind(id).run();
  await log(env, row.thread_key, id, user.memberEmail, 'deleted');
}

export async function activity(env: Env, key: string | null): Promise<Activity[]> {
  const k = checkKey(key);
  const rows = (await env.DB.prepare('SELECT action, actor_email, target_email, created_at FROM note_activity WHERE thread_key = ?1 ORDER BY created_at, id LIMIT 200')
    .bind(k).all<{ action: string; actor_email: string; target_email: string | null; created_at: number }>()).results;
  const nm = await names(env, [...new Set(rows.flatMap(r => [r.actor_email, ...(r.target_email ? [r.target_email] : [])]))]);
  return rows.map(r => ({ action: r.action, actor: nm.get(r.actor_email) || r.actor_email, target: r.target_email ? nm.get(r.target_email) || r.target_email : null, at: r.created_at }));
}

/** The Internal workspace: mentions of me (unread first) and the team's recent discussion. */
export async function inbox(env: Env, user: User) {
  const mentionRows = (await env.DB.prepare(`SELECT n.id, n.thread_key, n.kind, n.text, n.author_email, n.author_name, n.subject, n.created_at, n.updated_at, m.read_at
    FROM note_mentions m JOIN notes n ON n.id = m.note_id WHERE m.member_email = ?1 AND n.deleted_at IS NULL
    ORDER BY (m.read_at IS NOT NULL), n.created_at DESC LIMIT 50`).bind(user.memberEmail).all<NoteRow & { read_at: number | null }>()).results;
  const recentRows = (await env.DB.prepare(SELECT + ' WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50').all<NoteRow>()).results;
  const mentions = await toNotes(env, user, mentionRows);
  return {
    mentions: mentions.map((n, i) => ({ ...n, read: mentionRows[i].read_at != null })),
    recent: await toNotes(env, user, recentRows),
    unread: mentionRows.filter(r => r.read_at == null).length
  };
}

export async function markRead(env: Env, user: User, body: { ids?: unknown }) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200) : null;
  if (ids && !ids.length) return;
  if (ids) {
    await env.DB.prepare('UPDATE note_mentions SET read_at = ?1 WHERE member_email = ?2 AND read_at IS NULL AND note_id IN (' + ids.map((_, i) => '?' + (i + 3)).join(',') + ')')
      .bind(Date.now(), user.memberEmail, ...ids).run();
  } else {
    await env.DB.prepare('UPDATE note_mentions SET read_at = ?1 WHERE member_email = ?2 AND read_at IS NULL').bind(Date.now(), user.memberEmail).run();
  }
}
