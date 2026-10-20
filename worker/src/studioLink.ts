import type { Env } from './env';
import { HttpError } from './http';

/**
 * The Mail link: server-to-server reads from StudioOS (axal.vc), which keeps
 * the newsletter lists, members' choices and product-testing programmes with
 * their consent. Mail reads them and never edits them; it reports
 * unsubscribes, bounces and complaints back.
 *
 * Each request is signed with the MAIL_LINK_SECRET shared by both Workers:
 *   X-Axal-Link-Timestamp: unix seconds
 *   X-Axal-Link-Signature: hex HMAC-SHA256 of "METHOD\nPATH\nTIMESTAMP\nhex SHA-256(body)"
 * where PATH includes the query string. StudioOS's verifier is D811 (AxalNetwork/StudioOS#2257).
 * The secret never leaves the Worker.
 */

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

export const linkConfigured = (env: Env) => (env.MAIL_LINK_SECRET || '').trim().length >= 16;
export const studioBase = (env: Env) => (env.STUDIOOS_BASE_URL || 'https://axal.vc').replace(/\/+$/, '');

export class LinkError extends HttpError {}

/** The canonical string and signature, exported for the verifier fixture shared with StudioOS. */
export async function signRequest(secret: string, method: string, path: string, timestamp: number, body: string) {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', te.encode(body)));
  const canonical = method.toUpperCase() + '\n' + path + '\n' + timestamp + '\n' + bodyHash;
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { canonical, signature: hex(await crypto.subtle.sign('HMAC', key, te.encode(canonical))) };
}

async function call<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!linkConfigured(env)) throw new LinkError(503, 'Not connected: an admin sets the link secret (MAIL_LINK_SECRET) in both Workers.', 'link_not_connected');
  const text = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = await signRequest(env.MAIL_LINK_SECRET!.trim(), method, path, ts, text);
  let res: Response;
  try {
    res = await fetch(studioBase(env) + path, {
      method,
      headers: { 'X-Axal-Link-Timestamp': String(ts), 'X-Axal-Link-Signature': signature, Accept: 'application/json', ...(text ? { 'Content-Type': 'application/json' } : {}) },
      body: text || undefined
    });
  } catch {
    throw new LinkError(502, 'StudioOS didn’t answer.', 'link_unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new LinkError(502, 'StudioOS refused the link’s signature. Check that MAIL_LINK_SECRET is the same in both Workers.', 'link_refused');
  if (res.status === 404) throw new LinkError(404, 'StudioOS doesn’t have this yet.', 'link_missing');
  if (!res.ok) throw new LinkError(502, 'StudioOS answered ' + res.status + '.', 'link_failed');
  try { return (await res.json()) as T; } catch { throw new LinkError(502, 'StudioOS sent an unreadable answer.', 'link_unreadable'); }
}

const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const t = (v: unknown) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' && v ? Date.parse(v) || null : null);
const arr = (j: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (Array.isArray(j[k])) return j[k] as Record<string, unknown>[]; return []; };

// ---------- audiences ----------

export interface Audience { key: string; name: string; group: string; source: string; count: number; unsubscribed: number; bounced: number; requiresApproval: boolean }

export async function health(env: Env) {
  await call(env, 'GET', '/api/mail-link/health');
  return { ok: true };
}

export async function audiences(env: Env): Promise<Audience[]> {
  const j = await call<Record<string, unknown>>(env, 'GET', '/api/mail-link/audiences');
  return arr(j, 'audiences', 'items').map(a => ({
    key: s(a.key, 120), name: s(a.name, 120) || s(a.key, 120), group: s(a.group, 80), source: s(a.source ?? a.description, 200),
    count: n(a.count ?? a.recipients), unsubscribed: n(a.unsubscribed), bounced: n(a.bounced),
    requiresApproval: a.requires_approval === true || a.locked === true
  })).filter(a => /^[\w:.-]{1,120}$/.test(a.key));
}

export interface LinkRecipient { email: string; first_name: string; last_name: string; company: string; unsubscribe_url: string; preferences_url: string; one_click_url: string }

/** Every recipient of an audience, page by page (StudioOS pages are 500). */
export async function recipients(env: Env, key: string, max = 50_000): Promise<LinkRecipient[]> {
  const out: LinkRecipient[] = [];
  let cursor = '';
  for (let page = 0; page < 200 && out.length < max; page++) {
    const j = await call<Record<string, unknown>>(env, 'GET', '/api/mail-link/audiences/' + encodeURIComponent(key) + '/recipients' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    for (const r of arr(j, 'items', 'recipients')) {
      const email = s(r.email, 254).trim().toLowerCase();
      if (!email.includes('@')) continue;
      out.push({ email, first_name: s(r.first_name, 80), last_name: s(r.last_name, 80), company: s(r.company, 120), unsubscribe_url: s(r.unsubscribe_url, 600), preferences_url: s(r.preferences_url, 600), one_click_url: s(r.one_click_url, 600) });
    }
    cursor = s(j.next_cursor ?? j.cursor, 200);
    if (!cursor) break;
  }
  return out;
}

export interface LinkEvent { type: 'unsubscribe' | 'bounce' | 'complaint'; email: string; audience?: string; message_id: string; at: number }

/** Report events back; StudioOS removes the person from the list. Idempotent by message id. */
export async function postEvents(env: Env, events: LinkEvent[]) {
  if (!events.length) return;
  await call(env, 'POST', '/api/mail-link/events', { events });
}

// ---------- product testing ----------

export interface Programme {
  uid: string; name: string; ownerKind: 'hq' | 'partner'; ownerName: string; status: string; summary: string; tasks: string; timeNeeded: string;
  places: number; picked: number; applicants: number; opensAt: number | null; closesAt: number | null; testingStartsAt: number | null; testingEndsAt: number | null;
  logoUrl: string; studioUrl: string;
}

const prog = (env: Env, p: Record<string, unknown>): Programme => {
  const uid = s(p.uid ?? p.id, 80);
  return {
    uid, name: s(p.product_name ?? p.name, 160), ownerKind: p.owner_kind === 'partner' ? 'partner' : 'hq', ownerName: s(p.owner_name, 120) || (p.owner_kind === 'partner' ? 'Partner' : 'Axal VC'),
    status: s(p.status, 20) || 'draft', summary: s(p.summary, 600), tasks: s(p.tester_tasks ?? p.tasks, 1000), timeNeeded: s(p.time_needed, 120),
    places: n(p.places), picked: n(p.picked_count ?? p.picked), applicants: n(p.applicant_count ?? p.applicants),
    opensAt: t(p.opens_at), closesAt: t(p.closes_at), testingStartsAt: t(p.testing_starts_at), testingEndsAt: t(p.testing_ends_at),
    logoUrl: /^https:\/\//.test(s(p.logo_url, 600)) ? s(p.logo_url, 600) : '', studioUrl: studioBase(env) + '/product-testing'
  };
};

export async function programmes(env: Env): Promise<Programme[]> {
  const j = await call<Record<string, unknown>>(env, 'GET', '/api/mail-link/testing/programmes');
  return arr(j, 'items', 'programmes').map(p => prog(env, p)).filter(p => /^[\w-]{1,80}$/.test(p.uid));
}

export interface Applicant { uid: string; name: string; role: string; why: string; availability: string; consented: boolean; status: string; appliedAt: number | null; pickedAt: number | null; email: string }

export async function applicants(env: Env, uid: string): Promise<{ programme: Programme | null; items: Applicant[] }> {
  if (!/^[\w-]{1,80}$/.test(uid)) throw new HttpError(400, 'Unknown programme');
  const j = await call<Record<string, unknown>>(env, 'GET', '/api/mail-link/testing/programmes/' + encodeURIComponent(uid) + '/applicants');
  const answers = (a: Record<string, unknown>) => (Array.isArray(a.answers) ? (a.answers as unknown[]).map(x => (typeof x === 'object' && x ? s((x as Record<string, unknown>).answer, 400) : s(x, 400))).filter(Boolean).join(' · ') : s(a.answers, 600));
  return {
    programme: j.programme && typeof j.programme === 'object' ? prog(env, j.programme as Record<string, unknown>) : null,
    items: arr(j, 'items', 'applicants').map(a => ({
      uid: s(a.uid ?? a.id, 80), name: s(a.name, 120), role: s(a.role, 40), why: answers(a), availability: s(a.availability, 200), consented: a.consented === true,
      status: s(a.status, 20) || 'applied', appliedAt: t(a.applied_at ?? a.created_at), pickedAt: t(a.picked_at), email: s(a.email, 254)
    }))
  };
}
