import type { Env } from './env';
import { allowedDomains, authenticate } from './auth';
import { HttpError, errorResponse, json, readJson } from './http';
import { addNote, listNotes } from './notes';
import * as assistant from './assistant';

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
        googleClientId: env.GOOGLE_CLIENT_ID || '',
        orgDomain: env.ORG_DOMAIN || allowedDomains(env)[0] || '',
        assistant: !!env.ANTHROPIC_API_KEY,
        notes: !!env.DB,
        session: !!env.DB
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
    if (method === 'GET') return json({ notes: await listNotes(env.DB, url.searchParams.get('key')) });
    if (method === 'POST') return json({ note: await addNote(env.DB, user, await readJson(req)) }, 201);
  }

  if (method === 'POST' && path.startsWith('/api/assistant/')) {
    const action = path.slice('/api/assistant/'.length);
    switch (action) {
      case 'insight': return json(await assistant.insight(env, user, await readJson(req)));
      case 'draft': return json(await assistant.draft(env, user, await readJson(req)));
      case 'rewrite': return json(await assistant.rewrite(env, user, await readJson(req)));
      case 'persona': return json(await assistant.persona(env, user, await readJson(req)));
    }
  }

  throw new HttpError(404, 'Not found');
}
