// In-memory stand-ins for Google Drive and the Worker's documents API (mocks, not real Drive).
import type { DriveFile } from '../../lib/drive';
import { Documents, type Extraction } from '../../lib/documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';

export function fakeDrive(account = 'julian@axal.vc') {
  let n = 0;
  const files = new Map<string, DriveFile & { blob?: Blob }>();
  const drive = {
    files,
    revoked: false,
    account: vi.fn(async () => account),
    get: vi.fn(async (id: string) => { const f = files.get(id); return f && !f.trashed ? f : null; }),
    findFolder: vi.fn(async (key: string, parent?: string) =>
      [...files.values()].find(f => f.appProperties?.axal === key && !f.trashed && (!parent || f.parents?.includes(parent))) || null),
    foldersIn: vi.fn(async (parent: string) => {
      if (drive.revoked) throw new DriveNotConnected('Google Drive no longer accepts Axal VC Mail’s access. Reconnect Google Drive.');
      return [...files.values()].filter(f => !f.trashed && f.mimeType === 'application/vnd.google-apps.folder' && f.parents?.includes(parent));
    }),
    byProperty: vi.fn(async (key: string, value: string) => [...files.values()].filter(f => f.appProperties?.[key] === value && !f.trashed)),
    exportPdf: vi.fn(async () => new Blob(['%PDF-exported'], { type: 'application/pdf' })),
    folder: vi.fn(async (name: string, key: string, parent?: string) => {
      const hit = [...files.values()].find(f => f.appProperties?.axal === key && !f.trashed && (!parent || f.parents?.includes(parent)));
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

export function fakeDocuments(o: { account?: string } = {}) {
  const drive = fakeDrive(o.account);
  const auth = { connected: false, connect: vi.fn(async () => { auth.connected = true; return 't'; }), disconnect: vi.fn(() => { auth.connected = false; }) };
  const extract = vi.fn(async (_b: { mimeType: string; name: string; data?: string; text?: string }): Promise<Extraction> => ({
    summary: 'Seed deck.', source: 'pdf', missing: ['revenue'],
    items: [{ field: 'company_name', value: 'Northstar AI', kind: 'stated', page: 1, quote: 'Northstar AI', quoteVerified: null }]
  }));
  const docs = new Documents(drive as never, auth, async () => 'julian@axal.vc', extract);
  return { docs, drive, auth, extract };
}
