import { DuplicateError, type ContactInput, type ContactRecord, type ContactsApi, type OrgInput, type OrgRecord, type RelationshipEvent } from '../../lib/contactsApi';

/** In-memory ContactsApi for component tests (the Worker's rules are tested in worker.test.ts). */
export function fakeContactsApi(seed: { contacts?: Partial<ContactRecord>[]; orgs?: Partial<OrgRecord>[] } = {}) {
  let next = 100;
  const me = 'julian@axal.vc';
  const contacts: ContactRecord[] = (seed.contacts || []).map(c => ({
    id: next++, name: '', emails: [], title: '', organization: null, website: '', linkedin: '', tags: [], notes: '', owner: me, visibility: 'team',
    createdBy: me, createdAt: 0, updatedAt: 0, archived: false, mergedInto: null, canShare: true, ...c
  }));
  const orgs: OrgRecord[] = (seed.orgs || []).map(o => ({
    id: next++, name: '', domain: '', website: '', type: 'Other', tags: [], notes: '', owner: me, visibility: 'team', createdBy: me, createdAt: 0, updatedAt: 0,
    archived: false, contactCount: 0, canShare: true, ...o
  }));
  const events: (RelationshipEvent & { contactId: number })[] = [];
  const orgRef = (id: number | null) => { const o = orgs.find(x => x.id === id); return o ? { id: o.id, name: o.name } : null; };
  const find = (id: number) => { const c = contacts.find(x => x.id === id); if (!c) throw new Error('Contact not found'); return c; };
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const claim = (emails: string[], self: number | null) => {
    for (const e of emails) {
      const hit = contacts.find(c => !c.mergedInto && c.id !== self && c.emails.includes(e));
      if (hit) throw new DuplicateError(e + ' already belongs to another contact.', 'duplicate_email', hit.id);
    }
  };
  const apply = (c: ContactRecord, p: Partial<ContactInput>) => {
    const { organizationId, ...rest } = p;
    Object.assign(c, rest, organizationId !== undefined ? { organization: orgRef(organizationId) } : {}, { updatedAt: Date.now() });
    if (c.owner === '') c.owner = me;
  };

  const api: ContactsApi = {
    list: vi.fn(async f => contacts.filter(c => (f?.archived ? c.archived && !c.mergedInto : !c.archived)
      && (!f?.q || (c.name + ' ' + c.emails.join(' ')).toLowerCase().includes(f.q.toLowerCase()))
      && (!f?.tag || c.tags.includes(f.tag)) && (!f?.org || c.organization?.id === f.org) && (!f?.owner || c.owner === f.owner)).map(c => ({ ...c }))),
    get: vi.fn(async id => {
      const c = find(id);
      return { contact: { ...c }, events: events.filter(e => e.contactId === id), duplicates: contacts.filter(x => x.id !== id && !x.archived && key(x.name) === key(c.name)) };
    }),
    create: vi.fn(async (input: ContactInput) => {
      claim(input.emails, null);
      const c: ContactRecord = { id: next++, name: '', emails: [], title: '', organization: null, website: '', linkedin: '', tags: [], notes: '', owner: me, visibility: 'team', createdBy: me, createdAt: Date.now(), updatedAt: Date.now(), archived: false, mergedInto: null, canShare: true };
      apply(c, input);
      contacts.push(c);
      return { ...c };
    }),
    update: vi.fn(async (id, p) => { const c = find(id); if (p.emails) claim(p.emails, id); apply(c, p); return { ...c }; }),
    archive: vi.fn(async (id, archived) => { const c = find(id); c.archived = archived; return { ...c }; }),
    merge: vi.fn(async (id, from) => {
      const a = find(id), b = find(from);
      a.emails = [...a.emails, ...b.emails].sort();
      a.tags = [...new Set([...a.tags, ...b.tags])];
      b.archived = true; b.mergedInto = id;
      for (const e of events) if (e.contactId === from) e.contactId = id;
      return { ...a };
    }),
    duplicates: vi.fn(async () => {
      const groups = new Map<string, ContactRecord[]>();
      for (const c of contacts.filter(x => !x.archived)) groups.set(key(c.name), [...(groups.get(key(c.name)) || []), c]);
      return [...groups.values()].filter(g => g.length > 1);
    }),
    addEvent: vi.fn(async (id, e) => {
      const ev = { id: next++, contactId: id, kind: e.kind, text: e.text, threadId: e.threadId || '', occurredAt: e.occurredAt || Date.now(), createdBy: me, mine: true };
      events.push(ev);
      return ev;
    }),
    removeEvent: vi.fn(async (_id, eventId) => { events.splice(events.findIndex(e => e.id === eventId), 1); }),
    orgs: vi.fn(async () => orgs.filter(o => !o.archived).map(o => ({ ...o, contactCount: contacts.filter(c => !c.archived && c.organization?.id === o.id).length }))),
    org: vi.fn(async id => {
      const o = orgs.find(x => x.id === id)!;
      return { organization: { ...o }, contacts: contacts.filter(c => !c.archived && c.organization?.id === id) };
    }),
    createOrg: vi.fn(async (input: OrgInput) => {
      const dup = orgs.find(o => key(o.name) === key(input.name));
      if (dup) throw new DuplicateError(dup.name + ' already exists.', 'duplicate_org', dup.id);
      const o: OrgRecord = { id: next++, contactCount: 0, createdBy: me, createdAt: Date.now(), updatedAt: Date.now(), archived: false, canShare: true, ...input, owner: input.owner || me };
      orgs.push(o);
      return { ...o };
    }),
    updateOrg: vi.fn(async (id, p) => { const o = orgs.find(x => x.id === id)!; Object.assign(o, p); return { ...o }; }),
    members: vi.fn(async () => [{ email: me, name: 'Julian Park' }, { email: 'priya@axal.vc', name: 'Priya Natarajan' }])
  };
  return { api, contacts, orgs, events };
}
