import type { User } from './auth';
import { HttpError } from './http';

export interface Note {
  id: number;
  text: string;
  author: string;
  createdAt: number;
}

const KEY_RE = /^<[^<>\s]{3,500}>$/;

function checkKey(key: string | null): string {
  if (!key || !KEY_RE.test(key)) throw new HttpError(400, 'key must be a Message-ID like <abc@example.com>');
  return key;
}

export async function listNotes(db: D1Database, key: string | null): Promise<Note[]> {
  const k = checkKey(key);
  const r = await db
    .prepare('SELECT id, text, author_email, author_name, created_at FROM notes WHERE thread_key = ?1 ORDER BY created_at, id LIMIT 200')
    .bind(k)
    .all<{ id: number; text: string; author_email: string; author_name: string; created_at: number }>();
  return (r.results || []).map(n => ({ id: n.id, text: n.text, author: n.author_name || n.author_email, createdAt: n.created_at }));
}

export async function addNote(db: D1Database, user: User, body: { key?: string; text?: string; authorName?: string }): Promise<Note> {
  const k = checkKey(body.key ?? null);
  const text = (body.text || '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  if (text.length > 5000) throw new HttpError(413, 'Notes are limited to 5,000 characters');
  const name = (body.authorName || '').trim().slice(0, 200);
  const now = Date.now();
  const r = await db
    .prepare('INSERT INTO notes (thread_key, author_email, author_name, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(k, user.memberEmail, name || user.name, text, now)
    .run();
  return { id: Number(r.meta.last_row_id), text, author: name || user.name || user.memberEmail, createdAt: now };
}
