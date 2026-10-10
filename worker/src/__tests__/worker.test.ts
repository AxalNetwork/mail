// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../index';
import { clearAuthCache } from '../auth';
import type { Env } from '../env';

/** Minimal D1 over node:sqlite, enough for prepare/bind/all/first/run (+ exec for seeding). */
function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_notes.sql', '0002_members.sql']) {
    db.exec(readFileSync(fileURLToPath(new URL('../../migrations/' + f, import.meta.url).href), 'utf8'));
  }
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) { params = p; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(params as never[])) }; },
        async first() { return db.prepare(sql).get(...(params as never[])) ?? null; },
        async run() { const r = db.prepare(sql).run(...(params as never[])); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; }
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

function mockFetch(tokens: Record<string, Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === 'oauth2.googleapis.com') {
      const info = tokens[url.searchParams.get('access_token') || ''];
      return info ? Response.json(info) : Response.json({ error_description: 'Invalid Value' }, { status: 400 });
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

beforeEach(() => {
  clearAuthCache();
  anthropicCalls = [];
  env = {
    ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html>app')) } as unknown as Fetcher,
    DB: fakeD1(), GOOGLE_CLIENT_ID: 'client-1', ALLOWED_DOMAINS: 'axal.vc', ORG_DOMAIN: 'axal.vc', ANTHROPIC_API_KEY: 'sk-test'
  };
  mockFetch({
    good,
    other: { ...good, aud: 'someone-else' },
    outsider: { ...good, email: 'eve@evil.example' },
    personal: { ...good, email: 'julian.park@gmail.com' },
    priya: { ...good, email: 'priya@axal.vc' },
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
    expect(await r.json()).toEqual({ googleClientId: 'client-1', orgDomain: 'axal.vc', assistant: true, notes: true, session: true });
    env.ANTHROPIC_API_KEY = undefined;
    expect((await (await call('/api/config')).json() as { assistant: boolean }).assistant).toBe(false);
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
    expect(await (await call('/api/session', { token: 'personal' })).json()).toEqual({ user: { email: 'julian.park@gmail.com', memberEmail: 'julian@axal.vc', name: 'Julian Park' } });
    expect(await (await call('/api/session', { token: 'good' })).json()).toEqual({ user: { email: 'julian@axal.vc', memberEmail: 'julian@axal.vc', name: 'Julian Park' } });
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
