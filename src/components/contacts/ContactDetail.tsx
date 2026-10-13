import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { Assistant } from '../../assistant/types';
import type { ConversationStat } from '../../types';
import { DuplicateError, type ContactInput, type ContactRecord, type ContactsApi, type OrgRecord, type RelationshipEvent } from '../../lib/contactsApi';
import { activityFor, isStale, type Activity, type ConversationLink, type StaleRule } from '../../lib/relationships';
import { ago } from '../../lib/analytics';
import { errorText } from '../Toast';
import { ContactForm } from './ContactForm';
import { RelationshipAi } from './RelationshipAi';

export interface DetailContext {
  api: ContactsApi;
  provider: MailProvider;
  assistant: Assistant;
  orgs: OrgRecord[];
  members: { email: string; name: string }[];
  /** Conversation metadata for the last 90 days, or null while it loads. */
  sample: ConversationStat[] | null;
  rule: StaleRule;
  myEmails: string[];
  onOpenThread: (threadId: string) => void;
  onDraftReply: (threadId: string) => void;
  onWrite: (email: string, name: string) => void;
  onOpenContact: (id: number) => void;
  onOpenOrg: (id: number) => void;
  onChanged: () => void;
}

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const memberName = (members: { email: string; name: string }[], e: string) => members.find(m => m.email === e)?.name || e;

export function ContactDetail({ id, ctx, onBack }: { id: number; ctx: DetailContext; onBack: () => void }) {
  const [data, setData] = useState<{ contact: ContactRecord; events: RelationshipEvent[]; duplicates: ContactRecord[] } | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const { api } = ctx;

  const load = useCallback(() => {
    api.get(id).then(d => { setData(d); setErr(''); }).catch(e => setErr(errorText(e)));
  }, [api, id]);
  useEffect(load, [load]);

  const [now] = useState(() => Date.now());
  const activity = useMemo(() => (data && ctx.sample ? activityFor(data.contact.emails, ctx.sample, now) : null), [data, ctx.sample, now]);

  if (err) return <div className="card panel"><span className="tone-danger">{err}</span><div><button className="btn sm" onClick={onBack}>Back to contacts</button></div></div>;
  if (!data) return <div className="card panel an-loading"><div className="spinner" /> Loading…</div>;
  const c = data.contact;

  const changed = (next?: ContactRecord) => {
    if (next) setData(d => d && { ...d, contact: next });
    load();
    ctx.onChanged();
  };

  if (editing) {
    return (
      <ContactForm
        initial={{ name: c.name, emails: c.emails, title: c.title, organizationId: c.organization?.id ?? null, website: c.website, linkedin: c.linkedin, tags: c.tags, notes: c.notes, owner: c.owner, visibility: c.visibility }}
        orgs={ctx.orgs} members={ctx.members} canShare={c.canShare} saveLabel="Save changes"
        onCancel={() => setEditing(false)}
        onSave={async input => {
          // Owner and visibility go only to the people allowed to change them.
          const patch: Partial<ContactInput> = { ...input };
          if (!c.canShare) { delete patch.owner; delete patch.visibility; }
          const next = await api.update(c.id, patch).catch(e => {
            if (e instanceof DuplicateError && e.existingId) throw new Error(e.message + ' Merge the two records instead.');
            throw e;
          });
          setEditing(false);
          changed(next);
        }}
      />
    );
  }

  const latest = activity?.conversations[0];
  const merge = async (other: ContactRecord) => {
    if (!window.confirm('Merge "' + other.name + '" (' + (other.emails.join(', ') || 'no address') + ') into "' + c.name + '"? Its addresses, tags, notes and recorded events move here, and the other record is archived.')) return;
    try { changed(await api.merge(c.id, other.id)); } catch (e) { setErr(errorText(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div><button className="btn ghost sm" onClick={onBack}>← Contacts</button></div>

      <div className="card panel" aria-label="Contact">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{c.name}</h2>
          {c.visibility === 'private' && <span className="pill warn">Private</span>}
          {c.archived && <span className="pill">{c.mergedInto ? 'Merged' : 'Archived'}</span>}
          {activity && isStale(activity, ctx.rule, now) && <span className="pill warn" title={'No email either way for more than ' + ctx.rule.days + ' days'}>Stale</span>}
        </div>
        <span className="muted">
          {[c.title, c.organization && 'at '].filter(Boolean).join(' ')}
          {c.organization && <button className="link-like" style={{ padding: 0 }} onClick={() => ctx.onOpenOrg(c.organization!.id)}>{c.organization.name}</button>}
        </span>
        <span style={{ fontSize: 13 }}>{c.emails.join(' · ') || <span className="faint">No email address</span>}</span>
        {(c.website || c.linkedin) && (
          <span className="row-wrap" style={{ fontSize: 12.5 }}>
            {c.website && <a href={c.website} target="_blank" rel="noopener noreferrer">{c.website}</a>}
            {c.linkedin && <a href={c.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a>}
          </span>
        )}
        {!!c.tags.length && <span className="row-wrap">{c.tags.map(t => <span key={t} className="pill accent">{t}</span>)}</span>}
        <span className="faint" style={{ fontSize: 12 }}>Relationship owner: {memberName(ctx.members, c.owner)} · added by {memberName(ctx.members, c.createdBy)} on {date(c.createdAt)}</span>
        {c.mergedInto
          ? <div><button className="btn sm" onClick={() => ctx.onOpenContact(c.mergedInto!)}>Open the merged record</button></div>
          : (
            <div className="row-wrap">
              {!c.archived && <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>}
              {!c.archived && (latest
                ? <button className="btn sm" onClick={() => ctx.onDraftReply(latest.id)}>Draft follow-up</button>
                : c.emails[0] && <button className="btn sm" onClick={() => ctx.onWrite(c.emails[0], c.name)}>Write</button>)}
              <button className="btn ghost sm" onClick={async () => { try { changed(await api.archive(c.id, !c.archived)); } catch (e) { setErr(errorText(e)); } }}>{c.archived ? 'Restore' : 'Archive'}</button>
            </div>
          )}
        {c.notes && <div className="notice" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)' }}><span className="mono-label">NOTES · {c.visibility === 'team' ? 'TEAM' : 'PRIVATE'}</span><br />{c.notes}</div>}
      </div>

      {!!data.duplicates.length && (
        <div className="card panel" aria-label="Possible duplicates">
          <b style={{ fontSize: 14 }}>Possible duplicate{data.duplicates.length > 1 ? 's' : ''}</b>
          <span className="muted" style={{ fontSize: 12.5 }}>Same name. Merge only if it is the same person.</span>
          {data.duplicates.map(d => (
            <div key={d.id} className="an-row as-div">
              <button className="an-row-main link-like" onClick={() => ctx.onOpenContact(d.id)}><b>{d.name}</b><span>{d.emails.join(', ') || 'no address'}{d.organization ? ' · ' + d.organization.name : ''}</span></button>
              <button className="btn sm" onClick={() => merge(d)}>Merge into this</button>
            </div>
          ))}
        </div>
      )}

      <Indicators activity={activity} rule={ctx.rule} now={now} introductions={data.events.filter(e => e.kind === 'introduction').length} />

      <div className="card panel">
        <b style={{ fontSize: 14 }}>AI summary</b>
        <RelationshipAi assistant={ctx.assistant} provider={ctx.provider} contactId={c.id} conversations={activity?.conversations || []} myEmails={ctx.myEmails} onOpen={ctx.onOpenThread} />
      </div>

      <Timeline activity={activity} events={data.events} now={now} members={ctx.members} onOpen={ctx.onOpenThread}
        onRemove={async e => { try { await api.removeEvent(c.id, e.id); load(); } catch (x) { setErr(errorText(x)); } }}
        onAdd={c.archived ? undefined : async ev => { await api.addEvent(c.id, ev); load(); }} conversations={activity?.conversations || []} />
    </div>
  );
}

export function Indicators({ activity, rule, now, introductions }: { activity: Activity | null; rule: StaleRule; now: number; introductions?: number }) {
  if (!activity) return <div className="card panel an-loading"><div className="spinner" /> Reading your email history…</div>;
  const tiles: [string, string | number, string?][] = [
    ['Last interaction', activity.lastInteraction ? ago(activity.lastInteraction, now) : 'None in 90 days'],
    ['Last 30 days', activity.sent30 + ' sent · ' + activity.received30 + ' received'],
    ['Conversations, 90 days', activity.conversations90],
    ['Waiting on you', activity.unanswered.length, 'They wrote last and nobody answered'],
    ['Follow-ups due', activity.followUpsDue.length, 'You wrote last, more than 3 days ago']
  ];
  if (introductions !== undefined) tiles.push(['Recorded introductions', introductions]);
  return (
    <div className="card panel" aria-label="Relationship indicators">
      <b style={{ fontSize: 14 }}>Indicators</b>
      <div className="an-tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {tiles.map(([label, value, hint]) => <div key={label} className="an-tile card" title={hint}><span className="an-tile-label">{label}</span><b className="an-tile-value" style={{ fontSize: 16 }}>{value}</b></div>)}
      </div>
      <span className="faint" style={{ fontSize: 11.5 }}>
        From your mailbox’s last 90 days (who wrote to whom and when; bulk mail left out). No score: each figure is a plain count.
        {rule.enabled ? ' Stale means no email either way for ' + rule.days + ' days.' : ' The stale indicator is off.'}
      </span>
    </div>
  );
}

type NewEvent = { kind: RelationshipEvent['kind']; text: string; threadId?: string; occurredAt?: number };

export function Timeline({ activity, events, now, members, conversations, onOpen, onAdd, onRemove }: {
  activity: Activity | null; events: RelationshipEvent[]; now: number; members: { email: string; name: string }[]; conversations: ConversationLink[];
  onOpen: (id: string) => void; onAdd?: (e: NewEvent) => Promise<void>; onRemove?: (e: RelationshipEvent) => void;
}) {
  const unanswered = new Set(activity?.unanswered.map(u => u.id));
  const due = new Set(activity?.followUpsDue.map(u => u.id));
  type Row = { at: number; key: string; node: React.ReactNode };
  const rows: Row[] = [
    ...(activity?.conversations || []).map(l => ({
      at: l.last, key: 'c' + l.id,
      node: (
        <div className="an-row as-div">
          <button className="an-row-main link-like" onClick={() => onOpen(l.id)}>
            <b>{l.subject || '(no subject)'}</b>
            <span>Email · you {l.sent} · them {l.received} · {ago(l.last, now)}</span>
          </button>
          {unanswered.has(l.id) && <span className="pill warn">Waiting on you</span>}
          {due.has(l.id) && <span className="pill">Follow-up due</span>}
        </div>
      )
    })),
    ...events.map(e => ({
      at: e.occurredAt, key: 'e' + e.id,
      node: (
        <div className="an-row as-div">
          <div className="an-row-main">
            <b><span className="pill accent" style={{ marginRight: 6 }}>{e.kind}</span>{e.text}</b>
            <span>Recorded by {memberName(members, e.createdBy)} · {date(e.occurredAt)}</span>
          </div>
          <span className="row-wrap">
            {e.threadId && <button className="btn ghost sm" onClick={() => onOpen(e.threadId)}>Open email</button>}
            {e.mine && onRemove && <button className="btn ghost sm" onClick={() => onRemove(e)}>Remove</button>}
          </span>
        </div>
      )
    }))
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="card panel" aria-label="Relationship timeline">
      <b style={{ fontSize: 14 }}>Activity</b>
      {onAdd && <AddEvent conversations={conversations} onAdd={onAdd} />}
      {rows.length ? <div className="an-list">{rows.slice(0, 60).map(r => <div key={r.key}>{r.node}</div>)}</div>
        : <span className="faint" style={{ fontSize: 12.5 }}>No email with them in the last 90 days, and nothing recorded.</span>}
    </div>
  );
}

function AddEvent({ conversations, onAdd }: { conversations: ConversationLink[]; onAdd: (e: NewEvent) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<RelationshipEvent['kind']>('introduction');
  const [text, setText] = useState('');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [thread, setThread] = useState('');
  const [err, setErr] = useState('');
  if (!open) return <div><button className="btn sm" onClick={() => setOpen(true)}>Record an introduction or meeting</button></div>;
  return (
    <form className="row-wrap" style={{ alignItems: 'center' }} onSubmit={async e => {
      e.preventDefault();
      try {
        await onAdd({ kind, text: text.trim(), threadId: thread || undefined, occurredAt: new Date(day + 'T12:00:00').getTime() });
        setText(''); setOpen(false); setErr('');
      } catch (x) { setErr(errorText(x)); }
    }}>
      <select className="input" aria-label="Kind" value={kind} onChange={e => setKind(e.target.value as RelationshipEvent['kind'])}>
        <option value="introduction">Introduction</option><option value="meeting">Meeting</option><option value="note">Note</option>
      </select>
      <input className="input" aria-label="What happened" required maxLength={1000} style={{ flex: '1 1 220px' }} value={text} onChange={e => setText(e.target.value)}
        placeholder={kind === 'introduction' ? 'Introduced by Emma Rossi (Horizon)' : 'What happened'} />
      <input className="input" aria-label="Date" type="date" value={day} onChange={e => setDay(e.target.value)} />
      {!!conversations.length && (
        <select className="input" aria-label="Email" value={thread} onChange={e => setThread(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">No email linked</option>
          {conversations.slice(0, 20).map(c => <option key={c.id} value={c.id}>{c.subject}</option>)}
        </select>
      )}
      <button className="btn primary sm" type="submit" disabled={!text.trim()}>Save</button>
      <button className="btn ghost sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
    </form>
  );
}
