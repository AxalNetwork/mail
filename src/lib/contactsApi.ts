/** Client for the Worker's Contacts & Relationships API (/api/contacts, /api/organizations). */

export type Visibility = 'team' | 'private';

export interface ContactRecord {
  id: number; name: string; emails: string[]; title: string; organization: { id: number; name: string } | null;
  website: string; linkedin: string; tags: string[]; notes: string; owner: string; visibility: Visibility;
  createdBy: string; createdAt: number; updatedAt: number; archived: boolean; mergedInto: number | null; canShare: boolean;
}

export interface ContactInput {
  name: string; emails: string[]; title: string; organizationId: number | null; website: string; linkedin: string;
  tags: string[]; notes: string; owner: string; visibility: Visibility;
}

export interface OrgRecord {
  id: number; name: string; domain: string; website: string; type: string; tags: string[]; notes: string; owner: string;
  visibility: Visibility; createdBy: string; createdAt: number; updatedAt: number; archived: boolean; contactCount: number; canShare: boolean;
}

export interface OrgInput { name: string; domain: string; website: string; type: string; tags: string[]; notes: string; owner: string; visibility: Visibility }

export interface RelationshipEvent { id: number; kind: 'introduction' | 'meeting' | 'note'; text: string; occurredAt: number; createdBy: string; threadId: string; mine: boolean }

export interface ContactFilter { q?: string; tag?: string; org?: number; owner?: string; archived?: boolean }

/** A 409 that names the record already holding an address or name. */
export class DuplicateError extends Error {
  constructor(message: string, readonly code: string, readonly existingId?: number) { super(message); }
}

export const ORG_TYPES = ['Portfolio company', 'Prospect', 'LP / Investor', 'Co-investor', 'Service provider', 'Corporate', 'Other'];

export interface ContactsApi {
  list(f?: ContactFilter): Promise<ContactRecord[]>;
  get(id: number): Promise<{ contact: ContactRecord; events: RelationshipEvent[]; duplicates: ContactRecord[] }>;
  create(c: ContactInput): Promise<ContactRecord>;
  update(id: number, c: Partial<ContactInput>): Promise<ContactRecord>;
  archive(id: number, archived: boolean): Promise<ContactRecord>;
  merge(id: number, from: number): Promise<ContactRecord>;
  duplicates(): Promise<ContactRecord[][]>;
  addEvent(id: number, e: { kind: RelationshipEvent['kind']; text: string; threadId?: string; occurredAt?: number }): Promise<RelationshipEvent>;
  removeEvent(id: number, eventId: number): Promise<void>;
  orgs(f?: { q?: string; type?: string; archived?: boolean }): Promise<OrgRecord[]>;
  org(id: number): Promise<{ organization: OrgRecord; contacts: ContactRecord[] }>;
  createOrg(o: OrgInput): Promise<OrgRecord>;
  updateOrg(id: number, o: Partial<OrgInput> & { archived?: boolean }): Promise<OrgRecord>;
  members(): Promise<{ email: string; name: string }[]>;
}

export class HttpContactsApi implements ContactsApi {
  constructor(private token: () => Promise<string>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; existingId?: number };
    if (res.status === 409) throw new DuplicateError(j.error || 'Already exists', j.code || 'conflict', j.existingId);
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
    return j;
  }
  private send<T>(method: string, path: string, body: unknown) { return this.call<T>(path, { method, body: JSON.stringify(body) }); }

  async list(f: ContactFilter = {}) {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.tag) p.set('tag', f.tag);
    if (f.org) p.set('org', String(f.org));
    if (f.owner) p.set('owner', f.owner);
    if (f.archived) p.set('archived', '1');
    return (await this.call<{ contacts: ContactRecord[] }>('/api/contacts' + (String(p) ? '?' + p : ''))).contacts;
  }
  get(id: number) { return this.call<{ contact: ContactRecord; events: RelationshipEvent[]; duplicates: ContactRecord[] }>('/api/contacts/' + id); }
  async create(c: ContactInput) { return (await this.send<{ contact: ContactRecord }>('POST', '/api/contacts', c)).contact; }
  async update(id: number, c: Partial<ContactInput>) { return (await this.send<{ contact: ContactRecord }>('PATCH', '/api/contacts/' + id, c)).contact; }
  async archive(id: number, archived: boolean) { return (await this.send<{ contact: ContactRecord }>('POST', '/api/contacts/' + id + '/archive', { archived })).contact; }
  async merge(id: number, from: number) { return (await this.send<{ contact: ContactRecord }>('POST', '/api/contacts/' + id + '/merge', { from })).contact; }
  async duplicates() { return (await this.call<{ groups: ContactRecord[][] }>('/api/contacts/duplicates')).groups; }
  async addEvent(id: number, e: { kind: RelationshipEvent['kind']; text: string; threadId?: string; occurredAt?: number }) {
    return (await this.send<{ event: RelationshipEvent }>('POST', '/api/contacts/' + id + '/events', e)).event;
  }
  async removeEvent(id: number, eventId: number) { await this.call('/api/contacts/' + id + '/events/' + eventId, { method: 'DELETE' }); }
  async orgs(f: { q?: string; type?: string; archived?: boolean } = {}) {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.type) p.set('type', f.type);
    if (f.archived) p.set('archived', '1');
    return (await this.call<{ organizations: OrgRecord[] }>('/api/organizations' + (String(p) ? '?' + p : ''))).organizations;
  }
  org(id: number) { return this.call<{ organization: OrgRecord; contacts: ContactRecord[] }>('/api/organizations/' + id); }
  async createOrg(o: OrgInput) { return (await this.send<{ organization: OrgRecord }>('POST', '/api/organizations', o)).organization; }
  async updateOrg(id: number, o: Partial<OrgInput> & { archived?: boolean }) { return (await this.send<{ organization: OrgRecord }>('PATCH', '/api/organizations/' + id, o)).organization; }
  async members() { return (await this.call<{ members: { email: string; name: string }[] }>('/api/internal/members')).members; }
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

/** Contacts as CSV: what the list shows, notes included only when asked for. */
export function contactsCsv(list: ContactRecord[], withNotes = false): string {
  const head = ['Name', 'Emails', 'Title', 'Organization', 'Tags', 'Owner', 'Website', 'LinkedIn', ...(withNotes ? ['Notes'] : [])];
  const rows = list.map(c => [c.name, c.emails.join('; '), c.title, c.organization?.name || '', c.tags.join('; '), c.owner, c.website, c.linkedin, ...(withNotes ? [c.notes] : [])]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
