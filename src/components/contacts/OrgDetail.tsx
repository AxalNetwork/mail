import { useCallback, useEffect, useMemo, useState } from 'react';
import { DuplicateError, ORG_TYPES, type ContactRecord, type OrgInput, type OrgRecord } from '../../lib/contactsApi';
import { activityFor } from '../../lib/relationships';
import { errorText } from '../Toast';
import { Indicators, Timeline, type DetailContext } from './ContactDetail';

export const emptyOrg = (): OrgInput => ({ name: '', domain: '', website: '', type: 'Other', tags: [], notes: '', owner: '', visibility: 'team' });

export function OrgForm({ initial, members, canShare, saveLabel, onSave, onCancel, onOpenExisting }: {
  initial: OrgInput; members: { email: string; name: string }[]; canShare: boolean; saveLabel: string;
  onSave: (o: OrgInput) => Promise<void>; onCancel: () => void; onOpenExisting: (id: number) => void;
}) {
  const [o, setO] = useState(initial);
  const [tagText, setTagText] = useState(initial.tags.join(', '));
  const [err, setErr] = useState<{ text: string; existingId?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof OrgInput>(k: K, v: OrgInput[K]) => setO(x => ({ ...x, [k]: v }));
  return (
    <form className="card panel" aria-label="Organization details" onSubmit={async e => {
      e.preventDefault();
      setBusy(true); setErr(null);
      try {
        await onSave({ ...o, name: o.name.trim(), tags: tagText.split(',').map(t => t.trim()).filter(Boolean) });
      } catch (x) {
        setErr({ text: errorText(x), existingId: x instanceof DuplicateError ? x.existingId : undefined });
      } finally { setBusy(false); }
    }}>
      <div className="profile-form">
        <label>Name<input className="input" required maxLength={200} value={o.name} onChange={e => set('name', e.target.value)} /></label>
        <label>Email domain<input className="input" value={o.domain} onChange={e => set('domain', e.target.value)} placeholder="atlas.example" /></label>
        <label>Website<input className="input" value={o.website} onChange={e => set('website', e.target.value)} /></label>
        <label>Type<select className="input" value={o.type} onChange={e => set('type', e.target.value)}>{ORG_TYPES.map(t => <option key={t}>{t}</option>)}</select></label>
        <label>Tags (comma-separated)<input className="input" value={tagText} onChange={e => setTagText(e.target.value)} /></label>
        <label>Relationship owner<select className="input" value={o.owner} disabled={!canShare} onChange={e => set('owner', e.target.value)}>
          {!o.owner && <option value="">Me</option>}
          {(members.some(m => m.email === o.owner) || !o.owner ? members : [...members, { email: o.owner, name: o.owner }]).map(m => <option key={m.email} value={m.email}>{m.name || m.email}</option>)}
        </select></label>
        <label>Who can see it<select className="input" value={o.visibility} disabled={!canShare} onChange={e => set('visibility', e.target.value as OrgInput['visibility'])}>
          <option value="team">The whole team</option><option value="private">Only me and the owner</option>
        </select></label>
      </div>
      <label className="seq-field">Notes<textarea className="textarea" rows={3} maxLength={10000} value={o.notes} onChange={e => set('notes', e.target.value)} /></label>
      {err && (
        <span className="tone-danger" role="alert" style={{ fontSize: 12.5 }}>
          {err.text} {err.existingId && <button type="button" className="link-btn" onClick={() => onOpenExisting(err.existingId!)}>Open it</button>}
        </span>
      )}
      <div className="row-wrap">
        <button className="btn primary sm" type="submit" disabled={busy || !o.name.trim()}>{busy ? 'Saving…' : saveLabel}</button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function OrgDetail({ id, ctx, onBack }: { id: number; ctx: DetailContext; onBack: () => void }) {
  const [data, setData] = useState<{ organization: OrgRecord; contacts: ContactRecord[] } | null>(null);
  const [all, setAll] = useState<ContactRecord[]>([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState('');
  const [now] = useState(() => Date.now());
  const { api } = ctx;

  const load = useCallback(() => {
    api.org(id).then(d => { setData(d); setErr(''); }).catch(e => setErr(errorText(e)));
  }, [api, id]);
  useEffect(load, [load]);
  useEffect(() => { api.list().then(setAll).catch(() => setAll([])); }, [api, data]);

  // The organization's conversations: its contacts' addresses, plus anyone writing from its domain.
  const activity = useMemo(() => {
    if (!data || !ctx.sample) return null;
    const emails = new Set(data.contacts.flatMap(c => c.emails));
    const dom = data.organization.domain;
    if (dom) for (const c of ctx.sample) for (const m of c.messages) for (const e of [m.from, ...m.to]) if (e.endsWith('@' + dom)) emails.add(e);
    return activityFor([...emails], ctx.sample, now);
  }, [data, ctx.sample, now]);

  if (err) return <div className="card panel"><span className="tone-danger">{err}</span><div><button className="btn sm" onClick={onBack}>Back</button></div></div>;
  if (!data) return <div className="card panel an-loading"><div className="spinner" /> Loading…</div>;
  const o = data.organization;
  const done = () => { load(); ctx.onChanged(); };

  if (editing) {
    return (
      <OrgForm initial={{ name: o.name, domain: o.domain, website: o.website, type: o.type, tags: o.tags, notes: o.notes, owner: o.owner, visibility: o.visibility }}
        members={ctx.members} canShare={o.canShare} saveLabel="Save changes" onCancel={() => setEditing(false)} onOpenExisting={ctx.onOpenOrg}
        onSave={async input => {
          const patch: Partial<OrgInput> = { ...input };
          if (!o.canShare) { delete patch.owner; delete patch.visibility; }
          await api.updateOrg(o.id, patch);
          setEditing(false);
          done();
        }} />
    );
  }

  const candidates = all.filter(c => c.organization?.id !== o.id);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div><button className="btn ghost sm" onClick={onBack}>← Organizations</button></div>
      <div className="card panel" aria-label="Organization">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{o.name}</h2>
          <span className="pill accent">{o.type}</span>
          {o.visibility === 'private' && <span className="pill warn">Private</span>}
          {o.archived && <span className="pill">Archived</span>}
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          {[o.domain && '@' + o.domain].filter(Boolean).join(' · ')}
          {o.website && <> · <a href={o.website} target="_blank" rel="noopener noreferrer">{o.website}</a></>}
        </span>
        {!!o.tags.length && <span className="row-wrap">{o.tags.map(t => <span key={t} className="pill accent">{t}</span>)}</span>}
        <span className="faint" style={{ fontSize: 12 }}>Relationship owner: {ctx.members.find(m => m.email === o.owner)?.name || o.owner}</span>
        <div className="row-wrap">
          {!o.archived && <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn ghost sm" onClick={async () => { try { await api.updateOrg(o.id, { archived: !o.archived }); done(); } catch (e) { setErr(errorText(e)); } }}>{o.archived ? 'Restore' : 'Archive'}</button>
        </div>
        {o.notes && <div className="notice" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)' }}>{o.notes}</div>}
      </div>

      <div className="card panel" aria-label="People">
        <b style={{ fontSize: 14 }}>People ({data.contacts.length})</b>
        {data.contacts.length
          ? <div className="an-list">{data.contacts.map(c => (
            <div key={c.id} className="an-row as-div">
              <button className="an-row-main link-like" onClick={() => ctx.onOpenContact(c.id)}><b>{c.name}</b><span>{[c.title, ...c.emails].filter(Boolean).join(' · ')}</span></button>
              <button className="btn ghost sm" onClick={async () => { try { await api.update(c.id, { organizationId: null }); done(); } catch (e) { setErr(errorText(e)); } }}>Remove</button>
            </div>
          ))}</div>
          : <span className="faint" style={{ fontSize: 12.5 }}>No contacts linked yet.</span>}
        {!o.archived && !!candidates.length && (
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <select className="input" aria-label="Add a contact" value={adding} onChange={e => setAdding(e.target.value)}>
              <option value="">Add a contact…</option>
              {candidates.map(c => <option key={c.id} value={c.id}>{c.name}{c.organization ? ' (now ' + c.organization.name + ')' : ''}</option>)}
            </select>
            <button className="btn sm" disabled={!adding} onClick={async () => { try { await api.update(Number(adding), { organizationId: o.id }); setAdding(''); done(); } catch (e) { setErr(errorText(e)); } }}>Add</button>
          </div>
        )}
      </div>

      <Indicators activity={activity} rule={ctx.rule} now={now} />
      <Timeline activity={activity} events={[]} now={now} members={ctx.members} conversations={[]} onOpen={ctx.onOpenThread} />
    </div>
  );
}
