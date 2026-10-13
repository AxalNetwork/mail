// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../index';
import { clearAuthCache } from '../auth';
import { clearDelegationCache } from '../delegation';
import { clearSenderCache } from '../senders';
import { runDue } from '../sequences';
import type { Env } from '../env';

/** Minimal D1 over node:sqlite, enough for prepare/bind/all/first/run (+ exec for seeding). */
function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_notes.sql', '0002_members.sql', '0003_roles.sql', '0004_mailboxes.sql', '0005_bug_reports.sql', '0006_sequences.sql', '0007_internal.sql']) {
    db.exec(readFileSync(fileURLToPath(new URL('../../migrations/' + f, import.meta.url).href), 'utf8'));
  }
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) { params = p; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(params as never[])) }; },
        async first() { return db.prepare(sql).get(...(params as never[])) ?? null; },
        async run() { const r = db.prepare(sql).run(...(params as never[])); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; }
      };
      return stmt;
    },
    exec: (sql: string) => db.exec(sql)
  } as unknown as D1Database & { exec: (sql: string) => void };
}

const ORIGIN = 'https://mail.axal.vc';
let env: Env;
let anthropicCalls: { headers: Headers; body: Record<string, unknown> }[];
let claudeReply: Record<string, unknown>;
let gmailCalls: { url: string; method: string; auth: string | null; body: string }[];
let delegationError: string | null;
let githubCalls: { url: string; auth: string | null; body: Record<string, unknown> }[];
let githubStatus: number[];
let sends: { raw: string; threadId?: string; auth: string | null }[];
let sendMode: string[];
let threads: Record<string, unknown[]>;
let revokedGrant: boolean;

function mockFetch(tokens: Record<string, Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
      const info = tokens[url.searchParams.get('access_token') || ''];
      return info ? Response.json(info) : Response.json({ error_description: 'Invalid Value' }, { status: 400 });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(await req.text());
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || form.get('client_secret') !== 'shh' || form.get('redirect_uri') !== 'postmessage') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'at-julian', refresh_token: 'rt-julian', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'rt-julian') {
        return revokedGrant ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'at-julian', expires_in: 3600 });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== 'rt-ir' || form.get('client_secret') !== 'shh' || form.get('client_id') !== 'client-1') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'dwd:ir@axal.vc', expires_in: 3600 });
      }
      const assertion = form.get('assertion') || '';
      const claims = JSON.parse(atob(assertion.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (delegationError) return Response.json({ error: delegationError }, { status: 401 });
      return Response.json({ access_token: 'dwd:' + claims.sub, expires_in: 3600 });
    }
    if (url.hostname === 'gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages/send') {
      const body = await req.json() as { raw: string; threadId?: string };
      const mode = sendMode.shift() ?? 'ok';
      if (mode === 'throw') throw new TypeError('network down');
      if (mode === '500') return Response.json({ error: { message: 'Backend Error' } }, { status: 500 });
      if (mode === '400') return Response.json({ error: { message: 'Invalid To header' } }, { status: 400 });
      const raw = new TextDecoder().decode(Uint8Array.from(atob(body.raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
      sends.push({ raw, threadId: body.threadId, auth: req.headers.get('Authorization') });
      return Response.json({ id: 'msg' + sends.length, threadId: body.threadId || 'th' + sends.length });
    }
    if (url.hostname === 'gmail.googleapis.com' && /\/messages\/msg\d+$/.test(url.pathname)) {
      return Response.json({ id: 'x', threadId: 'x', payload: { headers: [{ name: 'Message-ID', value: '<' + url.pathname.split('/').pop() + '@mail.gmail.com>' }] } });
    }
    if (url.hostname === 'gmail.googleapis.com' && url.pathname.includes('/threads/th')) {
      const id = url.pathname.split('/').pop()!;
      return Response.json({ id, messages: threads[id] || [] });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') return new Response('', { status: 200 });
    if (url.hostname === 'gmail.googleapis.com') {
      gmailCalls.push({ url: url.pathname + url.search, method: req.method, auth: req.headers.get('Authorization'), body: req.method === 'GET' ? '' : await req.text() });
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: (req.headers.get('Authorization') || '').replace('Bearer dwd:', '') });
      return Response.json({ ok: true });
    }
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const records: Record<string, { type: number; data: string }[]> = {
        'axal.vc/MX': [{ type: 15, data: '1 smtp.google.com.' }],
        'axal.vc/TXT': [{ type: 16, data: '"v=spf1 include:_spf.google.com ~all"' }, { type: 16, data: '"google-site-verification=x"' }],
        'google._domainkey.axal.vc/TXT': [{ type: 16, data: '"v=DKIM1; k=rsa; p=MIIBIjAN" "BgkqhkiG9w0"' }],
        '_dmarc.axal.vc/TXT': [{ type: 16, data: '"v=DMARC1; p=none"' }]
      };
      return Response.json({ Answer: records[name + '/' + type] || [] });
    }
    if (url.hostname === 'api.github.com') {
      const body = await req.json() as Record<string, unknown>;
      githubCalls.push({ url: url.pathname, auth: req.headers.get('Authorization'), body });
      const status = githubStatus.shift() ?? 201;
      return status === 201
        ? Response.json({ number: 41 + githubCalls.length, html_url: 'https://github.com/AxalNetwork/mail/issues/' + (41 + githubCalls.length) }, { status })
        : Response.json({ message: 'Validation Failed' }, { status });
    }
    if (url.hostname === 'api.anthropic.com') {
      anthropicCalls.push({ headers: req.headers, body: await req.json() });
      return Response.json(claudeReply);
    }
    return new Response('unexpected ' + url, { status: 599 });
  }));
}

const good = { aud: 'client-1', email: 'julian@axal.vc', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) };

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', 'Bearer ' + init.token);
  if (init.body) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(ORIGIN + path, { ...init, headers }), env);
}

function message(json: unknown, stop = 'end_turn') {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_sequence: null,
    content: stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(json) }],
    usage: { input_tokens: 10, output_tokens: 10 }
  };
}

const thread = { id: 't1', subject: 'Seed round', labels: [], messages: [{ from: 'Maya Chen', email: 'maya@n.example', to: 'Julian', time: 'Today 09:42', text: 'Can we talk Tuesday?', attachments: [] }] };

let serviceAccountJson: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  const pem = '-----BEGIN PRIVATE KEY-----\n' + btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';
  serviceAccountJson = JSON.stringify({ client_email: 'mail@axal.iam.gserviceaccount.com', private_key: pem });
});

beforeEach(() => {
  clearAuthCache();
  clearDelegationCache();
  anthropicCalls = [];
  gmailCalls = [];
  delegationError = null;
  githubCalls = [];
  githubStatus = [];
  sends = [];
  sendMode = [];
  threads = {};
  revokedGrant = false;
  clearSenderCache();
  env = {
    ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html>app', { headers: { 'Content-Type': 'text/html' } })) } as unknown as Fetcher,
    DB: fakeD1(), GOOGLE_CLIENT_ID: 'client-1', ALLOWED_DOMAINS: 'axal.vc', ORG_DOMAIN: 'axal.vc', ANTHROPIC_API_KEY: 'sk-test',
    SUPER_ADMINS: 'boss@axal.vc'
  };
  mockFetch({
    good,
    other: { ...good, aud: 'someone-else' },
    outsider: { ...good, email: 'eve@evil.example' },
    personal: { ...good, email: 'julian.park@gmail.com' },
    priya: { ...good, email: 'priya@axal.vc' },
    boss: { ...good, email: 'boss@axal.vc' },
    ada: { ...good, email: 'ada@axal.vc' },
    built: { ...good, aud: 'built-1' },
    'at-julian': { ...good },
    unverified: { ...good, email_verified: 'false' }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('routing', () => {
  it('serves the frontend for non-API paths', async () => {
    const r = await call('/inbox');
    expect(await r.text()).toContain('app');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it('exposes public config', async () => {
    const r = await call('/api/config');
    expect(await r.json()).toEqual({ googleClientId: 'client-1', orgDomain: 'axal.vc', assistant: true, notes: true, session: true, bugReports: false });
    env.ANTHROPIC_API_KEY = undefined;
    expect((await (await call('/api/config')).json() as { assistant: boolean }).assistant).toBe(false);
  });

  it('falls back to the client ID captured at build time', async () => {
    env.GOOGLE_CLIENT_ID = undefined;
    env.ASSETS = { fetch: vi.fn(async () => Response.json({ googleClientId: 'built-1' })) } as unknown as Fetcher;
    expect(await (await call('/api/config')).json()).toMatchObject({ googleClientId: 'built-1' });
    expect((await call('/api/session', { token: 'built' })).status).toBe(200);
    expect((await call('/api/session', { token: 'good' })).status).toBe(401);
  });

  it('has no client ID when neither the Worker nor the build sets one', async () => {
    env.GOOGLE_CLIENT_ID = undefined;
    expect(await (await call('/api/config')).json()).toMatchObject({ googleClientId: '' });
    expect((await call('/api/session', { token: 'good' })).status).toBe(401);
  });

  it('404s unknown API routes after auth', async () => {
    expect((await call('/api/nope', { token: 'good' })).status).toBe(404);
  });
});

describe('auth', () => {
  it.each([
    ['no token', undefined, 401],
    ['unknown token', 'bogus', 401],
    ['token for another OAuth client', 'other', 401],
    ['account outside allowed domains', 'outsider', 403],
    ['unverified email', 'unverified', 403]
  ])('rejects %s', async (_label, token, status) => {
    expect((await call('/api/notes?key=%3Ca%40b%3E', { token })).status).toBe(status);
  });

  it('maps linked personal accounts to members and blocks suspended members', async () => {
    const db = env.DB as unknown as { exec: (sql: string) => void };
    expect(await (await call('/api/session', { token: 'personal' })).json()).toEqual({ error: expect.any(String), code: 'not_linked' });
    db.exec(`INSERT INTO members (email, name, status, created_at) VALUES ('julian@axal.vc', 'Julian Park', 'active', 0), ('priya@axal.vc', 'Priya Natarajan', 'suspended', 0);
             INSERT INTO linked_accounts (google_email, member_email, created_at) VALUES ('julian.park@gmail.com', 'julian@axal.vc', 0);`);
    clearAuthCache();
    expect(await (await call('/api/session', { token: 'personal' })).json()).toEqual({ user: { email: 'julian.park@gmail.com', memberEmail: 'julian@axal.vc', name: 'Julian Park', role: 'member' } });
    expect(await (await call('/api/session', { token: 'good' })).json()).toEqual({ user: { email: 'julian@axal.vc', memberEmail: 'julian@axal.vc', name: 'Julian Park', role: 'member' } });
    const sus = await call('/api/session', { token: 'priya' });
    expect(sus.status).toBe(403);
    expect(await sus.json()).toMatchObject({ code: 'suspended' });
    db.exec(`UPDATE members SET status = 'suspended' WHERE email = 'julian@axal.vc'`);
    clearAuthCache();
    expect(await (await call('/api/session', { token: 'personal' })).json()).toMatchObject({ code: 'suspended' });
  });

  it('refuses cross-origin writes', async () => {
    const r = await call('/api/notes', { method: 'POST', token: 'good', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ key: '<a@b>', text: 'x' }) });
    expect(r.status).toBe(403);
  });
});

describe('notes', () => {
  it('stores and lists notes per conversation', async () => {
    const add = await call('/api/notes', { method: 'POST', token: 'good', headers: { Origin: ORIGIN }, body: JSON.stringify({ key: '<root@x>', text: ' Priya joins Thursday ', authorName: 'Julian Park' }) });
    expect(add.status).toBe(201);
    await call('/api/notes', { method: 'POST', token: 'good', body: JSON.stringify({ key: '<other@x>', text: 'elsewhere' }) });
    const list = await (await call('/api/notes?key=' + encodeURIComponent('<root@x>'), { token: 'good' })).json() as { notes: { text: string; author: string }[] };
    expect(list.notes).toEqual([expect.objectContaining({ text: 'Priya joins Thursday', author: 'Julian Park' })]);
  });

  const note = (token: string, body: Record<string, unknown>) => post('/api/notes', token, { key: '<root@x>', ...body });
  const patch = (path: string, token: string, body: unknown) => call(path, { method: 'PATCH', token, headers: { Origin: ORIGIN }, body: JSON.stringify(body) });
  const del = (path: string, token: string) => call(path, { method: 'DELETE', token, headers: { Origin: ORIGIN } });
  type N = { id: number; text: string; kind: string; mine: boolean; canEdit: boolean; canDelete: boolean; mentions: { email: string }[]; updatedAt: number | null };
  const listOf = async (token: string) => ((await (await call('/api/notes?key=' + encodeURIComponent('<root@x>'), { token })).json()) as { notes: N[] }).notes;

  it('lets authors edit, authors or admins delete, and keeps an activity log without note text', async () => {
    (env.DB as unknown as { exec: (s: string) => void }).exec(`INSERT INTO members (email, name, status, role, created_at) VALUES ('ada@axal.vc', 'Ada', 'active', 'admin', 0), ('priya@axal.vc', 'Priya', 'active', 'member', 0)`);
    const a = ((await (await note('good', { text: 'LP is keen on AI infra', subject: 'Fund II' })).json()) as { note: N }).note;
    expect(a).toMatchObject({ kind: 'note', mine: true, canEdit: true, canDelete: true });
    const b = ((await (await note('priya', { text: 'Agreed', kind: 'comment' })).json()) as { note: N }).note;
    expect(b.kind).toBe('comment');
    // Julian sees Priya's comment but can't edit or delete it.
    expect((await listOf('good')).find(n => n.id === b.id)).toMatchObject({ mine: false, canEdit: false, canDelete: false });
    expect((await patch('/api/notes/' + b.id, 'good', { text: 'hijack' })).status).toBe(403);
    expect((await del('/api/notes/' + b.id, 'good')).status).toBe(403);
    // The author edits; an admin may delete someone else's.
    const edited = ((await (await patch('/api/notes/' + a.id, 'good', { text: 'LP keen on AI infra; follow up after Q3' })).json()) as { note: N }).note;
    expect(edited.text).toContain('Q3');
    expect(edited.updatedAt).toBeGreaterThan(0);
    expect((await del('/api/notes/' + b.id, 'ada')).status).toBe(200);
    expect((await listOf('good')).map(n => n.id)).toEqual([a.id]);
    expect((await patch('/api/notes/' + b.id, 'priya', { text: 'back' })).status).toBe(404);
    const act = ((await (await call('/api/notes/activity?key=' + encodeURIComponent('<root@x>'), { token: 'good' })).json()) as { activity: { action: string; actor: string }[] }).activity;
    expect(act.map(x => x.action)).toEqual(['created', 'created', 'edited', 'deleted']);
    expect(JSON.stringify(act)).not.toContain('AI infra');
    const stored = await env.DB.prepare('SELECT text, deleted_at FROM notes WHERE id = ?1').bind(b.id).first<{ text: string; deleted_at: number }>();
    expect(stored).toMatchObject({ text: '' });
  });

  it('records mentions of members only, and shows them in the mentioned person’s Internal inbox', async () => {
    (env.DB as unknown as { exec: (s: string) => void }).exec(`INSERT INTO members (email, name, status, created_at) VALUES ('priya@axal.vc', 'Priya Natarajan', 'active', 0), ('gone@axal.vc', 'Gone', 'suspended', 0)`);
    const members = ((await (await call('/api/internal/members', { token: 'good' })).json()) as { members: { email: string }[] }).members.map(m => m.email);
    expect(members).toContain('priya@axal.vc');
    expect(members).not.toContain('gone@axal.vc');
    const n = ((await (await note('good', { text: '@Priya can you take this?', subject: 'Seed round', mentions: ['priya@axal.vc', 'eve@evil.example', 'julian@axal.vc'] })).json()) as { note: N }).note;
    expect(n.mentions.map(m => m.email)).toEqual(['priya@axal.vc']);
    const inbox = (await (await call('/api/internal', { token: 'priya' })).json()) as { unread: number; mentions: (N & { read: boolean; subject: string; key: string })[]; recent: N[] };
    expect(inbox.unread).toBe(1);
    expect(inbox.mentions[0]).toMatchObject({ id: n.id, read: false, subject: 'Seed round', key: '<root@x>' });
    expect(inbox.recent.map(r => r.id)).toContain(n.id);
    await post('/api/internal/read', 'priya', { ids: [n.id] });
    expect(((await (await call('/api/internal', { token: 'priya' })).json()) as { unread: number }).unread).toBe(0);
    // Julian's own inbox has no mention of himself.
    expect(((await (await call('/api/internal', { token: 'good' })).json()) as { mentions: unknown[] }).mentions).toEqual([]);
  });

  it('keeps internal notes away from people who are not members', async () => {
    await note('good', { text: 'confidential' });
    expect((await call('/api/notes?key=' + encodeURIComponent('<root@x>'), { token: 'outsider' })).status).toBe(403);
    expect((await call('/api/internal', { token: 'outsider' })).status).toBe(403);
    expect((await call('/api/notes?key=' + encodeURIComponent('<root@x>'))).status).toBe(401);
  });

  it('validates input', async () => {
    expect((await call('/api/notes?key=not-a-message-id', { token: 'good' })).status).toBe(400);
    expect((await call('/api/notes', { method: 'POST', token: 'good', body: JSON.stringify({ key: '<a@b>', text: '  ' }) })).status).toBe(400);
    expect((await call('/api/notes', { method: 'POST', token: 'good', body: '{oops' })).status).toBe(400);
  });
});

describe('assistant', () => {
  it('summarizes with structured output, fallbacks on, and escapes the drafted reply', async () => {
    claudeReply = message({
      summary: 'Maya asks for a call.', points: [{ kind: 'Request', text: 'Call Tuesday', src: 'Maya Chen · Today 09:42', tone: 'accent' }],
      reply_needed: true, reply: ['Hi Maya,', 'Tuesday works. <img src=x onerror=alert(1)>', 'Best regards,']
    });
    const r = await call('/api/assistant/insight', { method: 'POST', token: 'good', body: JSON.stringify({ thread }) });
    const out = await r.json() as { summary: string; draft: string };
    expect(r.status).toBe(200);
    expect(out.summary).toBe('Maya asks for a call.');
    expect(out.draft).toBe('<p>Hi Maya,</p><p>Tuesday works. &lt;img src=x onerror=alert(1)&gt;</p><p>Best regards,</p>');
    const c = anthropicCalls[0];
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium', format: { type: 'json_schema' } } });
    expect(c.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(c.headers.get('x-api-key')).toBe('sk-test');
    expect(JSON.stringify(c.body.messages)).toContain('Can we talk Tuesday?');
  });

  it('omits the draft when no reply is needed', async () => {
    claudeReply = message({ summary: 'Digest.', points: [], reply_needed: false, reply: [] });
    const out = await (await call('/api/assistant/insight', { method: 'POST', token: 'good', body: JSON.stringify({ thread }) })).json() as { draft?: string };
    expect(out.draft).toBeUndefined();
  });

  it('rewrites and writes persona messages', async () => {
    claudeReply = message({ paragraphs: ['Bonjour Maya,', 'Mardi me convient.'], note: { title: 'Translated to French.', text: 'Check names and dates.' } });
    const rw = await (await call('/api/assistant/rewrite', { method: 'POST', token: 'good', body: JSON.stringify({ text: 'Hi Maya, Tuesday works.', mode: 'translate', thread: null }) })).json() as { html: string; note: { title: string } };
    expect(rw.html).toBe('<p>Bonjour Maya,</p><p>Mardi me convient.</p>');
    expect(anthropicCalls[0].body).toMatchObject({ output_config: { effort: 'low' } });
    claudeReply = message({ subject: 'Invitation', body: 'Hi {first_name},\n\n{opening}Join us.' });
    const p = await (await call('/api/assistant/persona', { method: 'POST', token: 'good', body: JSON.stringify({ persona: 'Founder', tone: 'direct', brief: 'demo day' }) })).json();
    expect(p).toEqual({ subject: 'Invitation', body: 'Hi {first_name},\n\n{opening}Join us.' });
  });

  it('reports refusals, bad modes and a missing key clearly', async () => {
    claudeReply = message(null, 'refusal');
    expect((await call('/api/assistant/draft', { method: 'POST', token: 'good', body: JSON.stringify({ thread, instruction: 'x', recipientFirstName: 'Maya' }) })).status).toBe(422);
    expect((await call('/api/assistant/rewrite', { method: 'POST', token: 'good', body: JSON.stringify({ text: 'x', mode: 'pirate' }) })).status).toBe(400);
    env.ANTHROPIC_API_KEY = undefined;
    expect((await call('/api/assistant/insight', { method: 'POST', token: 'good', body: JSON.stringify({ thread }) })).status).toBe(503);
  });
});

const post = (path: string, token: string, body: unknown) => call(path, { method: 'POST', token, headers: { Origin: ORIGIN }, body: JSON.stringify(body) });

describe('members administration', () => {
  it('makes SUPER_ADMINS super admins who cannot be suspended', async () => {
    expect(await (await call('/api/session', { token: 'boss' })).json()).toMatchObject({ user: { role: 'super_admin' } });
    (env.DB as unknown as { exec: (s: string) => void }).exec(`INSERT INTO members (email, name, status, created_at) VALUES ('boss@axal.vc', '', 'suspended', 0)`);
    clearAuthCache();
    expect((await call('/api/session', { token: 'boss' })).status).toBe(200);
  });

  it('keeps members out', async () => {
    expect((await call('/api/admin/members', { token: 'good' })).status).toBe(403);
    expect((await call('/api/admin/mailboxes', { token: 'good' })).status).toBe(403);
  });

  it('lets the super admin grant admin, and admins manage members but not roles', async () => {
    const list = await (await call('/api/admin/members', { token: 'boss' })).json() as { members: { email: string; role: string }[] };
    expect(list.members).toEqual([expect.objectContaining({ email: 'boss@axal.vc', role: 'super_admin' })]);

    expect(await (await post('/api/admin/members', 'boss', { email: 'Ada@axal.vc', name: 'Ada Lovelace', role: 'admin' })).json())
      .toMatchObject({ member: { email: 'ada@axal.vc', role: 'admin', status: 'active' } });
    clearAuthCache();
    expect(await (await call('/api/session', { token: 'ada' })).json()).toMatchObject({ user: { role: 'admin', name: 'Ada Lovelace' } });

    // Admin: adds and suspends members, links accounts...
    expect((await post('/api/admin/members', 'ada', { email: 'julian@axal.vc', name: 'Julian Park' })).status).toBe(200);
    expect((await post('/api/admin/links', 'ada', { googleEmail: 'julian.park@gmail.com', memberEmail: 'julian@axal.vc' })).status).toBe(200);
    expect(await (await call('/api/session', { token: 'personal' })).json()).toMatchObject({ user: { memberEmail: 'julian@axal.vc' } });
    expect((await post('/api/admin/members', 'ada', { email: 'julian@axal.vc', status: 'suspended' })).status).toBe(200);
    expect(await (await call('/api/session', { token: 'personal' })).json()).toMatchObject({ code: 'suspended' });

    // ...but can't grant roles, touch the super admin, or change themselves.
    expect((await post('/api/admin/members', 'ada', { email: 'julian@axal.vc', role: 'admin' })).status).toBe(403);
    expect((await post('/api/admin/members', 'ada', { email: 'boss@axal.vc', status: 'suspended' })).status).toBe(403);
    expect((await post('/api/admin/members', 'ada', { email: 'ada@axal.vc', role: 'member' })).status).toBe(403);
    expect((await post('/api/admin/members', 'boss', { email: 'boss@axal.vc', role: 'member' })).status).toBe(403);
    expect((await call('/api/admin/mailboxes', { token: 'ada' })).status).toBe(403);
  });

  it('validates members and links', async () => {
    expect((await post('/api/admin/members', 'boss', { email: 'someone@gmail.com' })).status).toBe(400);
    expect((await post('/api/admin/links', 'boss', { googleEmail: 'julian@axal.vc', memberEmail: 'julian@axal.vc' })).status).toBe(400);
    expect((await post('/api/admin/members', 'boss', { email: 'x@axal.vc', role: 'owner' })).status).toBe(400);
  });

  it('unlinks accounts', async () => {
    await post('/api/admin/links', 'boss', { googleEmail: 'julian.park@gmail.com', memberEmail: 'julian@axal.vc' });
    expect((await call('/api/admin/links?googleEmail=julian.park%40gmail.com', { method: 'DELETE', token: 'boss', headers: { Origin: ORIGIN } })).status).toBe(200);
    expect(await (await call('/api/session', { token: 'personal' })).json()).toMatchObject({ code: 'not_linked' });
  });
});

describe('shared mailboxes', () => {
  it('reports when delegation is not set up', async () => {
    expect(await (await call('/api/mailboxes', { token: 'good' })).json()).toEqual({ enabled: false, mailboxes: [] });
    expect((await post('/api/admin/mailboxes', 'boss', { mailbox: 'deals@axal.vc', memberEmail: 'julian@axal.vc' })).status).toBe(503);
  });

  it('opens a granted mailbox through the proxy with a delegated token', async () => {
    env.GOOGLE_SERVICE_ACCOUNT = serviceAccountJson;
    const g = await post('/api/admin/mailboxes', 'boss', { mailbox: 'Deals@axal.vc', memberEmail: 'julian@axal.vc' });
    expect(await g.json()).toEqual({ enabled: true, refreshTokenMailbox: null, mailboxes: [{ mailbox: 'deals@axal.vc', members: ['julian@axal.vc'] }] });
    expect(gmailCalls[0]).toMatchObject({ url: '/gmail/v1/users/me/profile', auth: 'Bearer dwd:deals@axal.vc' });

    expect(await (await call('/api/mailboxes', { token: 'good' })).json()).toEqual({ enabled: true, mailboxes: ['deals@axal.vc'] });
    expect(await (await call('/api/mailboxes', { token: 'priya' })).json()).toEqual({ enabled: true, mailboxes: [] });

    const list = await call('/api/mailboxes/deals%40axal.vc/gmail/v1/users/me/threads?labelIds=INBOX', { token: 'good' });
    expect(list.status).toBe(200);
    expect(gmailCalls.at(-1)).toMatchObject({ url: '/gmail/v1/users/me/threads?labelIds=INBOX', method: 'GET', auth: 'Bearer dwd:deals@axal.vc' });

    const send = await call('/api/mailboxes/deals%40axal.vc/upload/gmail/v1/users/me/messages/send?uploadType=multipart',
      { method: 'POST', token: 'good', headers: { Origin: ORIGIN, 'Content-Type': 'multipart/related; boundary=b' }, body: '--b--' });
    expect(send.status).toBe(200);
    expect(gmailCalls.at(-1)).toMatchObject({ url: '/upload/gmail/v1/users/me/messages/send?uploadType=multipart', method: 'POST', body: '--b--' });
  });

  it('refuses members without access and operations outside the mail client', async () => {
    env.GOOGLE_SERVICE_ACCOUNT = serviceAccountJson;
    await post('/api/admin/mailboxes', 'boss', { mailbox: 'deals@axal.vc', memberEmail: 'julian@axal.vc' });
    const n = gmailCalls.length;
    expect((await call('/api/mailboxes/deals%40axal.vc/gmail/v1/users/me/threads', { token: 'priya' })).status).toBe(403);
    expect((await call('/api/mailboxes/deals%40axal.vc/gmail/v1/users/me/settings/forwardingAddresses', { token: 'good' })).status).toBe(403);
    expect((await call('/api/mailboxes/deals%40axal.vc/gmail/v1/users/me/messages/abc', { method: 'DELETE', token: 'good', headers: { Origin: ORIGIN } })).status).toBe(403);
    expect((await call('/api/mailboxes/ceo%40axal.vc/gmail/v1/users/me/threads', { token: 'good' })).status).toBe(403);
    expect((await call('/api/mailboxes/x%40gmail.com/gmail/v1/users/me/threads', { token: 'good' })).status).toBe(400);
    expect(gmailCalls.length).toBe(n);

    await call('/api/admin/mailboxes?mailbox=deals%40axal.vc&memberEmail=julian%40axal.vc', { method: 'DELETE', token: 'boss', headers: { Origin: ORIGIN } });
    expect((await call('/api/mailboxes/deals%40axal.vc/gmail/v1/users/me/threads', { token: 'good' })).status).toBe(403);
  });

  it('accepts GMAIL_CLIENT_ID as the client ID', async () => {
    env.GOOGLE_CLIENT_ID = undefined;
    env.GMAIL_CLIENT_ID = 'client-1';
    expect(await (await call('/api/config')).json()).toMatchObject({ googleClientId: 'client-1' });
    expect((await call('/api/session', { token: 'good' })).status).toBe(200);
  });

  it('shares the mailbox behind GMAIL_REFRESH_TOKEN without a service account', async () => {
    env.GMAIL_REFRESH_TOKEN = 'rt-ir';
    env.GMAIL_CLIENT_SECRET = 'shh';
    expect(await (await call('/api/admin/mailboxes', { token: 'boss' })).json()).toMatchObject({ enabled: true, refreshTokenMailbox: 'ir@axal.vc' });
    expect((await post('/api/admin/mailboxes', 'boss', { mailbox: 'deals@axal.vc', memberEmail: 'julian@axal.vc' })).status).toBe(400);
    expect((await post('/api/admin/mailboxes', 'boss', { mailbox: 'ir@axal.vc', memberEmail: 'julian@axal.vc' })).status).toBe(200);
    expect((await call('/api/mailboxes/ir%40axal.vc/gmail/v1/users/me/threads', { token: 'good' })).status).toBe(200);
    expect(gmailCalls.at(-1)).toMatchObject({ url: '/gmail/v1/users/me/threads', auth: 'Bearer dwd:ir@axal.vc' });
  });

  it('reports a rejected GMAIL_REFRESH_TOKEN', async () => {
    env.GMAIL_REFRESH_TOKEN = 'revoked';
    env.GMAIL_CLIENT_SECRET = 'shh';
    expect(await (await call('/api/admin/mailboxes', { token: 'boss' })).json()).toMatchObject({ enabled: true, refreshTokenMailbox: null });
    const r = await post('/api/admin/mailboxes', 'boss', { mailbox: 'ir@axal.vc', memberEmail: 'julian@axal.vc' });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain('rejected');
  });

  it('explains a missing domain-wide delegation grant', async () => {
    env.GOOGLE_SERVICE_ACCOUNT = serviceAccountJson;
    delegationError = 'unauthorized_client';
    const r = await post('/api/admin/mailboxes', 'boss', { mailbox: 'deals@axal.vc', memberEmail: 'julian@axal.vc' });
    expect(r.status).toBe(502);
    expect((await r.json() as { error: string }).error).toContain('Domain-wide delegation');
  });
});

describe('bug reports', () => {
  const report = { title: 'Attachments fail for julian@axal.vc', description: 'Forward from maya@n.example, then download.', context: { view: 'inbox', path: '/', build: 'abc1234', userAgent: 'UA|x', viewport: '1280×800', errors: ['Unhandled: boom for ceo@axal.vc'] } };

  it('is off without a GitHub token', async () => {
    expect((await post('/api/bug-report', 'good', report)).status).toBe(503);
  });

  it('files a public issue with addresses removed and keeps the reporter in D1', async () => {
    env.GITHUB_TOKEN = 'ghp_test';
    expect(await (await call('/api/config')).json()).toMatchObject({ bugReports: true });
    const r = await post('/api/bug-report', 'good', report);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ number: 42, url: 'https://github.com/AxalNetwork/mail/issues/42' });
    const c = githubCalls[0];
    expect(c.url).toBe('/repos/AxalNetwork/mail/issues');
    expect(c.auth).toBe('Bearer ghp_test');
    expect(c.body.labels).toEqual(['bug']);
    const all = JSON.stringify(c.body);
    expect(all).not.toMatch(/@axal\.vc|@n\.example/);
    expect(c.body.title).toBe('Attachments fail for [email removed]');
    expect(String(c.body.body)).toContain('`abc1234`');
    expect(String(c.body.body)).toContain('UA x');
    const row = await env.DB.prepare('SELECT issue_number, member_email FROM bug_reports').first();
    expect(row).toEqual({ issue_number: 42, member_email: 'julian@axal.vc' });
  });

  it('retries without the label, reports GitHub failures, and limits volume', async () => {
    env.GITHUB_TOKEN = 'ghp_test';
    githubStatus = [422];
    expect((await post('/api/bug-report', 'good', report)).status).toBe(201);
    expect(githubCalls.map(c => c.body.labels)).toEqual([['bug'], []]);

    githubStatus = [401];
    const bad = await post('/api/bug-report', 'good', report);
    expect(bad.status).toBe(502);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bug_reports').first())).toEqual({ n: 1 });

    expect((await post('/api/bug-report', 'good', { title: 'x' })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await post('/api/bug-report', 'good', report)).status).toBe(201);
    expect((await post('/api/bug-report', 'good', report)).status).toBe(429);
  });
});

describe('deliverability', () => {
  it('grades SPF, DKIM, DMARC and MX for the organization domain only', async () => {
    const r = await call('/api/analytics/deliverability', { token: 'good' });
    expect(r.status).toBe(200);
    const j = await r.json() as { domain: string; checks: { key: string; level: string; summary: string }[] };
    expect(j.domain).toBe('axal.vc');
    expect(Object.fromEntries(j.checks.map(c => [c.key, c.level]))).toEqual({ mx: 'good', spf: 'good', dkim: 'good', dmarc: 'warning' });
    expect(j.checks.find(c => c.key === 'dmarc')!.summary).toContain('monitor only');
    expect((await call('/api/analytics/deliverability?domain=evil.example', { token: 'good' })).status).toBe(400);
    expect((await call('/api/analytics/deliverability')).status).toBe(401);
  });
});

describe('outreach sequences', () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
  const DAY = 86_400_000;
  const seq = {
    name: 'Fund II LPs',
    signatureHtml: '<table><tr><td>Julian Park</td></tr></table>', signatureText: 'Julian Park\nManaging Partner',
    steps: [
      { subject: 'Axal VC Fund II, {first_name}', body: 'Hi {first_name},\n\n{opening}We are raising Fund II.' },
      { delayDays: 3, subject: '', body: 'Hi {first_name}, following up on my note.' }
    ],
    recipients: [
      { email: 'Lena@Kestrel.example', firstName: 'Lena', company: 'Kestrel', context: 'our call in May' },
      { email: 'omar@harbor.example', firstName: 'Omar' }
    ]
  };
  const put = (path: string, token: string, body: unknown) => call(path, { method: 'PUT', token, headers: { Origin: ORIGIN }, body: JSON.stringify(body) });
  type Seq = { id: number; status: string; version: number; approved: unknown; lastError: string | null; recipients: { id: number; email: string; status: string; nextStep: number; lastError: string | null }[] };
  const get = async (id: number) => ((await (await call('/api/sequences/' + id, { token: 'good' })).json()) as { sequence: Seq }).sequence;

  beforeEach(() => {
    env.TOKEN_ENCRYPTION_KEY = KEY;
    env.GOOGLE_CLIENT_SECRET = 'shh';
  });

  async function connectedApprovedStarted(): Promise<Seq> {
    expect((await post('/api/sequences/sender', 'good', { code: 'good-code' })).status).toBe(200);
    const created = ((await (await post('/api/sequences', 'good', seq)).json()) as { sequence: Seq }).sequence;
    expect((await post('/api/sequences/' + created.id + '/approve', 'boss', { version: created.version })).status).toBe(200);
    const started = await post('/api/sequences/' + created.id + '/start', 'good', {});
    expect(started.status).toBe(200);
    return ((await started.json()) as { sequence: Seq }).sequence;
  }

  it('connects sending with an encrypted refresh token for the signed-in account only', async () => {
    expect(await (await call('/api/sequences/sender', { token: 'good' })).json()).toMatchObject({ sender: { connected: false, canConnect: true } });
    expect((await post('/api/sequences/sender', 'good', { code: 'bad' })).status).toBe(400);
    const r = await post('/api/sequences/sender', 'good', { code: 'good-code' });
    expect(await r.json()).toMatchObject({ sender: { connected: true, via: 'grant', googleEmail: 'julian@axal.vc' } });
    const row = await env.DB.prepare('SELECT refresh_token FROM sender_credentials').first<{ refresh_token: string }>();
    expect(row!.refresh_token).not.toContain('rt-julian');
    // A grant from another Google account is refused.
    expect((await post('/api/sequences/sender', 'priya', { code: 'good-code' })).status).toBe(403);
    expect(await (await call('/api/sequences/sender', { method: 'DELETE', token: 'good', headers: { Origin: ORIGIN } })).json()).toMatchObject({ sender: { connected: false } });
    env.TOKEN_ENCRYPTION_KEY = undefined;
    expect((await post('/api/sequences/sender', 'good', { code: 'good-code' })).status).toBe(503);
  });

  it('validates sequences', async () => {
    expect((await post('/api/sequences', 'good', { ...seq, steps: [] })).status).toBe(400);
    expect((await post('/api/sequences', 'good', { ...seq, steps: [seq.steps[0], { ...seq.steps[1], delayDays: 0 }] })).status).toBe(400);
    expect((await post('/api/sequences', 'good', { ...seq, recipients: [{ email: 'priya@axal.vc' }] })).status).toBe(400);
    expect((await post('/api/sequences', 'good', { ...seq, recipients: [{ email: 'a@x.example' }, { email: 'A@x.example' }] })).status).toBe(400);
    expect((await post('/api/sequences', 'good', { ...seq, steps: [{ subject: 'Hi {nickname}', body: 'x' }] })).status).toBe(400);
  });

  it('needs an admin approval of the current version before anything sends', async () => {
    await post('/api/sequences/sender', 'good', { code: 'good-code' });
    const s = ((await (await post('/api/sequences', 'good', seq)).json()) as { sequence: Seq }).sequence;
    expect(s.status).toBe('draft');
    expect((await post('/api/sequences/' + s.id + '/start', 'good', {})).status).toBe(409);
    expect((await post('/api/sequences/' + s.id + '/approve', 'good', { version: s.version })).status).toBe(403);
    expect((await post('/api/sequences/' + s.id + '/approve', 'boss', { version: s.version + 1 })).status).toBe(409);
    expect((await post('/api/sequences/' + s.id + '/approve', 'boss', { version: s.version })).status).toBe(200);
    // An edit after approval invalidates it.
    const edited = ((await (await put('/api/sequences/' + s.id, 'good', { ...seq, name: 'Fund II LPs v2' })).json()) as { sequence: Seq }).sequence;
    expect(edited).toMatchObject({ status: 'draft', approved: null, version: s.version + 1 });
    expect((await post('/api/sequences/' + s.id + '/start', 'good', {})).status).toBe(409);
    expect(await runDue(env)).toMatchObject({ sent: 0 });
    // Other members can't see it.
    expect((await call('/api/sequences/' + s.id, { token: 'ada' })).status).toBe(404);
  });

  it('sends step 1 once, then the follow-up as a reply in the same thread', async () => {
    const s = await connectedApprovedStarted();
    const t0 = Date.now() + 1000;
    expect(await runDue(env, t0)).toMatchObject({ sent: 2 });
    expect(await runDue(env, t0)).toMatchObject({ sent: 0 });
    expect(sends).toHaveLength(2);
    expect(sends[0].auth).toBe('Bearer at-julian');
    expect(sends[0].raw).toMatch(/To: "?Lena"? <lena@kestrel\.example>/);
    expect(sends[0].raw).toMatch(/Subject: (=\?UTF-8\?B\?[^?]+\?=|Axal VC Fund II, Lena)/);
    expect(sends[0].threadId).toBeUndefined();
    const lena = atob(sends[0].raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''));
    expect(lena).toContain('Following up on our call in May. We are raising Fund II.');
    expect(lena).toContain('unsubscribe');

    expect(await runDue(env, t0 + 2 * DAY)).toMatchObject({ sent: 0 });
    expect(await runDue(env, t0 + 3 * DAY + 1000)).toMatchObject({ sent: 2 });
    expect(sends[2].threadId).toBe('th1');
    expect(sends[2].raw).toContain('In-Reply-To: <msg1@mail.gmail.com>');
    expect(sends[2].raw).toMatch(/Subject: (Re: |=\?UTF-8)/);
    const done = await get(s.id);
    expect(done.status).toBe('completed');
    expect(done.recipients.every(r => r.status === 'completed')).toBe(true);
  });

  it('stops a recipient who replied, bounced or asked to unsubscribe', async () => {
    const s = await connectedApprovedStarted();
    const t0 = Date.now() + 1000;
    await runDue(env, t0);
    threads.th1 = [{ id: 'r1', threadId: 'th1', internalDate: String(t0 + DAY), snippet: 'Please unsubscribe me', payload: { headers: [{ name: 'From', value: 'Lena <lena@kestrel.example>' }] } }];
    threads.th2 = [{ id: 'r2', threadId: 'th2', internalDate: String(t0 + DAY), snippet: 'Happy to talk Tuesday', payload: { headers: [{ name: 'From', value: 'omar@harbor.example' }] } }];
    expect(await runDue(env, t0 + 4 * DAY)).toMatchObject({ sent: 0, stopped: 2 });
    const r = await get(s.id);
    expect(Object.fromEntries(r.recipients.map(x => [x.email, x.status]))).toEqual({ 'lena@kestrel.example': 'opted_out', 'omar@harbor.example': 'replied' });
    expect(await env.DB.prepare('SELECT email FROM opt_outs').first()).toEqual({ email: 'lena@kestrel.example' });
  });

  it('retries when Gmail is busy, but never resends a send whose outcome is unknown', async () => {
    const s = await connectedApprovedStarted();
    const t0 = Date.now() + 1000;
    sendMode = ['500', 'throw'];
    expect(await runDue(env, t0)).toMatchObject({ sent: 0, failed: 2 });
    let r = await get(s.id);
    const lena = r.recipients.find(x => x.email === 'lena@kestrel.example')!;
    const omar = r.recipients.find(x => x.email === 'omar@harbor.example')!;
    expect(lena).toMatchObject({ status: 'active', nextStep: 0 });
    expect(lena.lastError).toContain('Will retry');
    expect(omar.status).toBe('failed');
    expect(omar.lastError).toContain('Check Sent mail');
    expect(await runDue(env, t0 + 60_000)).toMatchObject({ sent: 1 });
    r = await get(s.id);
    expect(sends.map(x => x.raw.includes('lena@kestrel.example'))).toEqual([true]);
  });

  it('pauses the sequence when the sending grant is revoked', async () => {
    const s = await connectedApprovedStarted();
    clearSenderCache();
    revokedGrant = true;
    expect(await runDue(env, Date.now() + 1000)).toMatchObject({ paused: 1, sent: 0 });
    const r = await get(s.id);
    expect(r.status).toBe('paused');
    expect(r.lastError).toContain('Connect sending again');
  });

  it('lets the owner stop one recipient and opt them out everywhere', async () => {
    const s = await connectedApprovedStarted();
    const lena = s.recipients.find(x => x.email === 'lena@kestrel.example')!;
    expect((await post('/api/sequences/' + s.id + '/recipients/' + lena.id + '/stop', 'ada', { optOut: true })).status).toBe(404);
    await post('/api/sequences/' + s.id + '/recipients/' + lena.id + '/stop', 'good', { optOut: true });
    expect(await runDue(env, Date.now() + 1000)).toMatchObject({ sent: 1 });
    expect(sends[0].raw).toContain('omar@harbor.example');
  });
});
