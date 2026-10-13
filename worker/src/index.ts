import type { Env } from './env';
import { allowedDomains, authenticate } from './auth';
import { HttpError, errorResponse, json, readJson } from './http';
import * as notes from './notes';
import * as automations from './automations';
import * as contacts from './contacts';
import * as shared from './shared';
import * as assistant from './assistant';
import * as admin from './admin';
import * as mailboxes from './mailboxes';
import { googleClientId } from './config';
import { bugReportsEnabled, fileBugReport } from './bugs';
import { deliverability } from './deliverability';
import * as sequences from './sequences';
import { connectSender, disconnectSender, senderStatus } from './senders';

export type { Env };

/**
 * One Worker serves both halves of Axal VC Mail:
 * - /api/*  the backend (config, assistant, shared notes), handled here;
 * - all other paths are the static frontend from dist/ (wrangler assets),
 *   which Cloudflare serves without invoking this code.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      return errorResponse(e);
    }
  },

  /** Cron (wrangler.jsonc triggers): send the outreach sequence steps that are due. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sequences.runDue(env).then(r => {
      if (r.sent || r.failed || r.paused) console.log('Outreach sequences:', JSON.stringify(r));
    }).catch(e => console.error('Outreach sequences run failed (is migration 0006 applied?)', e)));
  }
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/health' && method === 'GET') return json({ ok: true });

  // Public: lets the frontend boot without build-time configuration.
  if (path === '/api/config' && method === 'GET') {
    return json(
      {
        googleClientId: await googleClientId(env),
        orgDomain: env.ORG_DOMAIN || allowedDomains(env)[0] || '',
        assistant: !!env.ANTHROPIC_API_KEY,
        notes: !!env.DB,
        session: !!env.DB,
        bugReports: bugReportsEnabled(env)
      },
      200,
      { 'Cache-Control': 'public, max-age=60' }
    );
  }

  // State-changing requests must come from our own pages.
  if (method !== 'GET') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
  }

  const user = await authenticate(req, env);

  // Called by the sign-in screen right after Google returns a token.
  if (path === '/api/session' && method === 'GET') return json({ user });

  if (path === '/api/notes') {
    if (method === 'GET') return json({ notes: await notes.listNotes(env, user, url.searchParams.get('key')) });
    if (method === 'POST') return json({ note: await notes.addNote(env, user, await readJson(req)) }, 201);
  }
  const noteId = /^\/api\/notes\/(\d+)$/.exec(path);
  if (noteId) {
    if (method === 'PATCH') return json({ note: await notes.editNote(env, user, Number(noteId[1]), await readJson(req)) });
    if (method === 'DELETE') { await notes.deleteNote(env, user, Number(noteId[1])); return json({ ok: true }); }
  }
  if (path === '/api/notes/activity' && method === 'GET') return json({ activity: await notes.activity(env, url.searchParams.get('key')) });
  if (path === '/api/internal' && method === 'GET') return json(await notes.inbox(env, user));
  if (path === '/api/internal/read' && method === 'POST') { await notes.markRead(env, user, await readJson(req)); return json({ ok: true }); }
  if (path === '/api/internal/members' && method === 'GET') return json({ members: await notes.mentionable(env) });

  if (path.startsWith('/api/automations/')) return automations.route(req, env, user, url);
  if (path === '/api/contacts' || path.startsWith('/api/contacts/') || path === '/api/organizations' || path.startsWith('/api/organizations/')) return contacts.route(req, env, user, url);

  if (path === '/api/sequences/sender') {
    if (method === 'GET') return json({ sender: await senderStatus(env, user) });
    if (method === 'POST') return json({ sender: await connectSender(env, user, (await readJson<{ code?: unknown }>(req)).code) });
    if (method === 'DELETE') return json({ sender: await disconnectSender(env, user) });
  }
  if (path === '/api/sequences' || path.startsWith('/api/sequences/')) return sequences.route(req, env, user, url);

  if (path === '/api/analytics/deliverability' && method === 'GET') return json(await deliverability(env, url));
  if (path === '/api/bug-report' && method === 'POST') return json(await fileBugReport(env, user, await readJson(req)), 201);

  if (path === '/api/shared' || path.startsWith('/api/shared/')) return shared.route(req, env, user, url);
  if (path === '/api/mailboxes' && method === 'GET') return mailboxes.listForUser(env, user);
  if (path.startsWith('/api/mailboxes/')) return mailboxes.proxy(req, env, user, url);
  if (path === '/api/admin/mailboxes') return mailboxes.adminRoute(req, env, user, url);
  if (path.startsWith('/api/admin/')) return admin.route(req, env, user, url);

  if (method === 'POST' && path.startsWith('/api/assistant/')) {
    const action = path.slice('/api/assistant/'.length);
    switch (action) {
      case 'insight': return json(await assistant.insight(env, user, await readJson(req)));
      case 'draft': return json(await assistant.draft(env, user, await readJson(req)));
      case 'rewrite': return json(await assistant.rewrite(env, user, await readJson(req)));
      case 'persona': return json(await assistant.persona(env, user, await readJson(req)));
      case 'classify': return json(await assistant.classify(env, user, await readJson(req)));
      case 'briefing': return json(await assistant.briefing(env, user, await readJson(req)));
      case 'relationship': return json(await assistant.relationship(env, user, await readJson(req)));
    }
  }

  throw new HttpError(404, 'Not found');
}
