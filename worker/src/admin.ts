import type { Env } from './env';
import { allowedDomains, clearAuthCache, superAdmins, type Role, type User } from './auth';
import { HttpError, json, readJson } from './http';

export interface MemberRow {
  email: string;
  name: string;
  status: 'active' | 'suspended';
  role: Role;
  /** Personal Google accounts that sign in as this member. */
  linked: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(v: unknown, what: string): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, what + ' must be an email address');
  return e;
}

const onDomain = (env: Env, e: string) => allowedDomains(env).includes(e.split('@')[1]);

/**
 * Everyone who can sign in or has been configured: rows in `members`, plus the
 * super admins from the Worker configuration even before they have a row.
 */
export async function listMembers(env: Env): Promise<MemberRow[]> {
  const rows = (await env.DB.prepare('SELECT email, name, status, role FROM members ORDER BY email').all<{ email: string; name: string; status: string; role: string }>()).results;
  const links = (await env.DB.prepare('SELECT google_email, member_email FROM linked_accounts ORDER BY google_email').all<{ google_email: string; member_email: string }>()).results;
  const supers = superAdmins(env);
  const out = new Map<string, MemberRow>();
  for (const e of supers) out.set(e, { email: e, name: '', status: 'active', role: 'super_admin', linked: [] });
  for (const r of rows) {
    const sup = supers.includes(r.email);
    out.set(r.email, {
      email: r.email,
      name: r.name,
      status: sup ? 'active' : r.status === 'suspended' ? 'suspended' : 'active',
      role: sup ? 'super_admin' : r.role === 'admin' ? 'admin' : 'member',
      linked: []
    });
  }
  for (const l of links) out.get(l.member_email)?.linked.push(l.google_email);
  return [...out.values()].sort((a, b) => a.email.localeCompare(b.email));
}

interface MemberInput {
  email?: unknown;
  name?: unknown;
  status?: unknown;
  role?: unknown;
}

/**
 * Add or change a member. Admins add members, rename them and suspend members;
 * only super admins grant or revoke admin, or suspend an admin. Nobody changes
 * their own role or status, and super admins (configuration) can't be changed here.
 */
async function saveMember(env: Env, actor: User, body: MemberInput): Promise<MemberRow> {
  const target = email(body.email, 'Member email');
  if (!onDomain(env, target)) {
    throw new HttpError(400, 'Members use an @' + allowedDomains(env).join(' / @') + ' address. Link personal Google accounts to a member instead.');
  }
  const current = (await listMembers(env)).find(m => m.email === target);
  const name = body.name === undefined ? current?.name ?? '' : String(body.name).trim().slice(0, 120);
  const status = body.status === undefined ? current?.status ?? 'active' : body.status;
  const role = body.role === undefined ? (current?.role === 'admin' ? 'admin' : 'member') : body.role;
  if (status !== 'active' && status !== 'suspended') throw new HttpError(400, 'Status must be active or suspended');
  if (role !== 'member' && role !== 'admin') throw new HttpError(400, 'Role must be member or admin');

  const roleChanged = role !== (current?.role === 'admin' ? 'admin' : 'member');
  const statusChanged = status !== (current?.status ?? 'active');
  if (current?.role === 'super_admin' && (body.role !== undefined || body.status !== undefined)) {
    throw new HttpError(403, 'Super admins are set in the Worker configuration (SUPER_ADMINS), not here.');
  }
  if (target === actor.memberEmail && (roleChanged || statusChanged)) throw new HttpError(403, "You can't change your own role or status.");
  if (roleChanged && actor.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can grant or revoke admin.');
  if (statusChanged && current?.role === 'admin' && actor.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can suspend an admin.');

  await env.DB
    .prepare(`INSERT INTO members (email, name, status, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (email) DO UPDATE SET name = excluded.name, status = excluded.status, role = excluded.role`)
    .bind(target, name, status, role, Date.now())
    .run();
  clearAuthCache();
  return (await listMembers(env)).find(m => m.email === target)!;
}

/** Let a personal Google account sign in as a member (creating the member row if needed). */
async function link(env: Env, actor: User, body: { googleEmail?: unknown; memberEmail?: unknown }): Promise<MemberRow> {
  const google = email(body.googleEmail, 'Google account');
  const member = email(body.memberEmail, 'Member email');
  if (onDomain(env, google)) throw new HttpError(400, google + ' signs in directly; only accounts outside @' + allowedDomains(env)[0] + ' need linking.');
  if (!onDomain(env, member)) throw new HttpError(400, 'Link to an @' + allowedDomains(env)[0] + ' member.');
  const existing = (await listMembers(env)).find(m => m.email === member);
  if (existing?.role === 'admin' || existing?.role === 'super_admin') {
    if (actor.role !== 'super_admin' && member !== actor.memberEmail) throw new HttpError(403, 'Only a super admin can link accounts to another admin.');
  }
  await env.DB
    .prepare(`INSERT INTO members (email, name, status, role, created_at) VALUES (?1, '', 'active', 'member', ?2) ON CONFLICT (email) DO NOTHING`)
    .bind(member, Date.now())
    .run();
  await env.DB
    .prepare(`INSERT INTO linked_accounts (google_email, member_email, created_at) VALUES (?1, ?2, ?3)
              ON CONFLICT (google_email) DO UPDATE SET member_email = excluded.member_email`)
    .bind(google, member, Date.now())
    .run();
  clearAuthCache();
  return (await listMembers(env)).find(m => m.email === member)!;
}

async function unlink(env: Env, actor: User, googleEmail: unknown): Promise<void> {
  const google = email(googleEmail, 'Google account');
  const owner = (await listMembers(env)).find(m => m.linked.includes(google));
  if (owner && owner.role !== 'member' && actor.role !== 'super_admin' && owner.email !== actor.memberEmail) {
    throw new HttpError(403, "Only a super admin can unlink another admin's accounts.");
  }
  await env.DB.prepare('DELETE FROM linked_accounts WHERE google_email = ?1').bind(google).run();
  clearAuthCache();
}

/** /api/admin/* — members and linked accounts, for admins and super admins. */
export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (user.role === 'member') throw new HttpError(403, 'Only administrators can manage members.', 'forbidden');
  const path = url.pathname.slice('/api/admin/'.length);
  const method = req.method;
  if (path === 'members' && method === 'GET') return json({ members: await listMembers(env), you: user });
  if (path === 'members' && method === 'POST') return json({ member: await saveMember(env, user, await readJson(req)) });
  if (path === 'links' && method === 'POST') return json({ member: await link(env, user, await readJson(req)) });
  if (path === 'links' && method === 'DELETE') {
    await unlink(env, user, url.searchParams.get('googleEmail'));
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found');
}
