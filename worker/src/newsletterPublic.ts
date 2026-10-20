import type { Env } from './env';
import { HttpError, errorResponse, escapeHtml as esc } from './http';
import { getSettings, originsOf, sendConfirmation, sendWelcome, viewCopy } from './newsletters';
import { manageLinks, verify, appUrl, tokensReady } from './newsletterTokens';

/**
 * Public newsletter pages and the website signup endpoint, under
 * /api/public/newsletter/*. No sign-in: the signup form is open (consent,
 * honeypot, rate limit, double opt-in), and every other page acts only for
 * the subscriber a signed link names. Links in emails open a page with a
 * button, so a mail scanner that follows links never confirms or
 * unsubscribes anyone; the one-click List-Unsubscribe POST is the exception,
 * as RFC 8058 requires.
 */

const BASE = '/api/public/newsletter/';
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const MAX_FORM = 16 * 1024;
const HOUR = 3_600_000;
const PER_IP = 5;
const PER_EMAIL = 3;
const GLOBAL = 400;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- responses ----------

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Axal VC</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#16181d;--muted:#5d6370;--line:#e4e2dc;--btn:#16181d;--btnText:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111215;--card:#1a1c20;--text:#ecebe7;--muted:#9a9ea8;--line:#2c2f35;--btn:#ecebe7;--btnText:#111215}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
main{max-width:520px;margin:48px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
.brand{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:18px}
h1{font-size:24px;line-height:1.25;letter-spacing:-.02em;margin:0 0 10px}p{margin:0 0 14px}.muted{color:var(--muted);font-size:14px}
button,.btn{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:8px;padding:11px 18px;background:var(--btn);color:var(--btnText);cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}a{color:inherit}
fieldset{border:0;padding:0;margin:0 0 18px}legend{font-weight:600;margin-bottom:8px}label.opt{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}
label.opt:first-of-type{border-top:0}label.opt small{display:block;color:var(--muted)}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
</style></head><body><main><div class="card"><div class="brand">Axal VC</div>${body}</div></main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const linkExpired = () => page('Link expired', '<h1>This link has expired or is incomplete</h1><p>Links in our emails work for the person they were sent to. If you copied it, check it is complete. To sign up again, use the form on axal.vc.</p>', 400);

function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}

function cjson(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
}

/** Form fields from JSON, urlencoded or multipart bodies; repeated fields become arrays. */
async function fields(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FORM) throw new HttpError(413, 'Request too large');
  const type = req.headers.get('Content-Type') || '';
  const text = await req.text();
  if (text.length > MAX_FORM) throw new HttpError(413, 'Request too large');
  if (type.includes('application/json')) {
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'Malformed JSON'); }
  }
  if (type.includes('multipart/form-data')) {
    const fd = await new Response(text, { headers: { 'Content-Type': type } }).formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string') out[k] = k in out ? [...[out[k]].flat(), v] : v;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = k in out ? [...[out[k]].flat(), v] : v;
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(Boolean);
const yes = (v: unknown) => v === true || v === 'on' || v === 'true' || v === '1' || v === 'yes';

// ---------- signup ----------

async function rateLimited(env: Env, keys: [string, number][], now: number): Promise<boolean> {
  await env.DB.prepare('DELETE FROM nl_signup_attempts WHERE at < ?1').bind(now - 24 * HOUR).run();
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_signup_attempts WHERE at > ?1').bind(now - HOUR).first<{ n: number }>())?.n || 0;
  if (total >= GLOBAL) return true;
  for (const [k, max] of keys) {
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM nl_signup_attempts WHERE key = ?1 AND at > ?2').bind(k, now - HOUR).first<{ n: number }>())?.n || 0;
    if (n >= max) return true;
  }
  for (const [k] of keys) await env.DB.prepare('INSERT INTO nl_signup_attempts (key, at) VALUES (?1, ?2)').bind(k, now).run();
  return false;
}

interface SignupResult { ok: boolean; message: string; status: number }

const CHECK_INBOX = 'Thanks. Check your inbox to confirm your subscription.';

async function subscribe(env: Env, req: Request, b: Record<string, unknown>): Promise<SignupResult> {
  const now = Date.now();
  // Bots fill the hidden field; they get the same answer and nothing happens.
  if (str(b.website, 200)) return { ok: true, message: CHECK_INBOX, status: 200 };
  const email = str(b.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, message: 'Enter a valid email address.', status: 400 };
  if (!yes(b.consent)) return { ok: false, message: 'Tick the box to agree to receive our emails.', status: 400 };
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimited(env, [['ip:' + await sha256('nl:' + ip), PER_IP], ['em:' + await sha256('nl:' + email), PER_EMAIL]], now)) {
    return { ok: false, message: 'Too many signups from here. Try again in an hour.', status: 429 };
  }
  const s = await getSettings(env);
  const pub = (await env.DB.prepare('SELECT id, key FROM nl_lists WHERE public = 1').all<{ id: number; key: string }>()).results;
  const wanted = list(b.topics);
  let ids = pub.filter(l => wanted.includes(l.key) || wanted.includes(String(l.id))).map(l => l.id);
  if (!ids.length) ids = pub.filter(l => l.key === 'brief').map(l => l.id);
  if (!ids.length) ids = pub.map(l => l.id);
  const first = str(b.firstName ?? b.first_name, 80), last = str(b.lastName ?? b.last_name, 80), company = str(b.company, 120);
  const doubleOptIn = !!s.double_opt_in;
  const done = doubleOptIn ? CHECK_INBOX : 'Thanks. You’re subscribed.';

  const cur = await env.DB.prepare('SELECT id, status, confirm_sent_at FROM nl_subscribers WHERE email = ?1').bind(email).first<{ id: number; status: string; confirm_sent_at: number | null }>();
  // Already subscribed, bounced or suppressed: the same answer, so the form never reveals who is on the list.
  if (cur && ['subscribed', 'bounced', 'suppressed'].includes(cur.status)) return { ok: true, message: done, status: 200 };
  let id: number;
  if (cur) {
    // Pending, or signing up again after leaving: confirmation again, never subscribed directly.
    id = cur.id;
    const resend = cur.status === 'unsubscribed' || !cur.confirm_sent_at || cur.confirm_sent_at < now - 10 * 60_000;
    await env.DB.prepare(`UPDATE nl_subscribers SET status = 'pending', first_name = CASE WHEN ?2 != '' THEN ?2 ELSE first_name END, last_name = CASE WHEN ?3 != '' THEN ?3 ELSE last_name END,
      company = CASE WHEN ?4 != '' THEN ?4 ELSE company END, confirm_sent_at = CASE WHEN ?5 THEN NULL ELSE confirm_sent_at END, updated_at = ?6 WHERE id = ?1`)
      .bind(id, first, last, company, resend ? 1 : 0, now).run();
    if (!resend) { await addLists(env, id, ids, now); return { ok: true, message: CHECK_INBOX, status: 200 }; }
  } else {
    const r = await env.DB.prepare(`INSERT INTO nl_subscribers (email, first_name, last_name, company, status, source, consent_method, consent_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'website', ?6, ?7, ?8, ?8)`).bind(email, first, last, company, doubleOptIn ? 'pending' : 'subscribed', doubleOptIn ? null : 'single_opt_in', doubleOptIn ? null : now, now).run();
    id = Number(r.meta.last_row_id);
  }
  await addLists(env, id, ids, now);
  await env.DB.prepare('INSERT INTO nl_events (subscriber_id, issue_id, kind, detail, at) VALUES (?1, NULL, ?2, ?3, ?4)')
    .bind(id, 'signup', 'website · ' + (req.headers.get('Origin') || 'form').slice(0, 100), now).run();
  const sub = { id, email, first_name: first };
  if (doubleOptIn || cur) {
    // Sent now if possible; otherwise the cron sends it within ten minutes. Someone coming back always confirms again.
    await sendConfirmation(env, sub).catch(e => console.warn('Newsletter confirmation queued:', e instanceof Error ? e.message : e));
    return { ok: true, message: CHECK_INBOX, status: 200 };
  }
  await sendWelcome(env, sub).catch(e => console.warn('Newsletter welcome not sent:', e instanceof Error ? e.message : e));
  return { ok: true, message: done, status: 200 };
}

async function addLists(env: Env, id: number, ids: number[], now: number) {
  for (const l of ids) await env.DB.prepare('INSERT OR IGNORE INTO nl_memberships (subscriber_id, list_id, added_at) VALUES (?1, ?2, ?3)').bind(id, l, now).run();
}

// ---------- subscriber pages ----------

interface Sub { id: number; email: string; first_name: string; status: string; frequency: string }
const loadSub = (env: Env, id: number) => env.DB.prepare('SELECT id, email, first_name, status, frequency FROM nl_subscribers WHERE id = ?1').bind(id).first<Sub>();

async function event(env: Env, subscriberId: number, issueId: number | null, kind: string, detail: string) {
  await env.DB.prepare('INSERT INTO nl_events (subscriber_id, issue_id, kind, detail, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(subscriberId, issueId, kind, detail, Date.now()).run();
}

const hidden = (k: string, v: string) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`;

async function confirmPage(env: Env, req: Request, url: URL, b: Record<string, unknown>): Promise<Response> {
  const t = str(b.t, 300) || url.searchParams.get('t') || '';
  const id = await verify(env, 'c', t);
  if (!id) return linkExpired();
  const sub = await loadSub(env, id);
  if (!sub) return linkExpired();
  if (req.method === 'GET') {
    if (sub.status === 'subscribed') return subscribedPage(env, sub);
    return page('Confirm your subscription', `<h1>Confirm your subscription</h1><p>Confirm that <strong>${esc(sub.email)}</strong> should receive email from Axal VC.</p>
<form method="post" action="${BASE}confirm">${hidden('t', t)}<button type="submit">Confirm my subscription</button></form>`);
  }
  if (sub.status === 'pending') {
    const now = Date.now();
    await env.DB.prepare("UPDATE nl_subscribers SET status = 'subscribed', consent_method = 'double_opt_in', consent_at = ?2, updated_at = ?2, unsubscribed_at = NULL WHERE id = ?1 AND status = 'pending'").bind(id, now).run();
    // Signing up again by themselves lifts an earlier data-deletion suppression.
    await env.DB.prepare('DELETE FROM nl_suppressions WHERE email_hash = ?1').bind(await sha256(sub.email.toLowerCase())).run();
    await event(env, id, null, 'confirmed', 'double opt-in');
    await sendWelcome(env, sub).catch(e => console.warn('Newsletter welcome not sent:', e instanceof Error ? e.message : e));
  } else if (sub.status !== 'subscribed') return linkExpired();
  return subscribedPage(env, sub);
}

async function subscribedPage(env: Env, sub: Sub) {
  const links = await manageLinks(env, sub.id);
  return page('You’re subscribed', `<h1>You’re subscribed</h1><p>Thanks${sub.first_name ? ', ' + esc(sub.first_name) : ''}. Our next newsletter will reach <strong>${esc(sub.email)}</strong>.</p>
<p class="muted"><a href="${esc(links.preferencesUrl)}">Choose topics and frequency</a></p>`);
}

async function unsubscribePage(env: Env, req: Request, url: URL, b: Record<string, unknown>, oneClick: boolean): Promise<Response> {
  const t = str(b.t, 300) || url.searchParams.get('t') || '';
  const issue = Number(str(b.i, 20) || url.searchParams.get('i')) || null;
  const id = await verify(env, 'm', t);
  if (!id) return oneClick ? new Response('Invalid link', { status: 400 }) : linkExpired();
  const sub = await loadSub(env, id);
  if (!sub) return oneClick ? new Response('OK', { status: 200 }) : linkExpired();
  const links = await manageLinks(env, id);
  if (req.method === 'GET') {
    if (sub.status === 'unsubscribed') return unsubscribedPage(links.preferencesUrl);
    return page('Unsubscribe', `<h1>Unsubscribe from Axal VC newsletters?</h1><p><strong>${esc(sub.email)}</strong> will stop receiving all our newsletters.</p>
<form method="post" action="${BASE}unsubscribe">${hidden('t', t)}${issue ? hidden('i', String(issue)) : ''}<div class="row"><button type="submit">Unsubscribe</button>
<a class="btn" style="background:transparent;color:inherit;border:1px solid var(--line)" href="${esc(links.preferencesUrl)}">Change topics instead</a></div></form>`);
  }
  if (sub.status !== 'unsubscribed') {
    await env.DB.prepare("UPDATE nl_subscribers SET status = 'unsubscribed', unsubscribed_at = ?2, updated_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
    // Pending sends of issues in progress are skipped by the sender when it reaches them.
    await event(env, id, issue, 'unsubscribe', oneClick ? 'one-click' : 'unsubscribe page');
  }
  if (oneClick) return new Response('Unsubscribed', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return unsubscribedPage(links.preferencesUrl);
}

const unsubscribedPage = (prefs: string) => page('You’re unsubscribed', `<h1>You’re unsubscribed</h1><p>You won’t receive newsletters from Axal VC any more.</p>
<p class="muted">Changed your mind? <a href="${esc(prefs)}">Resubscribe</a>.</p>`);

async function preferencesPage(env: Env, req: Request, url: URL, b: Record<string, unknown>): Promise<Response> {
  const t = str(b.t, 300) || url.searchParams.get('t') || '';
  const id = await verify(env, 'm', t);
  if (!id) return linkExpired();
  const sub = await loadSub(env, id);
  if (!sub) return linkExpired();
  const mine = new Set((await env.DB.prepare('SELECT list_id FROM nl_memberships WHERE subscriber_id = ?1').bind(id).all<{ list_id: number }>()).results.map(r => r.list_id));
  // Public topics, plus private lists the person is on (they may leave those, not join them).
  const all = (await env.DB.prepare('SELECT id, name, description, public FROM nl_lists ORDER BY public DESC, name').all<{ id: number; name: string; description: string; public: number }>()).results
    .filter(l => l.public || mine.has(l.id));
  let saved = '';
  if (req.method === 'POST') {
    const action = str(b.action, 20);
    const now = Date.now();
    if (action === 'unsubscribe') return unsubscribePage(env, req, url, b, false);
    if (action === 'resubscribe' && sub.status === 'unsubscribed') {
      await env.DB.prepare("UPDATE nl_subscribers SET status = 'subscribed', consent_method = 'resubscribed', consent_at = ?2, unsubscribed_at = NULL, updated_at = ?2 WHERE id = ?1").bind(id, now).run();
      await event(env, id, null, 'resubscribed', 'preferences page');
      sub.status = 'subscribed';
      saved = 'Welcome back. You’re subscribed again.';
    } else if (action === 'save') {
      const chosen = new Set(list(b.topics).map(Number));
      for (const l of all) {
        if (chosen.has(l.id) && !mine.has(l.id) && l.public) { await env.DB.prepare('INSERT OR IGNORE INTO nl_memberships (subscriber_id, list_id, added_at) VALUES (?1, ?2, ?3)').bind(id, l.id, now).run(); mine.add(l.id); }
        if (!chosen.has(l.id) && mine.has(l.id)) { await env.DB.prepare('DELETE FROM nl_memberships WHERE subscriber_id = ?1 AND list_id = ?2').bind(id, l.id).run(); mine.delete(l.id); }
      }
      const freq = b.frequency === 'essentials' ? 'essentials' : 'all';
      await env.DB.prepare('UPDATE nl_subscribers SET frequency = ?2, updated_at = ?3 WHERE id = ?1').bind(id, freq, now).run();
      sub.frequency = freq;
      await event(env, id, null, 'preferences', [...mine].join(',') + ' · ' + freq);
      saved = 'Preferences saved.';
    }
  }
  if (sub.status === 'unsubscribed') {
    return page('Email preferences', `${saved ? `<p><strong>${esc(saved)}</strong></p>` : ''}<h1>You’re unsubscribed</h1><p><strong>${esc(sub.email)}</strong> doesn’t receive our newsletters.</p>
<form method="post" action="${BASE}preferences">${hidden('t', t)}${hidden('action', 'resubscribe')}<button type="submit">Resubscribe</button></form>`);
  }
  if (sub.status !== 'subscribed') return linkExpired();
  const opts = all.map(l => `<label class="opt"><input type="checkbox" name="topics" value="${l.id}"${mine.has(l.id) ? ' checked' : ''}><span>${esc(l.name)}<small>${esc(l.description)}</small></span></label>`).join('');
  return page('Email preferences', `${saved ? `<p><strong>${esc(saved)}</strong></p>` : ''}<h1>Email preferences</h1><p class="muted">For ${esc(sub.email)}</p>
<form method="post" action="${BASE}preferences">${hidden('t', t)}
<fieldset><legend>Topics</legend>${opts}</fieldset>
<fieldset><legend>How often</legend>
<label class="opt"><input type="radio" name="frequency" value="all"${sub.frequency !== 'essentials' ? ' checked' : ''}><span>Everything you chose<small>The brief, essays, invitations and portfolio news.</small></span></label>
<label class="opt"><input type="radio" name="frequency" value="essentials"${sub.frequency === 'essentials' ? ' checked' : ''}><span>Essentials only<small>The monthly brief and important announcements.</small></span></label></fieldset>
<div class="row"><button type="submit" name="action" value="save">Save preferences</button><button class="secondary" type="submit" name="action" value="unsubscribe">Unsubscribe from all</button></div></form>`);
}

// ---------- website embed ----------

function embedJs(env: Env): string {
  const endpoint = appUrl(env) + BASE;
  // Plain DOM, no dependencies; text is set with textContent, never innerHTML.
  return `(function(){"use strict";var E=${JSON.stringify(endpoint)};
function el(t,a,c){var e=document.createElement(t);for(var k in a)if(a.hasOwnProperty(k))e.setAttribute(k,a[k]);(c||[]).forEach(function(x){e.appendChild(typeof x==="string"?document.createTextNode(x):x)});return e}
function mount(box){if(box.getAttribute("data-mounted"))return;box.setAttribute("data-mounted","1");
var msg=el("p",{"class":"axal-nl-msg","role":"status","aria-live":"polite"});
var email=el("input",{type:"email",name:"email",required:"",placeholder:box.getAttribute("data-placeholder")||"Your email","aria-label":"Email address",autocomplete:"email"});
var hp=el("input",{type:"text",name:"website",tabindex:"-1",autocomplete:"off","aria-hidden":"true",style:"position:absolute;left:-9999px;width:1px;height:1px;opacity:0"});
var consent=el("input",{type:"checkbox",name:"consent",required:""});
var topics=el("div",{"class":"axal-nl-topics"});
var btn=el("button",{type:"submit"},[box.getAttribute("data-button")||"Subscribe"]);
var form=el("form",{"class":"axal-nl-form",novalidate:""},[el("div",{"class":"axal-nl-row"},[email,btn]),topics,
el("label",{"class":"axal-nl-consent"},[consent," "+(box.getAttribute("data-consent")||"I agree to receive emails from Axal VC. Unsubscribe at any time.")]),hp,msg]);
box.appendChild(form);
if(box.getAttribute("data-topics")!=="off")fetch(E+"topics").then(function(r){return r.json()}).then(function(d){(d.topics||[]).forEach(function(t){
var c=el("input",{type:"checkbox",name:"topics",value:t.key});if(t.key==="brief")c.checked=true;topics.appendChild(el("label",{"class":"axal-nl-topic"},[c," "+t.name]))})}).catch(function(){});
form.addEventListener("submit",function(ev){ev.preventDefault();msg.textContent="";
if(!email.value||email.value.indexOf("@")<1){msg.textContent="Enter a valid email address.";return}
if(!consent.checked){msg.textContent="Tick the box to agree to receive our emails.";return}
var t=[].slice.call(topics.querySelectorAll("input:checked")).map(function(x){return x.value});btn.disabled=true;
fetch(E+"subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email.value,consent:true,topics:t,website:hp.value})})
.then(function(r){return r.json()}).then(function(d){msg.textContent=d.message||"Thanks.";if(d.ok){form.reset();email.disabled=true}})
.catch(function(){msg.textContent="Something went wrong. Try again in a moment."}).then(function(){btn.disabled=false})})}
function run(){[].forEach.call(document.querySelectorAll("[data-axal-newsletter]"),mount)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run()})();`;
}

// ---------- routes ----------

export async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const name = url.pathname.slice(BASE.length);
  const origin = req.headers.get('Origin');
  const isPage = ['confirm', 'unsubscribe', 'preferences', 'view', 'test-link', 'preview-link'].includes(name);
  try {
    if (name === 'embed.js' && req.method === 'GET') {
      return new Response(embedJs(env), { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' } });
    }
    if (name === 'test-link' || name === 'preview-link') {
      return page('Test link', '<h1>This link works in the real newsletter</h1><p>In a test or preview, unsubscribe, preferences and view-in-browser links point here. Subscribers get their own links.</p>');
    }
    if (name === 'subscribe' || name === 'topics') {
      const s = await getSettings(env);
      const allowed = !!origin && (originsOf(s).includes(origin) || origin === url.origin);
      const cors = corsHeaders(origin, allowed);
      if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
      if (name === 'topics' && req.method === 'GET') {
        const topics = (await env.DB.prepare('SELECT key, name, description FROM nl_lists WHERE public = 1 ORDER BY id').all()).results;
        return cjson({ topics }, 200, { ...cors, 'Cache-Control': 'public, max-age=300' });
      }
      if (name === 'subscribe' && req.method === 'POST') {
        if (origin && !allowed) return cjson({ ok: false, message: 'This site can’t sign people up.' }, 403, cors);
        if (!tokensReady(env)) return cjson({ ok: false, message: 'Signups are not open yet. Try again later.' }, 503, cors);
        const json = (req.headers.get('Content-Type') || '').includes('application/json');
        const b = await fields(req);
        const r = await subscribe(env, req, b);
        if (json) return cjson({ ok: r.ok, message: r.message }, r.status, cors);
        // A plain HTML form post (no script): a page, with a way back to the site.
        const back = allowed && origin ? `<p class="muted"><a href="${esc(origin)}">Back to ${esc(origin.replace(/^https:\/\//, ''))}</a></p>` : '';
        return page(r.ok ? 'Check your inbox' : 'Signup', `<h1>${r.ok ? 'Almost there' : 'Signup not complete'}</h1><p>${esc(r.message)}</p>${back}`, r.status);
      }
    }
    if (name === 'confirm' && (req.method === 'GET' || req.method === 'POST')) return await confirmPage(env, req, url, req.method === 'POST' ? await fields(req) : {});
    if (name === 'unsubscribe' && (req.method === 'GET' || req.method === 'POST')) {
      const b = req.method === 'POST' ? await fields(req) : {};
      // RFC 8058: mail providers POST "List-Unsubscribe=One-Click" to the URL in the header.
      return await unsubscribePage(env, req, url, b, req.method === 'POST' && b['List-Unsubscribe'] === 'One-Click');
    }
    if (name === 'preferences' && (req.method === 'GET' || req.method === 'POST')) return await preferencesPage(env, req, url, req.method === 'POST' ? await fields(req) : {});
    if (name === 'view' && req.method === 'GET') {
      const id = await verify(env, 'm', url.searchParams.get('t'));
      const issue = Number(url.searchParams.get('i'));
      if (!id || !Number.isInteger(issue) || issue <= 0) return linkExpired();
      const html = await viewCopy(env, issue, id);
      if (!html) return page('Not available', '<h1>This newsletter isn’t available</h1><p>It may not have been sent to this address.</p>', 404);
      return new Response(html, { headers: { ...PAGE_HEADERS, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (isPage) return page('Not found', '<h1>Page not found</h1>', 405);
    return page('Not found', '<h1>Page not found</h1>', 404);
  } catch (e) {
    if (name === 'subscribe' || name === 'topics') {
      const res = errorResponse(e);
      const s = await getSettings(env).catch(() => null);
      const cors = corsHeaders(origin, !!origin && !!s && originsOf(s).includes(origin));
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
    if (e instanceof HttpError) return page('Error', `<h1>Something went wrong</h1><p>${esc(e.message)}</p>`, e.status);
    console.error('Newsletter page failed', e);
    return page('Unavailable', '<h1>Temporarily unavailable</h1><p>Try again in a few minutes.</p>', 503);
  }
}

