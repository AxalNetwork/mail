import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json, readJson } from './http';

/** Dismissed automation suggestions, per member (D1 automation_dismissals). */

const KINDS = ['follow_up', 'reply', 'triage'] as const;
type Kind = typeof KINDS[number];
const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KINDS as readonly string[]).includes(k);
const KEEP_DAYS = 120;

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (url.pathname !== '/api/automations/dismissed') throw new HttpError(404, 'Not found');
  if (req.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT kind, item_key FROM automation_dismissals WHERE member_email = ?1 AND created_at > ?2')
      .bind(user.memberEmail, Date.now() - KEEP_DAYS * 86_400_000).all<{ kind: Kind; item_key: string }>()).results;
    const out: Record<Kind, string[]> = { follow_up: [], reply: [], triage: [] };
    for (const r of rows) out[r.kind].push(r.item_key);
    return json({ dismissed: out });
  }
  const body = await readJson<{ kind?: unknown; key?: unknown }>(req);
  if (!isKind(body.kind) || typeof body.key !== 'string' || !body.key || body.key.length > 200) throw new HttpError(400, 'kind and key are required');
  if (req.method === 'POST') {
    await env.DB.prepare('INSERT INTO automation_dismissals (member_email, kind, item_key, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING')
      .bind(user.memberEmail, body.kind, body.key, Date.now()).run();
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM automation_dismissals WHERE member_email = ?1 AND kind = ?2 AND item_key = ?3').bind(user.memberEmail, body.kind, body.key).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}
