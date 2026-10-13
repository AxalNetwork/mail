import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';
import { analyzeDocument, type Extraction } from './assistant';

/**
 * Documents: the files are in each member's own Google Drive, inside the
 * "Axal VC Mail" folder this app created (scope drive.file, so the app sees
 * only files it created). The browser talks to Drive with the member's own
 * token; the Worker keeps the app's metadata (category, the email a file came
 * from, AI extraction) per member, and never file contents. Every route is the
 * member's own data only.
 */

const ID_RE = /^[\w-]{10,200}$/;
const MAX_ANALYZE_BYTES = 12 * 1024 * 1024;
export const ANALYZABLE = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown'];

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const driveId = (v: unknown, field: string) => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HttpError(400, field + ' is not a Google Drive id');
  return v;
};

interface Row {
  id: number; drive_file_id: string; name: string; mime_type: string; size: number | null; category: string; folder_id: string;
  source_mailbox: string; source_thread_id: string; source_message_id: string; source_key: string | null; created_at: number; updated_at: number;
  missing_at: number | null; extraction_status: 'none' | 'done' | 'failed'; extraction: string | null; extracted_at: number | null;
}

const out = (r: Row) => ({
  id: r.id, driveFileId: r.drive_file_id, name: r.name, mimeType: r.mime_type, size: r.size, category: r.category, folderId: r.folder_id,
  source: r.source_message_id ? { mailbox: r.source_mailbox, threadId: r.source_thread_id, messageId: r.source_message_id } : null,
  createdAt: r.created_at, updatedAt: r.updated_at, missing: r.missing_at != null,
  extraction: { status: r.extraction_status, at: r.extracted_at, result: r.extraction ? JSON.parse(r.extraction) as Extraction | { error: string } : null }
});

async function mine(env: Env, user: User, id: number): Promise<Row> {
  const r = await env.DB.prepare('SELECT * FROM documents WHERE id = ?1 AND member_email = ?2').bind(id, user.memberEmail).first<Row>();
  if (!r) throw new HttpError(404, 'Document not found');
  return r;
}

// ---------- settings ----------

async function getSettings(env: Env, user: User) {
  const r = await env.DB.prepare('SELECT * FROM drive_settings WHERE member_email = ?1').bind(user.memberEmail)
    .first<{ google_email: string; root_folder_id: string; categories: string; updated_at: number }>();
  return r ? { googleEmail: r.google_email, rootFolderId: r.root_folder_id, categories: JSON.parse(r.categories) as { name: string; folderId: string }[], updatedAt: r.updated_at } : null;
}

async function putSettings(env: Env, user: User, b: { googleEmail?: unknown; rootFolderId?: unknown; categories?: unknown }) {
  const google = str(b.googleEmail, 254).toLowerCase();
  // Documents go in the Drive of the account signed in to the app, never another one picked in the consent window.
  if (google !== user.email.toLowerCase()) throw new HttpError(400, 'Connect the Google Drive of ' + user.email + ', the account you are signed in with.', 'drive_account_mismatch');
  const root = driveId(b.rootFolderId, 'rootFolderId');
  if (!Array.isArray(b.categories) || b.categories.length > 30) throw new HttpError(400, 'categories must be a list of up to 30 folders');
  const seen = new Set<string>();
  const categories = b.categories.map((c: Record<string, unknown>) => {
    const name = str(c?.name, 80);
    if (!name || seen.has(name.toLowerCase())) throw new HttpError(400, 'Each category needs a distinct name');
    seen.add(name.toLowerCase());
    return { name, folderId: driveId(c.folderId, 'folderId') };
  });
  await env.DB.prepare(`INSERT INTO drive_settings (member_email, google_email, root_folder_id, categories, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (member_email) DO UPDATE SET google_email = excluded.google_email, root_folder_id = excluded.root_folder_id, categories = excluded.categories, updated_at = excluded.updated_at`)
    .bind(user.memberEmail, google, root, JSON.stringify(categories), Date.now()).run();
  return getSettings(env, user);
}

// ---------- records ----------

interface DocIn {
  driveFileId?: unknown; name?: unknown; mimeType?: unknown; size?: unknown; category?: unknown; folderId?: unknown;
  sourceMailbox?: unknown; sourceThreadId?: unknown; sourceMessageId?: unknown; sourceKey?: unknown;
}

/** Record a file the browser just put in Drive. Saving the same attachment twice returns the first record. */
async function record(env: Env, user: User, b: DocIn): Promise<{ document: ReturnType<typeof out>; existing: boolean }> {
  const fileId = driveId(b.driveFileId, 'driveFileId');
  const name = str(b.name, 255);
  if (!name) throw new HttpError(400, 'name is required');
  const key = str(b.sourceKey, 200) || null;
  if (key) {
    const hit = await env.DB.prepare('SELECT * FROM documents WHERE member_email = ?1 AND source_key = ?2').bind(user.memberEmail, key).first<Row>();
    if (hit && hit.drive_file_id !== fileId) return { document: out(hit), existing: true };
  }
  const now = Date.now();
  const size = Number(b.size);
  await env.DB.prepare(`INSERT INTO documents (member_email, drive_file_id, name, mime_type, size, category, folder_id, source_mailbox, source_thread_id, source_message_id, source_key, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    ON CONFLICT (member_email, drive_file_id) DO UPDATE SET name = excluded.name, mime_type = excluded.mime_type, size = excluded.size,
      category = excluded.category, folder_id = excluded.folder_id, missing_at = NULL, updated_at = excluded.updated_at`).bind(
    user.memberEmail, fileId, name, str(b.mimeType, 120), Number.isFinite(size) && size >= 0 ? size : null, str(b.category, 80),
    b.folderId ? driveId(b.folderId, 'folderId') : '', str(b.sourceMailbox, 254).toLowerCase(), str(b.sourceThreadId, 100), str(b.sourceMessageId, 300), key, now
  ).run();
  const r = await env.DB.prepare('SELECT * FROM documents WHERE member_email = ?1 AND drive_file_id = ?2').bind(user.memberEmail, fileId).first<Row>();
  return { document: out(r!), existing: false };
}

async function update(env: Env, user: User, id: number, b: { name?: unknown; category?: unknown; folderId?: unknown; missing?: unknown }) {
  const cur = await mine(env, user, id);
  const name = b.name !== undefined ? str(b.name, 255) : cur.name;
  if (!name) throw new HttpError(400, 'name is required');
  await env.DB.prepare('UPDATE documents SET name = ?1, category = ?2, folder_id = ?3, missing_at = ?4, updated_at = ?5 WHERE id = ?6').bind(
    name, b.category !== undefined ? str(b.category, 80) : cur.category,
    b.folderId !== undefined ? (b.folderId ? driveId(b.folderId, 'folderId') : '') : cur.folder_id,
    b.missing === undefined ? cur.missing_at : b.missing ? cur.missing_at ?? Date.now() : null, Date.now(), id
  ).run();
  return out(await mine(env, user, id));
}

/** The request body for analysis can be larger than ordinary JSON, up to the extraction limit. */
async function readAnalyzeBody(req: Request): Promise<{ mimeType?: unknown; data?: unknown; text?: unknown }> {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_ANALYZE_BYTES * 1.4) throw new HttpError(413, 'Documents up to 12 MB can be analyzed.');
  const text = await req.text();
  if (text.length > MAX_ANALYZE_BYTES * 1.4) throw new HttpError(413, 'Documents up to 12 MB can be analyzed.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Malformed JSON'); }
}

async function analyze(env: Env, user: User, id: number, req: Request) {
  const doc = await mine(env, user, id);
  const b = await readAnalyzeBody(req);
  const mime = str(b.mimeType, 120) || doc.mime_type;
  if (!ANALYZABLE.includes(mime)) throw new HttpError(415, 'AI extraction supports PDF and plain text (.txt, .csv, .md) files.', 'unsupported_type');
  const input = mime === 'application/pdf'
    ? { kind: 'pdf' as const, data: typeof b.data === 'string' ? b.data : '' }
    : { kind: 'text' as const, text: typeof b.text === 'string' ? b.text : '' };
  if (input.kind === 'pdf' && !/^[A-Za-z0-9+/=]+$/.test(input.data.slice(0, 1000))) throw new HttpError(400, 'data must be the file, base64-encoded');
  if ((input.kind === 'pdf' ? input.data : input.text).length === 0) throw new HttpError(400, 'The document is empty');
  try {
    const result = await analyzeDocument(env, user, { name: doc.name, ...input });
    await env.DB.prepare("UPDATE documents SET extraction_status = 'done', extraction = ?1, extracted_at = ?2 WHERE id = ?3").bind(JSON.stringify(result), Date.now(), id).run();
  } catch (e) {
    // Keep the failure on the record so the page can say what happened, then report it.
    const msg = e instanceof HttpError ? e.message : 'The analysis failed.';
    await env.DB.prepare("UPDATE documents SET extraction_status = 'failed', extraction = ?1, extracted_at = ?2 WHERE id = ?3").bind(JSON.stringify({ error: msg }), Date.now(), id).run();
    throw e;
  }
  return out(await mine(env, user, id));
}

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  const path = url.pathname;
  const m = req.method;
  if (path === '/api/documents/settings') {
    if (m === 'GET') return json({ settings: await getSettings(env, user) });
    if (m === 'PUT') return json({ settings: await putSettings(env, user, await readJson(req)) });
  }
  if (path === '/api/documents') {
    if (m === 'GET') {
      const src = url.searchParams.get('sourceMessageId');
      const rows = await (src
        ? env.DB.prepare('SELECT * FROM documents WHERE member_email = ?1 AND source_message_id = ?2 ORDER BY created_at DESC').bind(user.memberEmail, src)
        : env.DB.prepare('SELECT * FROM documents WHERE member_email = ?1 ORDER BY created_at DESC LIMIT 2000').bind(user.memberEmail)).all<Row>();
      return json({ documents: rows.results.map(out) });
    }
    if (m === 'POST') { const r = await record(env, user, await readJson(req)); return json(r, r.existing ? 200 : 201); }
  }
  if (path === '/api/documents/by-key' && m === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM documents WHERE member_email = ?1 AND source_key = ?2').bind(user.memberEmail, url.searchParams.get('key') || '').first<Row>();
    return json({ document: r ? out(r) : null });
  }
  const one = /^\/api\/documents\/(\d+)(\/analyze)?$/.exec(path);
  if (one) {
    const id = Number(one[1]);
    if (one[2] && m === 'POST') return json({ document: await analyze(env, user, id, req) });
    if (!one[2] && m === 'GET') return json({ document: out(await mine(env, user, id)) });
    if (!one[2] && m === 'PATCH') return json({ document: await update(env, user, id, await readJson(req)) });
    if (!one[2] && m === 'DELETE') {
      await mine(env, user, id);
      await env.DB.prepare('DELETE FROM documents WHERE id = ?1 AND member_email = ?2').bind(id, user.memberEmail).run();
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Not found');
}
