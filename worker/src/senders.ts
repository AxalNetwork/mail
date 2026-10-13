import type { Env } from './env';
import type { User } from './auth';
import { googleClientId } from './config';
import { delegatedToken, serviceAccount } from './delegation';
import { HttpError } from './http';

/**
 * Gmail credentials the Worker can use with no browser open, for scheduled
 * sends. Each member grants them once ("Connect sending"): an offline
 * authorization code exchanged here for a refresh token, stored encrypted
 * (AES-GCM, TOKEN_ENCRYPTION_KEY). With domain-wide delegation configured,
 * the service account is used instead and no grant is needed.
 */

export const SENDER_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const clientSecret = (env: Env) => (env.GOOGLE_CLIENT_SECRET || env.GMAIL_CLIENT_SECRET || '').trim();

export interface SenderStatus {
  /** Sends can run for this member. */
  connected: boolean;
  via: 'grant' | 'delegation' | null;
  googleEmail: string | null;
  /** The Worker has what it needs to accept a grant. */
  canConnect: boolean;
  missing: string[];
}

function missingConfig(env: Env): string[] {
  return [
    !clientSecret(env) && 'GOOGLE_CLIENT_SECRET (the OAuth client secret)',
    !env.TOKEN_ENCRYPTION_KEY && 'TOKEN_ENCRYPTION_KEY (32 random bytes, base64)'
  ].filter(Boolean) as string[];
}

// ---------- encryption ----------

async function key(env: Env): Promise<CryptoKey> {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new HttpError(503, 'Outreach sequences need the TOKEN_ENCRYPTION_KEY secret on the Worker.', 'sequences_off');
  const raw = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY.trim()), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new HttpError(503, 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.', 'sequences_off');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(plain)));
  return b64(iv) + '.' + b64(ct);
}

export async function decrypt(env: Env, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- grants ----------

interface Row { google_email: string; refresh_token: string }

export async function senderStatus(env: Env, user: User): Promise<SenderStatus> {
  const row = await env.DB.prepare('SELECT google_email FROM sender_credentials WHERE member_email = ?1').bind(user.memberEmail).first<{ google_email: string }>();
  const missing = missingConfig(env);
  if (row) return { connected: true, via: 'grant', googleEmail: row.google_email, canConnect: !missing.length, missing };
  if (serviceAccount(env)) return { connected: true, via: 'delegation', googleEmail: user.memberEmail, canConnect: !missing.length, missing };
  return { connected: false, via: null, googleEmail: null, canConnect: !missing.length, missing };
}

/** Exchange an authorization code from the browser's consent popup for a stored refresh token. */
export async function connectSender(env: Env, user: User, code: unknown): Promise<SenderStatus> {
  const missing = missingConfig(env);
  if (missing.length) throw new HttpError(503, 'Connect sending is not set up on the Worker: ' + missing.join(', ') + '.', 'sequences_off');
  if (typeof code !== 'string' || !code) throw new HttpError(400, 'Missing authorization code');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: 'postmessage',
      client_id: await googleClientId(env), client_secret: clientSecret(env)
    })
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new HttpError(400, 'Google refused the grant (' + (j.error_description || j.error || res.status) + '). Try again.');
  if (!j.refresh_token) throw new HttpError(400, 'Google did not return offline access. Remove Axal VC Mail at myaccount.google.com/permissions, then connect again.');
  const scopes = (j.scope || '').split(' ');
  if (!scopes.includes('https://www.googleapis.com/auth/gmail.send') || !scopes.includes('https://www.googleapis.com/auth/gmail.readonly')) {
    throw new HttpError(400, 'Sending needs both Gmail permissions. Connect again and keep both boxes ticked.');
  }
  // The grant must come from the account signed in to the app, never someone else's.
  const info = (await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(j.access_token))).json()) as { email?: string };
  const email = (info.email || '').toLowerCase();
  if (email !== user.email) throw new HttpError(403, 'Connect with ' + user.email + ', the account you are signed in with.');
  await env.DB.prepare(`INSERT INTO sender_credentials (member_email, google_email, refresh_token, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (member_email) DO UPDATE SET google_email = excluded.google_email, refresh_token = excluded.refresh_token, scope = excluded.scope, created_at = excluded.created_at`)
    .bind(user.memberEmail, email, await encrypt(env, j.refresh_token), j.scope || '', Date.now()).run();
  accessTokens.delete(user.memberEmail);
  return senderStatus(env, user);
}

/** Revoke the grant at Google and forget it. Active sequences of this member pause on their next send. */
export async function disconnectSender(env: Env, user: User): Promise<SenderStatus> {
  const row = await env.DB.prepare('SELECT google_email, refresh_token FROM sender_credentials WHERE member_email = ?1').bind(user.memberEmail).first<Row>();
  if (row) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(await decrypt(env, row.refresh_token)), { method: 'POST' });
    } catch { /* already revoked or key rotated: deleting is what matters */ }
    await env.DB.prepare('DELETE FROM sender_credentials WHERE member_email = ?1').bind(user.memberEmail).run();
  }
  accessTokens.delete(user.memberEmail);
  return senderStatus(env, user);
}

// ---------- access tokens for the runner ----------

const accessTokens = new Map<string, { token: string; email: string; until: number }>();

export class SenderUnavailable extends Error {}

/** An access token that sends as `memberEmail`, and the address it sends from. */
export async function senderToken(env: Env, memberEmail: string): Promise<{ token: string; email: string }> {
  const hit = accessTokens.get(memberEmail);
  if (hit && hit.until > Date.now()) return hit;
  const row = await env.DB.prepare('SELECT google_email, refresh_token FROM sender_credentials WHERE member_email = ?1').bind(memberEmail).first<Row>();
  if (!row) {
    if (serviceAccount(env)) return { token: await delegatedToken(env, memberEmail), email: memberEmail };
    throw new SenderUnavailable('Sending is not connected for ' + memberEmail + '. Open Outreach sequences and click Connect sending.');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: await decrypt(env, row.refresh_token),
      client_id: await googleClientId(env), client_secret: clientSecret(env)
    })
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    if (j.error === 'invalid_grant') await env.DB.prepare('DELETE FROM sender_credentials WHERE member_email = ?1').bind(memberEmail).run();
    throw new SenderUnavailable('Google no longer accepts the sending grant for ' + memberEmail + ' (' + (j.error || res.status) + '). Connect sending again.');
  }
  const t = { token: j.access_token, email: row.google_email, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  accessTokens.set(memberEmail, t);
  return t;
}

/** Test hook. */
export function clearSenderCache() {
  accessTokens.clear();
}
