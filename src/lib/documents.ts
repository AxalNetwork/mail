import { Drive, type DriveFile } from './drive';
import { DriveNotConnected } from '../providers/gmail/driveAuth';

/**
 * Documents: Google Drive holds the files (in the member's own Drive, inside
 * the "Axal VC Mail" folder); the Worker holds the app's metadata. Drive is the
 * authority on what exists and what it is called: records are reconciled with it.
 */

export const DEFAULT_CATEGORIES = ['Fund Materials', 'Investor Presentations', 'Pitch Decks', 'Due Diligence', 'Investment Memoranda', 'Term Sheets', 'Legal Documents', 'Portfolio Companies', 'General Documents'];
export const ROOT_NAME = 'Axal VC Mail';
/** Files the assistant can read reliably: PDFs (natively) and plain text. */
export const ANALYZABLE = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown'];
const MAX_ANALYZE = 12 * 1024 * 1024;

export interface Category { name: string; folderId: string }
export interface Settings { googleEmail: string; rootFolderId: string; categories: Category[] }

export interface ExtractionItem { field: string; value: string; kind: 'stated' | 'calculated' | 'interpretation'; page: number | null; quote: string; quoteVerified: boolean | null }
export interface Extraction { summary: string; items: ExtractionItem[]; missing: string[]; source: 'pdf' | 'text' }

export interface DocRecord {
  id: number; driveFileId: string; name: string; mimeType: string; size: number | null; category: string; folderId: string;
  source: { mailbox: string; threadId: string; messageId: string } | null;
  createdAt: number; updatedAt: number; missing: boolean;
  extraction: { status: 'none' | 'done' | 'failed'; at: number | null; result: Extraction | { error: string } | null };
}

/** One document as shown: the Drive file (authoritative) with the app's record. */
export interface DocEntry { file: DriveFile; record: DocRecord | null; category: string }

export interface DocumentsBackend {
  settings(): Promise<Settings | null>;
  saveSettings(s: Settings): Promise<Settings>;
  list(sourceMessageId?: string): Promise<DocRecord[]>;
  record(d: Partial<Omit<DocRecord, 'id' | 'source'>> & { driveFileId: string; name: string; sourceMailbox?: string; sourceThreadId?: string; sourceMessageId?: string; sourceKey?: string }): Promise<{ document: DocRecord; existing: boolean }>;
  byKey(key: string): Promise<DocRecord | null>;
  update(id: number, p: { name?: string; category?: string; folderId?: string; missing?: boolean }): Promise<DocRecord>;
  remove(id: number): Promise<void>;
  analyze(id: number, body: { mimeType: string; data?: string; text?: string }): Promise<DocRecord>;
}

export class HttpDocuments implements DocumentsBackend {
  constructor(private token: () => Promise<string>) {}
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/documents' + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error || 'Documents request failed (' + res.status + ')');
    return j;
  }
  async settings() { return (await this.call<{ settings: Settings | null }>('/settings')).settings; }
  async saveSettings(s: Settings) { return (await this.call<{ settings: Settings }>('/settings', { method: 'PUT', body: JSON.stringify(s) })).settings; }
  async list(src?: string) { return (await this.call<{ documents: DocRecord[] }>(src ? '?sourceMessageId=' + encodeURIComponent(src) : '')).documents; }
  record(d: Parameters<DocumentsBackend['record']>[0]) { return this.call<{ document: DocRecord; existing: boolean }>('', { method: 'POST', body: JSON.stringify(d) }); }
  async byKey(key: string) { return (await this.call<{ document: DocRecord | null }>('/by-key?key=' + encodeURIComponent(key))).document; }
  async update(id: number, p: { name?: string; category?: string; folderId?: string; missing?: boolean }) { return (await this.call<{ document: DocRecord }>('/' + id, { method: 'PATCH', body: JSON.stringify(p) })).document; }
  async remove(id: number) { await this.call('/' + id, { method: 'DELETE' }); }
  async analyze(id: number, body: { mimeType: string; data?: string; text?: string }) { return (await this.call<{ document: DocRecord }>('/' + id + '/analyze', { method: 'POST', body: JSON.stringify(body) })).document; }
}

const keyOf = (name: string) => 'cat:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface AttachmentSource { mailbox: string; threadId: string; messageId: string; name: string; size: number; mime: string; blob: () => Promise<Blob> }

export class Documents {
  private cached: Settings | null = null;
  constructor(readonly drive: Drive, private backend: DocumentsBackend, private auth: { connect(): Promise<string>; disconnect(): void; connected: boolean }, private me: () => Promise<string>) {}

  get connected() { return this.auth.connected; }

  async settings(): Promise<Settings | null> {
    if (!this.cached) this.cached = await this.backend.settings();
    return this.cached;
  }

  /**
   * Ask for Drive access, check it is the signed-in account's Drive, then find or
   * create the app's folders (found again, never duplicated, on a second connect).
   */
  async connect(): Promise<Settings> {
    await this.auth.connect();
    const [driveEmail, email] = await Promise.all([this.drive.account(), this.me()]);
    if (driveEmail !== email.toLowerCase()) {
      this.auth.disconnect();
      throw new DriveNotConnected('That was the Drive of ' + driveEmail + '. Connect the Drive of ' + email + ', the account you are signed in with.');
    }
    const prev = await this.backend.settings().catch(() => null);
    const root = await this.drive.folder(ROOT_NAME, 'root');
    const names = prev?.categories.length ? prev.categories.map(c => c.name) : DEFAULT_CATEGORIES;
    const categories: Category[] = [];
    for (const name of names) categories.push({ name, folderId: (await this.drive.folder(name, keyOf(name), root.id)).id });
    this.cached = await this.backend.saveSettings({ googleEmail: driveEmail, rootFolderId: root.id, categories });
    return this.cached;
  }

  disconnect() { this.auth.disconnect(); }

  async addCategory(name: string): Promise<Settings> {
    const s = await this.need();
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Name the folder.');
    if (s.categories.some(c => c.name.toLowerCase() === clean.toLowerCase())) throw new Error(clean + ' already exists.');
    const f = await this.drive.folder(clean, keyOf(clean), s.rootFolderId);
    this.cached = await this.backend.saveSettings({ ...s, categories: [...s.categories, { name: clean, folderId: f.id }] });
    return this.cached;
  }

  private async need(): Promise<Settings> {
    const s = await this.settings();
    if (!s) throw new DriveNotConnected();
    return s;
  }

  /**
   * Everything in the app's folders, as Drive has it now, joined with the app's
   * records. Records whose file is gone from Drive are marked missing; files
   * that are new (e.g. saved before a record could be written) get a record.
   */
  async list(): Promise<{ entries: DocEntry[]; missing: DocRecord[] }> {
    const s = await this.need();
    const folders = [s.rootFolderId, ...s.categories.map(c => c.folderId)];
    const [files, records] = await Promise.all([this.drive.filesIn(folders), this.backend.list()]);
    const byFile = new Map(records.map(r => [r.driveFileId, r]));
    const catOf = (f: DriveFile) => s.categories.find(c => f.parents?.includes(c.folderId))?.name || '';
    const entries: DocEntry[] = [];
    for (const f of files) {
      let r = byFile.get(f.id) || null;
      const category = catOf(f);
      if (!r) r = (await this.backend.record({ driveFileId: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || 0, category, folderId: f.parents?.[0] || '' })).document;
      else if (r.name !== f.name || r.category !== category || r.missing) r = await this.backend.update(r.id, { name: f.name, category, folderId: f.parents?.[0] || '', missing: false });
      entries.push({ file: f, record: r, category });
    }
    const seen = new Set(files.map(f => f.id));
    const gone = records.filter(r => !seen.has(r.driveFileId));
    // Not in the app's folders any more: check each one (moved elsewhere in Drive, trashed, or deleted).
    const missing: DocRecord[] = [];
    for (const r of gone) {
      const f = await this.drive.get(r.driveFileId);
      if (f) entries.push({ file: f, record: r, category: '' });
      else missing.push(r.missing ? r : await this.backend.update(r.id, { missing: true }));
    }
    return { entries, missing };
  }

  async upload(file: Blob & { name?: string }, name: string, category: string): Promise<DocEntry> {
    const s = await this.need();
    const folder = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    const f = await this.drive.upload(file, name, folder);
    const { document } = await this.backend.record({ driveFileId: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || file.size, category, folderId: folder });
    return { file: f, record: document, category };
  }

  /**
   * Put an email attachment's bytes in Drive. Saving the same attachment again
   * returns the copy already there instead of uploading twice.
   */
  async saveAttachment(a: AttachmentSource, category: string): Promise<{ record: DocRecord; existing: boolean }> {
    const s = await this.need();
    const key = [a.mailbox, a.messageId, a.name, a.size].join('|').toLowerCase();
    const known = await this.backend.byKey(key);
    if (known) {
      if (await this.drive.get(known.driveFileId)) return { record: known, existing: true };
      await this.backend.remove(known.id); // its file is gone from Drive: save it again
    }
    const already = await this.drive.bySource(key);
    const folder = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    const f = already || await this.drive.upload(await a.blob(), a.name, folder, { axalSource: key.slice(0, 120) });
    const r = await this.backend.record({
      driveFileId: f.id, name: f.name, mimeType: f.mimeType || a.mime, size: Number(f.size) || a.size, category, folderId: folder,
      sourceMailbox: a.mailbox, sourceThreadId: a.threadId, sourceMessageId: a.messageId, sourceKey: key
    });
    return { record: r.document, existing: r.existing || !!already };
  }

  savedFrom(messageId: string) { return this.backend.list(messageId); }

  async rename(e: DocEntry, name: string) {
    const f = await this.drive.rename(e.file.id, name.trim());
    if (e.record) await this.backend.update(e.record.id, { name: f.name });
  }

  async move(e: DocEntry, category: string) {
    const s = await this.need();
    const to = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    const f = await this.drive.move(e.file.id, e.file.parents || [], to);
    if (e.record) await this.backend.update(e.record.id, { category, folderId: f.parents?.[0] || to });
  }

  /** To Drive's trash (recoverable there), then off the list. */
  async remove(e: DocEntry) {
    await this.drive.trash(e.file.id);
    if (e.record) await this.backend.remove(e.record.id);
  }

  forget(r: DocRecord) { return this.backend.remove(r.id); }

  download(e: DocEntry) { return this.drive.download(e.file.id); }

  /** Read the file from Drive with the member's access and ask the assistant. */
  async analyze(e: DocEntry): Promise<DocRecord> {
    if (!e.record) throw new Error('This file has no record yet. Refresh and try again.');
    const mime = e.file.mimeType;
    if (!ANALYZABLE.includes(mime)) throw new Error('AI extraction supports PDF and plain text (.txt, .csv, .md) files.');
    if (Number(e.file.size) > MAX_ANALYZE) throw new Error('Documents up to 12 MB can be analyzed.');
    const blob = await this.drive.download(e.file.id);
    return this.backend.analyze(e.record.id, mime === 'application/pdf' ? { mimeType: mime, data: await base64(blob) } : { mimeType: mime, text: await blob.text() });
  }
}
