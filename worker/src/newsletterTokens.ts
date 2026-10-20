import type { Env } from './env';
import { HttpError } from './http';

/**
 * Signed links for newsletter subscribers, so nothing secret is stored:
 * - "m" (manage): unsubscribe, preferences and view-in-browser; never expires;
 * - "c" (confirm): double opt-in, valid for 7 days.
 * A token is base64url("<purpose>.<subscriber id>.<expiry>") + "." + HMAC-SHA256.
 */

const CONFIRM_MS = 7 * 86_400_000;
const te = new TextEncoder();

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const secret = (env.NEWSLETTER_SIGNING_KEY || env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (secret.length < 16) throw new HttpError(503, 'Newsletter links need the NEWSLETTER_SIGNING_KEY (or TOKEN_ENCRYPTION_KEY) secret on the Worker.', 'newsletter_off');
  return crypto.subtle.importKey('raw', te.encode('axal-newsletter:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export const tokensReady = (env: Env) => (env.NEWSLETTER_SIGNING_KEY || env.TOKEN_ENCRYPTION_KEY || '').trim().length >= 16;

export async function sign(env: Env, purpose: 'm' | 'c', id: number, now = Date.now()): Promise<string> {
  const body = purpose + '.' + id + '.' + (purpose === 'c' ? now + CONFIRM_MS : 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), te.encode(body)));
  return b64u(te.encode(body)) + '.' + b64u(sig.slice(0, 18));
}

/** The subscriber id a token was signed for, or null if it is forged, for another purpose, or expired. */
export async function verify(env: Env, purpose: 'm' | 'c', token: string | null, now = Date.now()): Promise<number | null> {
  if (!token || token.length > 200) return null;
  const [b, s] = token.split('.');
  if (!b || !s) return null;
  let body: string;
  try { body = new TextDecoder().decode(unb64u(b)); } catch { return null; }
  const [p, id, exp] = body.split('.');
  if (p !== purpose || !/^\d+$/.test(id || '') || !/^\d+$/.test(exp || '')) return null;
  let sig: Uint8Array;
  try { sig = unb64u(s); } catch { return null; }
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), te.encode(body))).slice(0, 18);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig[i] ^ expected[i];
  if (diff) return null;
  if (purpose === 'c' && Number(exp) < now) return null;
  return Number(id);
}

export const appUrl = (env: Env) => (env.APP_URL || 'https://mail.axal.vc').replace(/\/+$/, '');

export async function manageLinks(env: Env, id: number, issueId?: number) {
  const t = await sign(env, 'm', id);
  const base = appUrl(env) + '/api/public/newsletter/';
  const i = issueId ? '&i=' + issueId : '';
  return {
    unsubscribeUrl: base + 'unsubscribe?t=' + t + i,
    preferencesUrl: base + 'preferences?t=' + t,
    viewUrl: issueId ? base + 'view?t=' + t + i : base + 'preferences?t=' + t
  };
}
