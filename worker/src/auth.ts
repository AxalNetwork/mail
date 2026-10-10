import type { Env } from './env';
import { HttpError } from './http';

export interface User {
  /** The Google account that signed in (may be a linked personal account). */
  email: string;
  /** The Axal VC member it acts as. */
  memberEmail: string;
  name: string;
}

interface TokenInfo {
  aud?: string;
  azp?: string;
  email?: string;
  email_verified?: string | boolean;
  exp?: string;
}

// Per-isolate cache of signed-in users, so each request doesn't round-trip to
// Google and D1. A suspension takes effect within CACHE_MS.
const cache = new Map<string, { user: User; until: number }>();
const CACHE_MS = 5 * 60_000;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function allowedDomains(env: Env): string[] {
  return (env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

const SUSPENDED = (email: string) =>
  new HttpError(403, email + ' is suspended in Axal VC. Contact your administrator to restore access.', 'suspended');

/**
 * Map a verified Google account to an Axal VC member:
 * - an address on an allowed domain is a member (a `members` row can name or suspend it);
 * - any other address must be listed in `linked_accounts`.
 */
export async function resolveMember(env: Env, googleEmail: string): Promise<User> {
  const domain = googleEmail.split('@')[1];
  if (allowedDomains(env).includes(domain)) {
    const m = await env.DB.prepare('SELECT name, status FROM members WHERE email = ?1').bind(googleEmail).first<{ name: string; status: string }>();
    if (m?.status === 'suspended') throw SUSPENDED(googleEmail);
    return { email: googleEmail, memberEmail: googleEmail, name: m?.name || '' };
  }
  const linked = await env.DB
    .prepare('SELECT m.email, m.name, m.status FROM linked_accounts l JOIN members m ON m.email = l.member_email WHERE l.google_email = ?1')
    .bind(googleEmail)
    .first<{ email: string; name: string; status: string }>();
  if (!linked) {
    throw new HttpError(403,
      'Sign in with your Axal VC email, choose the Google account linked to your profile, or ask your administrator to link this one.',
      'not_linked');
  }
  if (linked.status === 'suspended') throw SUSPENDED(linked.email);
  return { email: googleEmail, memberEmail: linked.email, name: linked.name };
}

/**
 * Verify the caller's Google OAuth access token (the same one the browser uses
 * for Gmail): it must be issued to our OAuth client, carry a verified email,
 * and belong to an active Axal VC member.
 */
export async function authenticate(req: Request, env: Env): Promise<User> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'Sign in with Google to use this API', 'signed_out');
  const token = m[1];
  const key = await sha256(token);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;

  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
  if (!res.ok) throw new HttpError(401, 'Your Google session is not valid. Sign in again.', 'signed_out');
  const info = (await res.json()) as TokenInfo;
  if (!env.GOOGLE_CLIENT_ID || (info.aud !== env.GOOGLE_CLIENT_ID && info.azp !== env.GOOGLE_CLIENT_ID)) {
    throw new HttpError(401, 'Token was not issued to Axal VC Mail', 'signed_out');
  }
  const email = (info.email || '').toLowerCase();
  if (!email || !(info.email_verified === true || info.email_verified === 'true')) {
    throw new HttpError(403, 'Google did not confirm an email address for this account.', 'unverified');
  }
  const user = await resolveMember(env, email);
  const exp = Number(info.exp || 0) * 1000;
  cache.set(key, { user, until: Math.min(Date.now() + CACHE_MS, exp || Date.now() + CACHE_MS) });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return user;
}

/** Test hook. */
export function clearAuthCache() {
  cache.clear();
}
