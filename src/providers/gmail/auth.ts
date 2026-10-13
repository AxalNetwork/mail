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
const SESSION_KEY = 'axal.session.start';
/** Sign-in lasts at most this long; then the user signs in again. */
export const SESSION_MS = 12 * 60 * 60 * 1000;

export type SessionEnd = 'expired' | 'lost';

export interface SignInOptions {
  /** Address to prefill in Google's sign-in ("Continue" with an Axal VC email). */
  hint?: string;
  /** Show Google's account chooser ("Continue with Google"). */
  selectAccount?: boolean;
}

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

interface CodeClient {
  requestCode(): void;
}

interface GoogleOAuth2 {
  initCodeClient(cfg: {
    client_id: string;
    scope: string;
    ux_mode: 'popup';
    login_hint?: string;
    callback: (r: { code?: string; error?: string; error_description?: string }) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
  }): CodeClient;
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

/** A failure reported by Google's sign-in popup; `type` is e.g. popup_closed or popup_failed_to_open. */
export class GoogleSignInError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
  }
}

let gisPromise: Promise<void> | null = null;

export function loadGis(): Promise<void> {
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
  /** Called when the session ends (12-hour limit, or a refresh Google refused) and the user must sign in again. */
  onSessionLost: ((why: SessionEnd) => void) | null = null;

  constructor(private clientId: string) {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (raw) this.current = JSON.parse(raw);
    } catch { /* storage unavailable */ }
  }

  /** A stored token that is still valid for at least a minute, within an unexpired session. */
  hasValidToken(): boolean {
    return !!this.current && this.current.expiresAt - Date.now() > 60_000 && !this.sessionExpired();
  }

  private get sessionStart(): number {
    try { return Number(localStorage.getItem(SESSION_KEY) || 0); } catch { return 0; }
  }

  /** The 12-hour session limit has passed since the last interactive sign-in. */
  sessionExpired(now = Date.now()): boolean {
    const start = this.sessionStart;
    return !!start && now - start > SESSION_MS;
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
          // Google lets people untick permissions on the consent screen; Mail cannot work without Gmail access.
          const granted = (r.scope || '').split(' ');
          if (r.scope && !granted.includes('https://www.googleapis.com/auth/gmail.modify')) {
            window.google?.accounts.oauth2.revoke(r.access_token);
            return p.reject(new Error('Allow Axal VC Mail to read, organize and send your Gmail to continue.'));
          }
          this.current = { token: r.access_token, expiresAt: Date.now() + Number(r.expires_in || 3600) * 1000 };
          try { sessionStorage.setItem(STORE_KEY, JSON.stringify(this.current)); } catch { /* ignore */ }
          p.resolve(r.access_token);
        },
        error_callback: (e) => {
          const p = this.pending; this.pending = null;
          p?.reject(new GoogleSignInError(e.type, e.type === 'popup_closed' ? 'Sign-in window was closed.'
            : e.type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.'
            : e.message || 'Google sign-in failed'));
        }
      });
    }
    return this.client;
  }

  /**
   * Interactive sign-in. Must be called from a click handler so the browser
   * allows the consent popup.
   */
  async signIn(o: SignInOptions = {}): Promise<string> {
    // A fresh interactive sign-in replaces any token from an earlier account.
    this.invalidate();
    const token = await this.request(o.selectAccount ? 'select_account' : '', o.hint ?? this.loginHint);
    try { localStorage.setItem(SESSION_KEY, String(Date.now())); } catch { /* ignore */ }
    return token;
  }

  /** The current token, if any (no refresh). */
  get accessToken(): string | null {
    return this.hasValidToken() ? this.current!.token : null;
  }

  private request(prompt: string, hint = this.loginHint): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const client = await this.ensureClient();
      return new Promise<string>((resolve, reject) => {
        this.pending = { resolve, reject };
        client.requestAccessToken({ prompt, login_hint: hint || undefined });
      });
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** A valid access token, refreshing silently when it is about to expire. */
  async token(): Promise<string> {
    if (this.sessionExpired()) {
      this.invalidate();
      this.onSessionLost?.('expired');
      throw new Error('Your session ended. Sign in again.');
    }
    if (this.hasValidToken()) return this.current!.token;
    try {
      return await this.request('');
    } catch (e) {
      // Outside a click the browser may block the refresh popup; ask the user to continue.
      this.onSessionLost?.('lost');
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
    try { localStorage.removeItem(HINT_KEY); localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t);
  }
}

/**
 * One-time consent for offline Gmail access (sending scheduled outreach while
 * no browser is open). Returns the authorization code, which only the Worker
 * can exchange, using the client secret.
 */
export async function requestOfflineCode(clientId: string, scopes: string[], hint?: string): Promise<string> {
  await loadGis();
  return new Promise((resolve, reject) => {
    window.google!.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: scopes.join(' '),
      ux_mode: 'popup',
      login_hint: hint,
      callback: r => (r.code ? resolve(r.code) : reject(new GoogleSignInError(r.error || 'denied', r.error_description || 'Google did not grant access.'))),
      error_callback: e => reject(new GoogleSignInError(e.type, e.type === 'popup_closed' ? 'The Google window closed before you finished.' : e.message || e.type))
    }).requestCode();
  });
}
