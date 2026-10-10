import type { Env } from './env';

// Asset lookups per deployment (one ASSETS binding per isolate).
const built = new WeakMap<Fetcher, Promise<string>>();

/**
 * The OAuth client ID: the Worker variable, or else the value the frontend
 * build captured from the build environment (`dist/build-config.json`, written
 * by vite.config.ts). The second covers a client ID set as a Workers Builds
 * build variable instead of a runtime variable.
 */
export function googleClientId(env: Env): Promise<string> {
  if (env.GOOGLE_CLIENT_ID?.trim()) return Promise.resolve(env.GOOGLE_CLIENT_ID.trim());
  let p = built.get(env.ASSETS);
  if (!p) {
    p = env.ASSETS.fetch(new Request('https://assets.local/build-config.json'))
      .then(r => ((r.headers.get('Content-Type') || '').includes('json') ? r.json() : {}))
      .then(j => String((j as { googleClientId?: unknown }).googleClientId || '').trim())
      .catch(() => '');
    built.set(env.ASSETS, p);
  }
  return p;
}
