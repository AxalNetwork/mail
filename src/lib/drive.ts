import { ApiError, GoogleClient } from '../providers/gmail/client';
import type { GoogleAuth } from '../providers/gmail/auth';
import { DriveNotConnected } from '../providers/gmail/driveAuth';

/**
 * Google Drive v3, called from the browser with the member's drive.file token.
 * Folders and files this app creates carry `appProperties` so they can be found
 * again without creating duplicates (on retries or a second connection).
 */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,parents,trashed,owners(displayName,emailAddress),appProperties,webViewLink';

export interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; createdTime: string; modifiedTime: string; parents?: string[]; trashed?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[]; appProperties?: Record<string, string>; webViewLink?: string;
}

/** Google refused because the grant is missing, too narrow or revoked: reconnect. */
const accessProblem = (e: unknown) => e instanceof DriveNotConnected || (e instanceof ApiError && (e.status === 401 || (e.status === 403 && /insufficient|permission|scope|revoked/i.test(e.message))));

const q = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

export interface TokenSource { token(): Promise<string>; invalidate(): void }

export class Drive {
  private api: GoogleClient;
  constructor(auth: TokenSource) { this.api = new GoogleClient(auth as unknown as GoogleAuth); }

  private async call<T>(url: string, o: Parameters<GoogleClient['request']>[1] = {}): Promise<T> {
    try { return await this.api.request<T>(url, o); } catch (e) {
      if (accessProblem(e)) throw new DriveNotConnected(e instanceof DriveNotConnected ? e.message : 'Google Drive no longer accepts Axal VC Mail’s access. Reconnect Google Drive.');
      throw e;
    }
  }

  /** The Google account the token belongs to. */
  async account(): Promise<string> {
    const r = await this.call<{ user?: { emailAddress?: string } }>(API + '/about', { query: { fields: 'user(emailAddress)' } });
    return (r.user?.emailAddress || '').toLowerCase();
  }

  /** A file's current metadata, or null when it no longer exists (or was trashed) in Drive. */
  async get(id: string): Promise<DriveFile | null> {
    try {
      const f = await this.call<DriveFile>(API + '/files/' + id, { query: { fields: FIELDS } });
      return f.trashed ? null : f;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async search(conditions: string[], pageSize = 100): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(API + '/files', {
        query: { q: [...conditions, 'trashed = false'].join(' and '), fields: 'nextPageToken,files(' + FIELDS + ')', pageSize, pageToken, spaces: 'drive' }
      });
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken && out.length < 2000);
    return out;
  }

  /** The folder tagged `key`, created under `parent` only if it doesn't exist yet. */
  async folder(name: string, key: string, parent?: string): Promise<DriveFile> {
    const found = await this.search([`mimeType = ${q(FOLDER)}`, `appProperties has { key='axal' and value=${q(key)} }`, ...(parent ? [`${q(parent)} in parents`] : [])], 10);
    if (found.length) return found[0];
    return this.call<DriveFile>(API + '/files', { query: { fields: FIELDS }, json: { name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties: { axal: key } } });
  }

  /** Files directly inside these folders. */
  async filesIn(folderIds: string[]): Promise<DriveFile[]> {
    if (!folderIds.length) return [];
    return this.search(['(' + folderIds.map(id => q(id) + ' in parents').join(' or ') + ')', `mimeType != ${q(FOLDER)}`]);
  }

  /** A file this app saved from a source (e.g. an email attachment) before, if it's still there. */
  async bySource(key: string): Promise<DriveFile | null> {
    return (await this.search([`appProperties has { key='axalSource' and value=${q(key.slice(0, 120))} }`], 1))[0] || null;
  }

  /** Upload the bytes (multipart). */
  async upload(blob: Blob, name: string, parent: string, appProperties: Record<string, string> = {}): Promise<DriveFile> {
    const b = 'axal_drive_' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [parent], mimeType: blob.type || undefined, appProperties: { axalDoc: '1', ...appProperties } });
    const body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n',
      '--' + b + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n', blob, '\r\n--' + b + '--'
    ]);
    return this.call<DriveFile>(UPLOAD + '/files', { method: 'POST', query: { uploadType: 'multipart', fields: FIELDS }, body, headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
  }

  rename(id: string, name: string) {
    return this.call<DriveFile>(API + '/files/' + id, { method: 'PATCH', query: { fields: FIELDS }, json: { name } });
  }

  move(id: string, from: string[], to: string) {
    return this.call<DriveFile>(API + '/files/' + id, { method: 'PATCH', query: { fields: FIELDS, addParents: to, removeParents: from.filter(p => p !== to).join(',') || undefined }, json: {} });
  }

  /** Move to Drive's trash (recoverable there for 30 days), rather than deleting outright. */
  trash(id: string) {
    return this.call<DriveFile>(API + '/files/' + id, { method: 'PATCH', query: { fields: FIELDS }, json: { trashed: true } });
  }

  async download(id: string): Promise<Blob> {
    const res = await this.call<Response>(API + '/files/' + id, { query: { alt: 'media' }, raw: true });
    return res.blob();
  }
}
