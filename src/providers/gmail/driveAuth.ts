import { GoogleSignInError, loadGis } from './auth';

/**
 * Google Drive access, asked for separately from Gmail and only when a member
 * turns Documents on. The scope is drive.file: Axal VC Mail can see and change
 * only the files and folders it created (or that the member opens with it),
 * never the rest of their Drive. The token stays in this tab's sessionStorage.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const STORE_KEY = 'axal.drive.token';
const CONNECTED_KEY = 'axal.drive.connected';

/** Drive isn't connected (never, or Google no longer accepts the grant): the member has to connect again. */
export class DriveNotConnected extends Error {
  constructor(message = 'Connect Google Drive to use Documents.') { super(message); }
}

interface TokenClient { requestAccessToken(o?: { prompt?: string; login_hint?: string }): void }

export class DriveAuth {
  private client: TokenClient | null = null;
  private current: { token: string; expiresAt: number } | null = null;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private clientId: string, private hint: () => string) {
    try { const raw = sessionStorage.getItem(STORE_KEY); if (raw) this.current = JSON.parse(raw); } catch { /* storage unavailable */ }
  }

  /** The member connected Drive in this browser before (a refresh may still need them to click). */
  get connected(): boolean {
    try { return localStorage.getItem(CONNECTED_KEY) === '1'; } catch { return false; }
  }

  private async ensureClient(): Promise<TokenClient> {
    await loadGis();
    if (!this.client) {
      this.client = window.google!.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        callback: r => {
          const p = this.pending; this.pending = null;
          if (!p) return;
          if (r.error || !r.access_token) return p.reject(new DriveNotConnected(r.error_description || 'Google Drive access was not granted.'));
          if (r.scope && !r.scope.split(' ').includes(DRIVE_SCOPE)) return p.reject(new DriveNotConnected('Allow Axal VC Mail to see and manage the Drive files it creates.'));
          this.current = { token: r.access_token, expiresAt: Date.now() + Number(r.expires_in || 3600) * 1000 };
          try { sessionStorage.setItem(STORE_KEY, JSON.stringify(this.current)); localStorage.setItem(CONNECTED_KEY, '1'); } catch { /* ignore */ }
          p.resolve(r.access_token);
        },
        error_callback: e => {
          const p = this.pending; this.pending = null;
          p?.reject(new GoogleSignInError(e.type, e.type === 'popup_closed' ? 'The Google window closed before you finished.'
            : e.type === 'popup_failed_to_open' ? 'The Google window was blocked. Allow pop-ups for this site and try again.' : e.message || 'Google Drive access failed'));
        }
      });
    }
    return this.client;
  }

  private request(prompt: string): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const client = await this.ensureClient();
      return new Promise<string>((resolve, reject) => {
        this.pending = { resolve, reject };
        client.requestAccessToken({ prompt, login_hint: this.hint() || undefined });
      });
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Ask for Drive access. Call from a click so the consent window may open. */
  connect(): Promise<string> { this.invalidate(); return this.request('consent'); }

  /** A valid token, refreshed without a prompt when the member already granted access. */
  async token(): Promise<string> {
    if (this.current && this.current.expiresAt - Date.now() > 60_000) return this.current.token;
    if (!this.connected) throw new DriveNotConnected();
    try { return await this.request(''); } catch { throw new DriveNotConnected('Google Drive needs you to reconnect.'); }
  }

  invalidate() {
    this.current = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }

  /** Revoke the Drive grant at Google and forget it here. Files stay in Drive. */
  disconnect() {
    const t = this.current?.token;
    this.invalidate();
    try { localStorage.removeItem(CONNECTED_KEY); } catch { /* ignore */ }
    if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t);
  }
}
