// In-memory stand-ins for Google Drive and the Worker's documents API (mocks, not real Drive).
import type { DriveFile } from '../../lib/drive';
import { Documents, type DocRecord, type DocumentsBackend, type Settings } from '../../lib/documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';

export function fakeDrive(account = 'julian@axal.vc') {
  let n = 0;
  const files = new Map<string, DriveFile & { blob?: Blob }>();
  const drive = {
    files,
    revoked: false,
    account: vi.fn(async () => account),
    get: vi.fn(async (id: string) => { const f = files.get(id); return f && !f.trashed ? f : null; }),
    folder: vi.fn(async (name: string, key: string, parent?: string) => {
      const hit = [...files.values()].find(f => f.appProperties?.axal === key && !f.trashed);
      if (hit) return hit;
      const f: DriveFile = { id: 'fold' + ++n, name, mimeType: 'application/vnd.google-apps.folder', createdTime: new Date().toISOString(), modifiedTime: '', parents: parent ? [parent] : [], appProperties: { axal: key } };
      files.set(f.id, f);
      return f;
    }),
    filesIn: vi.fn(async (ids: string[]) => {
      if (drive.revoked) throw new DriveNotConnected('Google Drive no longer accepts Axal VC Mail’s access. Reconnect Google Drive.');
      return [...files.values()].filter(f => !f.trashed && f.mimeType !== 'application/vnd.google-apps.folder' && f.parents?.some(p => ids.includes(p)));
    }),
    bySource: vi.fn(async (key: string) => [...files.values()].find(f => f.appProperties?.axalSource === key.slice(0, 120) && !f.trashed) || null),
    upload: vi.fn(async (blob: Blob, name: string, parent: string, appProperties: Record<string, string> = {}) => {
      const f = { id: 'file' + ++n, name, mimeType: blob.type || 'application/octet-stream', size: String(blob.size), createdTime: new Date(Date.now() + n).toISOString(), modifiedTime: '', parents: [parent], owners: [{ displayName: 'Julian Park', emailAddress: account }], appProperties: { axalDoc: '1', ...appProperties }, blob };
      files.set(f.id, f);
      return f;
    }),
    rename: vi.fn(async (id: string, name: string) => { const f = files.get(id)!; f.name = name; return f; }),
    move: vi.fn(async (id: string, _from: string[], to: string) => { const f = files.get(id)!; f.parents = [to]; return f; }),
    trash: vi.fn(async (id: string) => { const f = files.get(id)!; f.trashed = true; return f; }),
    download: vi.fn(async (id: string) => files.get(id)!.blob || new Blob(['text'], { type: 'text/plain' }))
  };
  return drive;
}

export function fakeBackend() {
  let n = 0;
  let settings: Settings | null = null;
  const rows: DocRecord[] = [];
  const keys = new Map<string, number>();
  const backend: DocumentsBackend & { rows: DocRecord[] } = {
    rows,
    settings: vi.fn(async () => settings),
    saveSettings: vi.fn(async s => (settings = s)),
    list: vi.fn(async (src?: string) => rows.filter(r => !src || r.source?.messageId === src)),
    record: vi.fn(async d => {
      if (d.sourceKey && keys.has(d.sourceKey)) {
        const hit = rows.find(r => r.id === keys.get(d.sourceKey!));
        if (hit && hit.driveFileId !== d.driveFileId) return { document: hit, existing: true };
      }
      let r = rows.find(x => x.driveFileId === d.driveFileId);
      if (!r) {
        r = { id: ++n, driveFileId: d.driveFileId, name: d.name, mimeType: d.mimeType || '', size: d.size ?? null, category: d.category || '', folderId: d.folderId || '',
          source: d.sourceMessageId ? { mailbox: d.sourceMailbox || '', threadId: d.sourceThreadId || '', messageId: d.sourceMessageId } : null,
          createdAt: Date.now(), updatedAt: Date.now(), missing: false, extraction: { status: 'none', at: null, result: null } };
        rows.push(r);
      }
      if (d.sourceKey) keys.set(d.sourceKey, r.id);
      return { document: r, existing: false };
    }),
    byKey: vi.fn(async key => rows.find(r => r.id === keys.get(key)) || null),
    update: vi.fn(async (id, p) => { const r = rows.find(x => x.id === id)!; Object.assign(r, p.missing === undefined ? p : { ...p, missing: !!p.missing }); return r; }),
    remove: vi.fn(async id => { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); for (const [k, v] of keys) if (v === id) keys.delete(k); }),
    analyze: vi.fn(async id => rows.find(r => r.id === id)!)
  };
  return backend;
}

export function fakeDocuments(o: { account?: string } = {}) {
  const drive = fakeDrive(o.account);
  const backend = fakeBackend();
  const auth = { connected: false, connect: vi.fn(async () => { auth.connected = true; return 't'; }), disconnect: vi.fn(() => { auth.connected = false; }) };
  const docs = new Documents(drive as never, backend, auth, async () => 'julian@axal.vc');
  return { docs, drive, backend, auth };
}
