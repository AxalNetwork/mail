/**
 * Browser OAuth for Google APIs using Google Identity Services' token model.
 * Access tokens live for about an hour; they are kept in sessionStorage so a
 * page reload doesn't force a new consent, and are never written to localStorage.
 */

export const SCOPES = [
  'openid',
  'email',
  'profile',
  // Read, label, archive, trash, send and manage drafts.
  'https://www.googleapis.com/auth/gmail.modify',
  // Send-as identities and the signature setting.
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // Recipient autocomplete.
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly'
];

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const STORE_KEY = 'axal.gmail.token';
const HINT_KEY = 'axal.gmail.hint';

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(cfg: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
  }): TokenClient;
  revoke(token: string, done?: () => void): void;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleOAuth2 } };
  }
}

let gisPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your connection or content blockers.')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

interface StoredToken {
  token: string;
  expiresAt: number;
}

export class GoogleAuth {
  private client: TokenClient | null = null;
  private current: StoredToken | null = null;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  private inflight: Promise<string> | null = null;
  /** Called when a silent token refresh fails and the user has to sign in again. */
  onSessionLost: (() => void) | null = null;

  constructor(private clientId: string) {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (raw) this.current = JSON.parse(raw);
    } catch { /* storage unavailable */ }
  }

  /** A stored token that is still valid for at least a minute. */
  hasValidToken(): boolean {
    return !!this.current && this.current.expiresAt - Date.now() > 60_000;
  }

  /** Address used last time, offered as "Continue as …". */
  get loginHint(): string {
    try { return localStorage.getItem(HINT_KEY) || ''; } catch { return ''; }
  }

  set loginHint(email: string) {
    try { localStorage.setItem(HINT_KEY, email); } catch { /* ignore */ }
  }

  private async ensureClient(): Promise<TokenClient> {
    await loadGis();
    if (!this.client) {
      this.client = window.google!.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPES.join(' '),
        callback: (r) => {
          const p = this.pending; this.pending = null;
          if (!p) return;
          if (r.error || !r.access_token) return p.reject(new Error(r.error_description || r.error || 'Google sign-in failed'));
          this.current = { token: r.access_token, expiresAt: Date.now() + Number(r.expires_in || 3600) * 1000 };
          try { sessionStorage.setItem(STORE_KEY, JSON.stringify(this.current)); } catch { /* ignore */ }
          p.resolve(r.access_token);
        },
        error_callback: (e) => {
          const p = this.pending; this.pending = null;
          p?.reject(new Error(e.type === 'popup_closed' ? 'Sign-in window was closed.' : e.message || 'Google sign-in failed'));
        }
      });
    }
    return this.client;
  }

  /**
   * Interactive sign-in. Must be called from a click handler so the browser
   * allows the consent popup.
   */
  async signIn(): Promise<string> {
    return this.request(this.loginHint ? '' : 'consent');
  }

  private request(prompt: string): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const client = await this.ensureClient();
      return new Promise<string>((resolve, reject) => {
        this.pending = { resolve, reject };
        client.requestAccessToken({ prompt, login_hint: this.loginHint || undefined });
      });
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** A valid access token, refreshing silently when it is about to expire. */
  async token(): Promise<string> {
    if (this.hasValidToken()) return this.current!.token;
    try {
      return await this.request('');
    } catch (e) {
      // Outside a click the browser may block the refresh popup; ask the user to continue.
      this.onSessionLost?.();
      throw e;
    }
  }

  /** Drop the cached token (e.g. after a 401) so the next call refreshes. */
  invalidate() {
    this.current = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }

  signOut() {
    const t = this.current?.token;
    this.invalidate();
    try { localStorage.removeItem(HINT_KEY); } catch { /* ignore */ }
    if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t);
  }
}
