import { Drive, type DriveFile } from './drive';
import { DriveNotConnected } from '../providers/gmail/driveAuth';

/**
 * Documents: everything lives in the member's own Google Drive, inside the
 * "Axal VC Mail" folder this app created (scope drive.file: the app sees only
 * files it created). No database is involved:
 * - categories are the folders inside "Axal VC Mail";
 * - where a file came from (mailbox, conversation, message) is kept on the file
 *   itself, as private app properties only this app reads;
 * - AI extraction results are JSON files in "Axal VC Mail/AI extractions".
 * The Worker only reads a file the browser sends it for extraction, and stores nothing.
 */

export const DEFAULT_CATEGORIES = ['One-pagers', 'Fund Materials', 'Investor Presentations', 'Pitch Decks', 'Due Diligence', 'Investment Memoranda', 'Term Sheets', 'Legal Documents', 'Portfolio Companies', 'General Documents'];
export const ROOT_NAME = 'Axal VC Mail';
const EXTRACTIONS_NAME = 'AI extractions';
/** Files the assistant can read reliably: PDFs (natively) and plain text. */
export const ANALYZABLE = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown'];
const MAX_ANALYZE = 12 * 1024 * 1024;

export interface Category { name: string; folderId: string }
export interface Settings { googleEmail: string; rootFolderId: string; categories: Category[] }

export interface ExtractionItem { field: string; value: string; kind: 'stated' | 'calculated' | 'interpretation'; page: number | null; quote: string; quoteVerified: boolean | null }
export interface Extraction { summary: string; items: ExtractionItem[]; missing: string[]; source: 'pdf' | 'text' }

/** What the app knows about a file, read from the file itself (id is the Drive file id). */
export interface DocRecord {
  id: string; driveFileId: string; name: string; mimeType: string; size: number | null; category: string; folderId: string;
  source: { mailbox: string; threadId: string; messageId: string } | null;
  createdAt: number; updatedAt: number; missing: boolean;
  extraction: { status: 'none' | 'done' | 'failed'; at: number | null; result: Extraction | { error: string } | null };
}

/** One document as shown: the Drive file with what the app knows about it. */
export interface DocEntry { file: DriveFile; record: DocRecord | null; category: string }

/** Reads a document with the assistant (POST /api/documents/extract); nothing is stored on the server. */
export type Extractor = (body: { mimeType: string; name: string; data?: string; text?: string }) => Promise<Extraction>;

export function httpExtractor(token: () => Promise<string>): Extractor {
  return async body => {
    const res = await fetch('/api/documents/extract', { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { extraction?: Extraction; error?: string };
    if (!res.ok || !j.extraction) throw new Error(j.error || 'AI extraction failed (' + res.status + ')');
    return j.extraction;
  };
}

const keyOf = (name: string) => 'cat:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** App properties hold at most 124 bytes per key and value, so long ids are stored hashed (or cut). */
async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.toLowerCase()));
  return [...new Uint8Array(d)].slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface AttachmentSource { mailbox: string; threadId: string; messageId: string; name: string; size: number; mime: string; blob: () => Promise<Blob> }

export class Documents {
  private cached: Settings | null = null;
  private extractionsFolder: string | null = null;
  constructor(readonly drive: Drive, private auth: { connect(): Promise<string>; disconnect(): void; connected: boolean }, private me: () => Promise<string>, private extract?: Extractor) {}

  get connected() { return this.auth.connected; }

  /** The app's folders in Drive, or null before the first connection. */
  async settings(): Promise<Settings | null> {
    if (this.cached) return this.cached;
    const root = await this.drive.findFolder('root');
    if (!root) return null;
    const [googleEmail, folders] = await Promise.all([this.drive.account(), this.drive.foldersIn(root.id)]);
    this.cached = {
      googleEmail, rootFolderId: root.id,
      categories: folders.filter(f => f.appProperties?.axal !== 'extractions').map(f => ({ name: f.name, folderId: f.id })).sort((a, b) => a.name.localeCompare(b.name))
    };
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
    this.cached = null;
    const prev = await this.settings();
    const root = await this.drive.folder(ROOT_NAME, 'root');
    if (!prev?.categories.length) for (const name of DEFAULT_CATEGORIES) await this.drive.folder(name, keyOf(name), root.id);
    this.cached = null;
    return (await this.settings())!;
  }

  disconnect() { this.cached = null; this.auth.disconnect(); }

  async addCategory(name: string): Promise<Settings> {
    const s = await this.need();
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Name the folder.');
    if (s.categories.some(c => c.name.toLowerCase() === clean.toLowerCase())) throw new Error(clean + ' already exists.');
    await this.drive.folder(clean, keyOf(clean), s.rootFolderId);
    this.cached = null;
    return (await this.settings())!;
  }

  private async need(): Promise<Settings> {
    const s = await this.settings();
    if (!s) throw new DriveNotConnected();
    return s;
  }

  private categoryOf(s: Settings, f: DriveFile) { return s.categories.find(c => f.parents?.includes(c.folderId))?.name || ''; }

  private recordOf(s: Settings, f: DriveFile, extraction?: { file: DriveFile; result: Extraction | { error: string } | null }): DocRecord {
    const p = f.appProperties || {};
    return {
      id: f.id, driveFileId: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : null, category: this.categoryOf(s, f), folderId: f.parents?.[0] || '',
      source: p.axalThread ? { mailbox: p.axalMailbox || '', threadId: p.axalThread, messageId: p.axalMsg || '' } : null,
      createdAt: Date.parse(f.createdTime) || 0, updatedAt: Date.parse(f.modifiedTime) || 0, missing: false,
      extraction: extraction
        ? { status: extraction.result && 'error' in extraction.result ? 'failed' : 'done', at: Date.parse(extraction.file.modifiedTime || extraction.file.createdTime) || null, result: extraction.result }
        : { status: 'none', at: null, result: null }
    };
  }

  private async extractions(s: Settings): Promise<Map<string, { file: DriveFile; result: Extraction | { error: string } | null }>> {
    const folder = await this.drive.findFolder('extractions', s.rootFolderId);
    const out = new Map<string, { file: DriveFile; result: Extraction | { error: string } | null }>();
    if (!folder) return out;
    this.extractionsFolder = folder.id;
    const files = await this.drive.filesIn([folder.id]);
    await Promise.all(files.map(async f => {
      const of = f.appProperties?.axalExtractionFor;
      if (!of) return;
      const result = await this.drive.download(f.id).then(b => b.text()).then(t => JSON.parse(t) as Extraction | { error: string }).catch(() => null);
      out.set(of, { file: f, result });
    }));
    return out;
  }

  /** Everything in the app's folders, as Drive has it now. */
  async list(): Promise<{ entries: DocEntry[]; missing: DocRecord[] }> {
    const s = await this.need();
    const [files, ex] = await Promise.all([this.drive.filesIn([s.rootFolderId, ...s.categories.map(c => c.folderId)]), this.extractions(s)]);
    return { entries: files.map(f => ({ file: f, record: this.recordOf(s, f, ex.get(f.id)), category: this.categoryOf(s, f) })), missing: [] };
  }

  async upload(file: Blob & { name?: string }, name: string, category: string): Promise<DocEntry> {
    const s = await this.need();
    const folder = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    const f = await this.drive.upload(file, name, folder);
    return { file: f, record: this.recordOf(s, f), category };
  }

  /**
   * Put an email attachment's bytes in Drive. Saving the same attachment again
   * returns the copy already there instead of uploading twice.
   */
  async saveAttachment(a: AttachmentSource, category: string): Promise<{ record: DocRecord; existing: boolean }> {
    const s = await this.need();
    const key = await hash([a.mailbox, a.messageId, a.name, a.size].join('|'));
    const already = await this.drive.bySource(key);
    if (already) return { record: this.recordOf(s, already), existing: true };
    const folder = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    const f = await this.drive.upload(await a.blob(), a.name, folder, {
      axalSource: key, axalMsg: await hash(a.messageId), axalMailbox: a.mailbox.toLowerCase().slice(0, 100), axalThread: a.threadId.slice(0, 100)
    });
    return { record: this.recordOf(s, f), existing: false };
  }

  /** Attachments of this message (RFC Message-ID) already saved to Drive. */
  async savedFrom(messageId: string): Promise<DocRecord[]> {
    const s = await this.need();
    const files = await this.drive.byProperty('axalMsg', await hash(messageId));
    return files.map(f => ({ ...this.recordOf(s, f), source: { mailbox: f.appProperties?.axalMailbox || '', threadId: f.appProperties?.axalThread || '', messageId } }));
  }

  async rename(e: DocEntry, name: string) { await this.drive.rename(e.file.id, name.trim()); }

  async move(e: DocEntry, category: string) {
    const s = await this.need();
    const to = s.categories.find(c => c.name === category)?.folderId || s.rootFolderId;
    await this.drive.move(e.file.id, e.file.parents || [], to);
  }

  /** To Drive's trash (recoverable there), with its extraction. */
  async remove(e: DocEntry) {
    await this.drive.trash(e.file.id);
    const s = await this.need();
    const ex = (await this.extractions(s)).get(e.file.id);
    if (ex) await this.drive.trash(ex.file.id).catch(() => {});
  }

  /** Nothing to forget: Drive is the only record. */
  async forget(_r: DocRecord) {}

  /** The file's bytes; a Google Docs, Sheets or Slides file comes as a PDF (its name then ends in .pdf). */
  async file(e: DocEntry): Promise<{ blob: Blob; name: string; mime: string }> {
    if (e.file.mimeType.startsWith('application/vnd.google-apps.')) {
      const blob = await this.drive.exportPdf(e.file.id);
      return { blob, name: e.file.name.replace(/\.pdf$/i, '') + '.pdf', mime: 'application/pdf' };
    }
    return { blob: await this.drive.download(e.file.id), name: e.file.name, mime: e.file.mimeType || 'application/octet-stream' };
  }

  async download(e: DocEntry) { return (await this.file(e)).blob; }

  /** Read the file from Drive with the member's access, ask the assistant, and keep the result next to the file in Drive. */
  async analyze(e: DocEntry): Promise<DocRecord> {
    if (!this.extract) throw new Error('AI extraction needs the assistant on the Axal VC Mail server.');
    const mime = e.file.mimeType;
    if (!ANALYZABLE.includes(mime)) throw new Error('AI extraction supports PDF and plain text (.txt, .csv, .md) files.');
    if (Number(e.file.size) > MAX_ANALYZE) throw new Error('Documents up to 12 MB can be analyzed.');
    const s = await this.need();
    const blob = await this.drive.download(e.file.id);
    let result: Extraction | { error: string };
    try {
      result = await this.extract(mime === 'application/pdf' ? { mimeType: mime, name: e.file.name, data: await base64(blob) } : { mimeType: mime, name: e.file.name, text: await blob.text() });
    } catch (x) {
      result = { error: x instanceof Error ? x.message : String(x) };
    }
    const old = (await this.extractions(s)).get(e.file.id);
    const folder = this.extractionsFolder || (await this.drive.folder(EXTRACTIONS_NAME, 'extractions', s.rootFolderId)).id;
    this.extractionsFolder = folder;
    const saved = await this.drive.upload(new Blob([JSON.stringify(result)], { type: 'application/json' }), e.file.name + '.extraction.json', folder, { axalExtractionFor: e.file.id });
    if (old) await this.drive.trash(old.file.id).catch(() => {});
    return this.recordOf(s, e.file, { file: saved, result });
  }
}
