import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { Assistant } from '../../assistant/types';
import { contactsCsv, DuplicateError, ORG_TYPES, type ContactInput, type ContactRecord, type ContactsApi, type OrgRecord } from '../../lib/contactsApi';
import {
  activityFor, dismissSuggestion, isStale, loadDismissedSuggestions, loadStaleRule, saveStaleRule, suggestContacts, type StaleRule, type Suggestion
} from '../../lib/relationships';
import { ago } from '../../lib/analytics';
import { useSample } from '../analytics/useStats';
import { errorText } from '../Toast';
import { ContactForm, emptyContact } from './ContactForm';
import { ContactDetail, type DetailContext } from './ContactDetail';
import { OrgDetail, OrgForm, emptyOrg } from './OrgDetail';

interface Props {
  api: ContactsApi | null;
  provider: MailProvider;
  assistant: Assistant;
  orgDomain: string;
  /** The user's own addresses (send-as identities). */
  myEmails: string[];
  onOpenThread: (threadId: string) => void;
  onDraftReply: (threadId: string) => void;
  onWrite: (email: string, name: string) => void;
}

type Tab = 'people' | 'orgs' | 'suggestions' | 'duplicates' | 'settings';
type Screen = { kind: 'list' } | { kind: 'contact'; id: number } | { kind: 'org'; id: number } | { kind: 'new-contact'; prefill?: ContactInput; from?: Suggestion } | { kind: 'new-org' };

const HISTORY_DAYS = 90;

export function ContactsPage(props: Props) {
  if (!props.api) {
    return (
      <section className="placeholder">
        <h1>Contacts & Relationships</h1>
        <span className="muted">Contacts are kept by the Axal VC Mail backend, which this session isn’t connected to.</span>
      </section>
    );
  }
  return <Connected {...props} api={props.api} />;
}

function Connected({ api, provider, assistant, orgDomain, myEmails, onOpenThread, onDraftReply, onWrite }: Props & { api: ContactsApi }) {
  const [tab, setTab] = useState<Tab>('people');
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);
  const [archivedEmails, setArchivedEmails] = useState<string[]>([]);
  const [orgs, setOrgs] = useState<OrgRecord[]>([]);
  const [members, setMembers] = useState<{ email: string; name: string }[]>([]);
  const [err, setErr] = useState('');
  const [rule, setRule] = useState<StaleRule>(loadStaleRule);
  const [tick, setTick] = useState(0);
  const { sample, error: sampleError } = useSample(provider, HISTORY_DAYS);
  const conversations = sample?.conversations || null;

  const reload = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let live = true;
    Promise.all([api.list(), api.list({ archived: true }), api.orgs(), api.members().catch(() => [])])
      .then(([c, a, o, m]) => { if (!live) return; setContacts(c); setArchivedEmails(a.flatMap(x => x.emails)); setOrgs(o); setMembers(m); setErr(''); })
      .catch(e => live && setErr(errorText(e)));
    return () => { live = false; };
  }, [api, tick]);

  const ctx: DetailContext = {
    api, provider, assistant, orgs, members, sample: conversations, rule, myEmails, onOpenThread, onDraftReply, onWrite,
    onOpenContact: id => setScreen({ kind: 'contact', id }), onOpenOrg: id => setScreen({ kind: 'org', id }), onChanged: reload
  };
  const back = () => { setScreen({ kind: 'list' }); reload(); };

  let body: React.ReactNode;
  if (screen.kind === 'contact') body = <ContactDetail key={screen.id} id={screen.id} ctx={ctx} onBack={() => { setTab('people'); back(); }} />;
  else if (screen.kind === 'org') body = <OrgDetail key={screen.id} id={screen.id} ctx={ctx} onBack={() => { setTab('orgs'); back(); }} />;
  else if (screen.kind === 'new-contact') body = <NewContact api={api} orgs={orgs} members={members} prefill={screen.prefill} from={screen.from}
    onOpenThread={onOpenThread} onDone={c => { if (screen.from) dismissSuggestion(screen.from.email); reload(); setScreen(c ? { kind: 'contact', id: c.id } : { kind: 'list' }); }}
    onOpenExisting={id => setScreen({ kind: 'contact', id })} />;
  else if (screen.kind === 'new-org') body = <OrgForm initial={emptyOrg()} members={members} canShare saveLabel="Create organization"
    onCancel={() => setScreen({ kind: 'list' })} onOpenExisting={id => setScreen({ kind: 'org', id })}
    onSave={async o => { const r = await api.createOrg(o); reload(); setScreen({ kind: 'org', id: r.id }); }} />;
  else {
    body = (
      <>
        <div className="row-wrap" role="tablist" aria-label="Contacts sections">
          {([['people', 'People'], ['orgs', 'Organizations'], ['suggestions', 'Suggestions'], ['duplicates', 'Duplicates'], ['settings', 'Indicators']] as [Tab, string][]).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={'btn sm' + (tab === t ? ' primary' : ' ghost')} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
        {sampleError && <div className="notice warn">Couldn’t read your email history: {sampleError}. Records still work; indicators are unavailable.</div>}
        {tab === 'people' && <People api={api} contacts={contacts} members={members} sample={conversations} rule={rule}
          onOpen={id => setScreen({ kind: 'contact', id })} onNew={() => setScreen({ kind: 'new-contact' })} />}
        {tab === 'orgs' && <Orgs orgs={orgs} contacts={contacts || []} sample={conversations} onOpen={id => setScreen({ kind: 'org', id })} onNew={() => setScreen({ kind: 'new-org' })} />}
        {tab === 'suggestions' && <Suggestions api={api} sample={conversations} contacts={contacts} archivedEmails={archivedEmails} orgs={orgs} orgDomain={orgDomain}
          onOpenThread={onOpenThread} onReview={(prefill, from) => setScreen({ kind: 'new-contact', prefill, from })} onChanged={reload} />}
        {tab === 'duplicates' && <Duplicates api={api} tick={tick} onOpen={id => setScreen({ kind: 'contact', id })} onChanged={reload} />}
        {tab === 'settings' && <StaleSettings rule={rule} onChange={r => { setRule(r); saveStaleRule(r); }} />}
      </>
    );
  }

  return (
    <section className="admin" aria-label="Contacts & Relationships">
      <div className="page-inner" style={{ gap: 14 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>Contacts & Relationships</h1>
          <span className="muted">People and organizations the team keeps, linked to your email. History is read from your mailbox when you look; it isn’t copied anywhere.</span>
        </div>
        {err && <div className="notice warn" role="alert">{err} <button className="link-btn" onClick={reload}>Try again</button></div>}
        {body}
      </div>
    </section>
  );
}

// ---------- people ----------

function People({ api, contacts, members, sample, rule, onOpen, onNew }: {
  api: ContactsApi; contacts: ContactRecord[] | null; members: { email: string; name: string }[]; sample: DetailContext['sample']; rule: StaleRule;
  onOpen: (id: number) => void; onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [owner, setOwner] = useState('');
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<ContactRecord[] | null>(null);
  const [now] = useState(() => Date.now());

  const filtered = !!(q.trim() || tag || owner || archived);
  useEffect(() => {
    if (!filtered) { setList(null); return; }
    let live = true;
    const t = setTimeout(() => api.list({ q: q.trim(), tag, owner, archived }).then(r => live && setList(r)).catch(() => live && setList([])), 250);
    return () => { live = false; clearTimeout(t); };
  }, [api, q, tag, owner, archived, filtered]);

  const shown = filtered ? list : contacts;
  const tags = useMemo(() => [...new Set((contacts || []).flatMap(c => c.tags))].sort(), [contacts]);
  const stats = useMemo(() => new Map((shown || []).map(c => [c.id, sample ? activityFor(c.emails, sample, now) : null])), [shown, sample, now]);

  const exportCsv = () => {
    const blob = new Blob([contactsCsv(shown || [])], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'contacts.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <input className="input" type="search" aria-label="Search contacts" placeholder="Search name, email, title, organization" value={q} onChange={e => setQ(e.target.value)} style={{ flex: '1 1 240px' }} />
        <select className="input" aria-label="Tag" value={tag} onChange={e => setTag(e.target.value)}><option value="">All tags</option>{tags.map(t => <option key={t}>{t}</option>)}</select>
        <select className="input" aria-label="Owner" value={owner} onChange={e => setOwner(e.target.value)}><option value="">Any owner</option>{members.map(m => <option key={m.email} value={m.email}>{m.name || m.email}</option>)}</select>
        <label className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />Archived</label>
        <button className="btn sm" onClick={exportCsv} disabled={!shown?.length} title="Exports what is listed, without notes">Export CSV</button>
        <button className="btn primary sm" onClick={onNew}>New contact</button>
      </div>
      {!shown ? <div className="card panel an-loading"><div className="spinner" /> Loading…</div> : !shown.length ? (
        <div className="card panel"><span className="faint">{filtered ? 'No contacts match.' : 'No contacts yet. Add one, or review the suggestions from your email.'}</span></div>
      ) : (
        <div className="card table table-scroll" aria-label="Contacts">
          <div className="trow contacts-list head"><span>NAME</span><span>ORGANIZATION</span><span>LAST EMAIL</span><span>STATUS</span></div>
          {shown.map(c => {
            const a = stats.get(c.id);
            return (
              <button key={c.id} className="trow contacts-list clickable" onClick={() => onOpen(c.id)}>
                <span className="an-row-main"><b>{c.name}</b><span>{c.emails[0] || c.title}</span></span>
                <span className="muted">{c.organization?.name || ''}</span>
                <span className="muted">{a?.lastInteraction ? ago(a.lastInteraction, now) : a ? '—' : '…'}</span>
                <span className="row-wrap">
                  {c.visibility === 'private' && <span className="pill warn">Private</span>}
                  {!!a?.unanswered.length && <span className="pill warn">Waiting on you</span>}
                  {!!a?.followUpsDue.length && <span className="pill">Follow-up due</span>}
                  {a && isStale(a, rule, now) && <span className="pill">Stale</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- organizations ----------

function Orgs({ orgs, contacts, sample, onOpen, onNew }: { orgs: OrgRecord[]; contacts: ContactRecord[]; sample: DetailContext['sample']; onOpen: (id: number) => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [now] = useState(() => Date.now());
  const shown = orgs.filter(o => (!type || o.type === type) && (!q.trim() || (o.name + ' ' + o.domain).toLowerCase().includes(q.trim().toLowerCase())));
  const last = (o: OrgRecord) => {
    if (!sample) return null;
    const emails = contacts.filter(c => c.organization?.id === o.id).flatMap(c => c.emails);
    if (o.domain) for (const c of sample) for (const m of c.messages) for (const e of [m.from, ...m.to]) if (e.endsWith('@' + o.domain)) emails.push(e);
    return activityFor(emails, sample, now).lastInteraction;
  };
  return (
    <>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <input className="input" type="search" aria-label="Search organizations" placeholder="Search name or domain" value={q} onChange={e => setQ(e.target.value)} style={{ flex: '1 1 240px' }} />
        <select className="input" aria-label="Type" value={type} onChange={e => setType(e.target.value)}><option value="">All types</option>{ORG_TYPES.map(t => <option key={t}>{t}</option>)}</select>
        <button className="btn primary sm" onClick={onNew}>New organization</button>
      </div>
      {!shown.length ? <div className="card panel"><span className="faint">{orgs.length ? 'No organizations match.' : 'No organizations yet.'}</span></div> : (
        <div className="card table table-scroll" aria-label="Organizations">
          <div className="trow contacts-list head"><span>NAME</span><span>TYPE</span><span>LAST EMAIL</span><span>PEOPLE</span></div>
          {shown.map(o => {
            const l = last(o);
            return (
              <button key={o.id} className="trow contacts-list clickable" onClick={() => onOpen(o.id)}>
                <span className="an-row-main"><b>{o.name}</b><span>{o.domain}</span></span>
                <span className="muted">{o.type}</span>
                <span className="muted">{l ? ago(l, now) : sample ? '—' : '…'}</span>
                <span className="muted">{o.contactCount}{o.visibility === 'private' && <span className="pill warn" style={{ marginLeft: 6 }}>Private</span>}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- new contact (manual or from a suggestion) ----------

function NewContact({ api, orgs, members, prefill, from, onOpenThread, onDone, onOpenExisting }: {
  api: ContactsApi; orgs: OrgRecord[]; members: { email: string; name: string }[]; prefill?: ContactInput; from?: Suggestion;
  onOpenThread: (id: string) => void; onDone: (c: ContactRecord | null) => void; onOpenExisting: (id: number) => void;
}) {
  const [existing, setExisting] = useState<number | null>(null);
  return (
    <>
      <ContactForm initial={prefill || emptyContact()} orgs={orgs} members={members} canShare saveLabel="Create contact"
        source={from && (
          <div className="notice" style={{ background: 'var(--surface-2)' }}>
            Suggested from <button type="button" className="link-btn" onClick={() => onOpenThread(from.source.id)}>{from.source.subject || '(no subject)'}</button>:
            {' '}{from.received} message{from.received === 1 ? '' : 's'} from them, {from.sent} from you. The name{from.domain ? ' and organization' : ''} below come from the email headers; check them.
          </div>
        )}
        onCancel={() => onDone(null)}
        onSave={async c => {
          setExisting(null);
          try {
            onDone(await api.create(c));
          } catch (e) {
            if (e instanceof DuplicateError && e.existingId) setExisting(e.existingId);
            throw e;
          }
        }}
      />
      {existing && <div><button className="btn sm" onClick={() => onOpenExisting(existing)}>Open the existing contact</button></div>}
    </>
  );
}

// ---------- suggestions ----------

function Suggestions({ api, sample, contacts, archivedEmails, orgs, orgDomain, onOpenThread, onReview, onChanged }: {
  api: ContactsApi; sample: DetailContext['sample']; contacts: ContactRecord[] | null; archivedEmails: string[]; orgs: OrgRecord[]; orgDomain: string;
  onOpenThread: (id: string) => void; onReview: (prefill: ContactInput, from: Suggestion) => void; onChanged: () => void;
}) {
  const [dismissed, setDismissed] = useState(loadDismissedSuggestions);
  const [err, setErr] = useState('');
  const list = useMemo(() => {
    if (!sample || !contacts) return null;
    const known = new Set([...contacts.flatMap(c => c.emails), ...archivedEmails]);
    return suggestContacts(sample, known, orgDomain, dismissed);
  }, [sample, contacts, archivedEmails, orgDomain, dismissed]);

  if (!list) return <div className="card panel an-loading"><div className="spinner" /> Reading your email history…</div>;

  const review = (s: Suggestion) => {
    const org = s.domain ? orgs.find(o => o.domain === s.domain) : undefined;
    onReview({ ...emptyContact(), name: s.name || s.email.split('@')[0], emails: [s.email], organizationId: org?.id ?? null }, s);
  };
  const addTo = async (s: Suggestion, contactId: number) => {
    const c = contacts!.find(x => x.id === contactId)!;
    if (!window.confirm('Add ' + s.email + ' to ' + c.name + '?')) return;
    try { await api.update(c.id, { emails: [...c.emails, s.email] }); onChanged(); } catch (e) { setErr(errorText(e)); }
  };

  return (
    <div className="card panel" aria-label="Suggested contacts">
      <span className="muted" style={{ fontSize: 12.5 }}>
        People you have exchanged email with in the last {HISTORY_DAYS} days (they wrote and you wrote back), outside {orgDomain || 'the firm'}, with no record yet.
        Nothing is created until you review it. No outside lookup is made.
      </span>
      {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
      {!list.length ? <span className="faint" style={{ fontSize: 12.5 }}>No suggestions right now.</span> : (
        <div className="an-list">
          {list.map(s => {
            const org = s.domain ? orgs.find(o => o.domain === s.domain) : undefined;
            return (
              <div key={s.email} className="an-row as-div" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div className="an-row-main" style={{ flex: '1 1 260px', gap: 3 }}>
                  <b>{s.name || s.email}</b>
                  <span>{s.email}{s.domain ? ' · ' + (org ? org.name : s.domain) : ''}</span>
                  <span>From <button className="link-btn" onClick={() => onOpenThread(s.source.id)}>{s.source.subject || '(no subject)'}</button> · {s.received} from them, {s.sent} from you</span>
                </div>
                <span className="row-wrap" style={{ marginLeft: 'auto' }}>
                  <button className="btn sm" onClick={() => review(s)}>Review and create</button>
                  {!!contacts?.length && (
                    <select className="input" aria-label={'Add ' + s.email + ' to an existing contact'} value="" onChange={e => e.target.value && addTo(s, Number(e.target.value))} style={{ height: 30, maxWidth: 190 }}>
                      <option value="">Add to existing…</option>
                      {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  <button className="btn ghost sm" onClick={() => { dismissSuggestion(s.email); setDismissed(loadDismissedSuggestions()); }}>Not a contact</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- duplicates ----------

function Duplicates({ api, tick, onOpen, onChanged }: { api: ContactsApi; tick: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const [groups, setGroups] = useState<ContactRecord[][] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.duplicates().then(setGroups).catch(e => setErr(errorText(e))); }, [api, tick]);
  if (err) return <div className="card panel"><span className="tone-danger">{err}</span></div>;
  if (!groups) return <div className="card panel an-loading"><div className="spinner" /> Looking for duplicates…</div>;
  const merge = async (keep: ContactRecord, others: ContactRecord[]) => {
    if (!window.confirm('Keep "' + keep.name + '" and merge ' + others.length + ' other record' + (others.length > 1 ? 's' : '') + ' into it?')) return;
    try { for (const o of others) await api.merge(keep.id, o.id); onChanged(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <div className="card panel" aria-label="Duplicate contacts">
      <span className="muted" style={{ fontSize: 12.5 }}>Records with the same name. Merge only when they are the same person; addresses, tags, notes and recorded events move to the record you keep.</span>
      {!groups.length ? <span className="faint" style={{ fontSize: 12.5 }}>No duplicates found.</span> : groups.map(g => (
        <div key={g.map(c => c.id).join('-')} className="an-list">
          {g.map(c => (
            <div key={c.id} className="an-row as-div">
              <button className="an-row-main link-like" onClick={() => onOpen(c.id)}><b>{c.name}</b><span>{c.emails.join(', ') || 'no address'}{c.organization ? ' · ' + c.organization.name : ''}{c.visibility === 'private' ? ' · private' : ''}</span></button>
              <button className="btn sm" onClick={() => merge(c, g.filter(x => x.id !== c.id))}>Keep this one</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------- stale rule ----------

function StaleSettings({ rule, onChange }: { rule: StaleRule; onChange: (r: StaleRule) => void }) {
  return (
    <div className="card panel" aria-label="Indicator settings">
      <b style={{ fontSize: 14 }}>How indicators work</b>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        <li><b>Last interaction</b>: the latest email to or from any of the person’s addresses in your mailbox (last {HISTORY_DAYS} days).</li>
        <li><b>Waiting on you</b>: they wrote last in a conversation and nobody has answered.</li>
        <li><b>Follow-up due</b>: you wrote last, more than 3 days ago.</li>
        <li><b>Stale</b>: no email either way for the number of days below. There is no relationship score.</li>
      </ul>
      <label className="muted" style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })} /> Show the stale indicator
      </label>
      <label className="muted" style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        Stale after
        <input className="input" type="number" min={7} max={730} value={rule.days} disabled={!rule.enabled} style={{ width: 90 }}
          onChange={e => onChange({ ...rule, days: Math.max(7, Math.min(730, Number(e.target.value) || 60)) })} /> days
      </label>
      <span className="faint" style={{ fontSize: 11.5 }}>Saved on this device.</span>
    </div>
  );
}
