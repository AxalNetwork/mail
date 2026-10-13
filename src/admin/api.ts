export type Role = 'member' | 'admin' | 'super_admin';

export interface Member {
  email: string;
  name: string;
  status: 'active' | 'suspended';
  role: Role;
  linked: string[];
}

export interface Me {
  email: string;
  memberEmail: string;
  name: string;
  role: Role;
}

export interface MemberChange {
  email: string;
  name?: string;
  status?: 'active' | 'suspended';
  role?: 'member' | 'admin';
}

export interface MailboxGrants {
  /** Domain-wide delegation is configured on the backend. */
  enabled: boolean;
  /** The mailbox the Worker's GMAIL_REFRESH_TOKEN opens, if any. */
  refreshTokenMailbox?: string | null;
  /** `readOnly`: members who may read and draft but not send as the mailbox. */
  mailboxes: { mailbox: string; members: string[]; readOnly?: string[] }[];
}

/** Members, linked accounts and shared mailbox access (backend /api/admin/*). */
export interface AdminApi {
  members(): Promise<{ members: Member[]; you: Me }>;
  saveMember(m: MemberChange): Promise<Member>;
  link(googleEmail: string, memberEmail: string): Promise<Member>;
  unlink(googleEmail: string): Promise<void>;
  /** Super admins only. */
  mailboxes(): Promise<MailboxGrants>;
  /** Give access, or change whether an existing member may send (`canSend`, default true). */
  grantMailbox(mailbox: string, memberEmail: string, canSend?: boolean): Promise<MailboxGrants>;
  revokeMailbox(mailbox: string, memberEmail: string): Promise<MailboxGrants>;
}

export class HttpAdminApi implements AdminApi {
  constructor(private base: string, private token: () => Promise<string>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(this.base + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
    return j;
  }

  members() {
    return this.call<{ members: Member[]; you: Me }>('/members');
  }
  async saveMember(m: MemberChange) {
    return (await this.call<{ member: Member }>('/members', { method: 'POST', body: JSON.stringify(m) })).member;
  }
  async link(googleEmail: string, memberEmail: string) {
    return (await this.call<{ member: Member }>('/links', { method: 'POST', body: JSON.stringify({ googleEmail, memberEmail }) })).member;
  }
  async unlink(googleEmail: string) {
    await this.call('/links?googleEmail=' + encodeURIComponent(googleEmail), { method: 'DELETE' });
  }
  mailboxes() {
    return this.call<MailboxGrants>('/mailboxes');
  }
  grantMailbox(mailbox: string, memberEmail: string, canSend = true) {
    return this.call<MailboxGrants>('/mailboxes', { method: 'POST', body: JSON.stringify({ mailbox, memberEmail, canSend }) });
  }
  revokeMailbox(mailbox: string, memberEmail: string) {
    return this.call<MailboxGrants>('/mailboxes?mailbox=' + encodeURIComponent(mailbox) + '&memberEmail=' + encodeURIComponent(memberEmail), { method: 'DELETE' });
  }
}

export const ROLE_LABEL: Record<Role, string> = { member: 'Member', admin: 'Admin', super_admin: 'Super admin' };

/** In-memory stand-in for the demo deployment. */
export class DemoAdminApi implements AdminApi {
  private list: Member[] = [
    { email: 'julian.park@axal.vc', name: 'Julian Park', status: 'active', role: 'super_admin', linked: [] },
    { email: 'priya.natarajan@axal.vc', name: 'Priya Natarajan', status: 'active', role: 'admin', linked: [] },
    { email: 'marcus.webb@axal.vc', name: 'Marcus Webb', status: 'active', role: 'member', linked: ['marcus.webb@gmail.com'] },
    { email: 'samira.okafor@axal.vc', name: 'Samira Okafor', status: 'suspended', role: 'member', linked: [] }
  ];
  private grants: MailboxGrants = { enabled: true, mailboxes: [{ mailbox: 'deals@axal.vc', members: ['julian.park@axal.vc', 'priya.natarajan@axal.vc'] }] };
  private you: Me = { email: 'julian.park@axal.vc', memberEmail: 'julian.park@axal.vc', name: 'Julian Park', role: 'super_admin' };

  async members() { return { members: this.list.map(m => ({ ...m, linked: [...m.linked] })), you: this.you }; }
  async saveMember(c: MemberChange) {
    const cur = this.list.find(m => m.email === c.email);
    const next: Member = { email: c.email, name: c.name ?? cur?.name ?? '', status: c.status ?? cur?.status ?? 'active', role: c.role ?? cur?.role ?? 'member', linked: cur?.linked ?? [] };
    this.list = cur ? this.list.map(m => (m.email === c.email ? next : m)) : [...this.list, next];
    return next;
  }
  async link(googleEmail: string, memberEmail: string) {
    if (!this.list.some(m => m.email === memberEmail)) await this.saveMember({ email: memberEmail });
    this.list = this.list.map(m => ({ ...m, linked: m.email === memberEmail ? [...m.linked.filter(x => x !== googleEmail), googleEmail] : m.linked.filter(x => x !== googleEmail) }));
    return this.list.find(m => m.email === memberEmail)!;
  }
  async unlink(googleEmail: string) { this.list = this.list.map(m => ({ ...m, linked: m.linked.filter(x => x !== googleEmail) })); }
  async mailboxes() { return structuredClone(this.grants); }
  async grantMailbox(mailbox: string, memberEmail: string, canSend = true) {
    let g = this.grants.mailboxes.find(x => x.mailbox === mailbox);
    if (!g) this.grants.mailboxes.push(g = { mailbox, members: [], readOnly: [] });
    if (!g.members.includes(memberEmail)) g.members.push(memberEmail);
    g.readOnly = (g.readOnly || []).filter(x => x !== memberEmail).concat(canSend ? [] : [memberEmail]);
    return this.mailboxes();
  }
  async revokeMailbox(mailbox: string, memberEmail: string) {
    this.grants.mailboxes = this.grants.mailboxes.map(g => (g.mailbox === mailbox ? { ...g, members: g.members.filter(x => x !== memberEmail) } : g)).filter(g => g.members.length);
    return this.mailboxes();
  }
}
