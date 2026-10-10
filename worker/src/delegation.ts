import type { Env } from './env';
import { HttpError } from './http';
import { googleClientId } from './config';

/**
 * Google Workspace domain-wide delegation: the Worker signs a JWT with the
 * service account key and exchanges it for an access token that acts as
 * `mailbox`. The key never leaves the Worker; browsers only reach shared
 * mailboxes through the checked proxy in mailboxes.ts.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DELEGATED_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const tokens = new Map<string, { token: string; until: number }>();
let keyCache: { pem: string; key: Promise<CryptoKey> } | null = null;

export function serviceAccount(env: Env): ServiceAccount | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key ? { client_email: sa.client_email, private_key: sa.private_key } : null;
  } catch {
    return null;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function importKey(pem: string): Promise<CryptoKey> {
  if (keyCache?.pem === pem) return keyCache.key;
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  const key = crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pem, key };
  return key;
}

// ---------- one mailbox through a stored refresh token ----------

const hasRefreshToken = (env: Env) => !!(env.GMAIL_REFRESH_TOKEN && env.GMAIL_CLIENT_SECRET);
let refreshed: { token: string; email: string; until: number } | null = null;

/** Exchange GMAIL_REFRESH_TOKEN for an access token, and learn which mailbox it opens. */
async function refreshTokenMailbox(env: Env): Promise<{ token: string; email: string }> {
  if (refreshed && refreshed.until > Date.now()) return refreshed;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      client_id: await googleClientId(env),
      client_secret: env.GMAIL_CLIENT_SECRET!
    })
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    console.warn('GMAIL_REFRESH_TOKEN refresh failed:', j.error, j.error_description);
    throw new HttpError(502, 'Google rejected GMAIL_REFRESH_TOKEN (' + (j.error || res.status) + '). Check that it was issued to GMAIL_CLIENT_ID with GMAIL_CLIENT_SECRET, and has not been revoked.', 'delegation_failed');
  }
  const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + j.access_token } });
  const email = ((await p.json().catch(() => ({}))) as { emailAddress?: string }).emailAddress?.toLowerCase();
  if (!p.ok || !email) throw new HttpError(502, 'GMAIL_REFRESH_TOKEN works but cannot read Gmail (' + p.status + '). It needs the gmail.modify scope.', 'delegation_failed');
  refreshed = { token: j.access_token, email, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return refreshed;
}

/** The mailbox GMAIL_REFRESH_TOKEN opens, or null when none is configured or it fails. */
export async function refreshTokenEmail(env: Env): Promise<string | null> {
  if (!hasRefreshToken(env)) return null;
  try {
    return (await refreshTokenMailbox(env)).email;
  } catch {
    return null;
  }
}

/** Shared mailboxes are possible: a service account, or a stored refresh token. */
export function delegationEnabled(env: Env): boolean {
  return !!serviceAccount(env) || hasRefreshToken(env);
}

/** An access token for `mailbox`, cached until shortly before it expires. */
export async function delegatedToken(env: Env, mailbox: string): Promise<string> {
  if (hasRefreshToken(env) && (await refreshTokenEmail(env)) === mailbox) return (await refreshTokenMailbox(env)).token;
  const sa = serviceAccount(env);
  if (!sa) {
    if (hasRefreshToken(env)) {
      const own = await refreshTokenEmail(env);
      throw new HttpError(400, own
        ? 'GMAIL_REFRESH_TOKEN opens ' + own + ' only. Other mailboxes need a GOOGLE_SERVICE_ACCOUNT key with domain-wide delegation.'
        : 'GMAIL_REFRESH_TOKEN is set but Google rejected it. Check GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and the token.', 'delegation_failed');
    }
    throw new HttpError(503, 'Shared mailboxes are not set up: the Worker has no GOOGLE_SERVICE_ACCOUNT key or GMAIL_REFRESH_TOKEN.', 'delegation_off');
  }
  const hit = tokens.get(mailbox);
  if (hit && hit.until > Date.now()) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64urlJson({ iss: sa.client_email, sub: mailbox, scope: DELEGATED_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(sa.private_key), new TextEncoder().encode(unsigned)));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) })
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    console.warn('Delegated token for', mailbox, 'failed:', j.error, j.error_description);
    const hint = j.error === 'unauthorized_client'
      ? ' Allow the service account in the Admin console (Security → API controls → Domain-wide delegation) with the scope ' + DELEGATED_SCOPE + '.'
      : j.error === 'invalid_grant' ? ' Check that ' + mailbox + ' is an existing Google Workspace user.' : '';
    throw new HttpError(502, 'Google refused access to ' + mailbox + '.' + hint, 'delegation_failed');
  }
  tokens.set(mailbox, { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 });
  if (tokens.size > 200) tokens.delete(tokens.keys().next().value!);
  return j.access_token;
}

/** Test hook. */
export function clearDelegationCache() {
  tokens.clear();
  keyCache = null;
  refreshed = null;
}
