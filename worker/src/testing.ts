import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json } from './http';
import * as link from './studioLink';
import { noteLinkRead } from './newsletters';

/**
 * Product testing: programmes run by Axal VC and partners, read from StudioOS
 * over the Mail link. Programmes are created, approved and staffed in
 * StudioOS; Mail shows them and sends their emails (through approval, as
 * newsletters with the programme's uid).
 */

const unreadable = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e), code: e instanceof HttpError ? e.code || null : null });

export async function route(req: Request, env: Env, _user: User, url: URL): Promise<Response> {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  if (!link.linkConfigured(env)) return json({ configured: false, studioUrl: link.studioBase(env) + '/product-testing', programmes: [] });

  if (url.pathname === '/api/testing/programmes') {
    try {
      const programmes = await link.programmes(env);
      await noteLinkRead(env, { programmes: programmes.length });
      return json({ configured: true, studioUrl: link.studioBase(env) + '/product-testing', programmes });
    } catch (e) {
      return json({ configured: true, studioUrl: link.studioBase(env) + '/product-testing', programmes: [], ...unreadable(e) });
    }
  }

  const one = /^\/api\/testing\/programmes\/([\w-]{1,80})$/.exec(url.pathname);
  if (one) {
    try {
      const r = await link.applicants(env, one[1]);
      const programme = r.programme || (await link.programmes(env)).find(p => p.uid === one[1]) || null;
      if (!programme) throw new HttpError(404, 'Programme not found');
      return json({
        configured: true, programme,
        applicants: r.items.map(a => ({ ...a, email: '' })),
        // Only picked testers who consented come with an address (StudioOS's rule).
        testers: r.items.filter(a => a.status === 'picked').map(a => ({ uid: a.uid, name: a.name, role: a.role, email: a.consented ? a.email : '', pickedAt: a.pickedAt }))
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404 && e.message === 'Programme not found') throw e;
      return json({ configured: true, programme: null, applicants: [], testers: [], ...unreadable(e) });
    }
  }
  throw new HttpError(404, 'Not found');
}
